import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpStream, type AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent, ProviderInput, ProviderLaunch, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { DshAcpCompatibility, type ApprovalState } from "./compatibility.ts";
import { historyItemMethod } from "./history.ts";
import { validateDshInput } from "./semantics.ts";
import { autoAcceptControl } from "./provider-options.ts";
import { createSkillsOverlay } from "./skills-bridge.ts";
import { autoAcceptPersistence } from "../shared/auto-accept.ts";
import { AutoAcceptStore } from "./auto-accept-store.ts";

interface OpenContext {
  env: Readonly<Record<string, string>>;
  replay: boolean;
  approval: ApprovalState;
}

const AUTO_ACCEPT = "auto_accept";
type SessionConfigEvent = Extract<ProviderEvent, { type: "session.config" }>;

function autoAcceptValue(options: Readonly<Record<string, unknown>> | undefined): boolean | undefined {
  const value = options?.[AUTO_ACCEPT];
  return value === null ? false : typeof value === "boolean" ? value : undefined;
}

function withoutAutoAccept<T>(
  options: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (!options) return undefined;
  const { [AUTO_ACCEPT]: _ignored, ...rest } = options;
  return rest;
}

function withAutoAccept(event: SessionConfigEvent, value: boolean): SessionConfigEvent {
  return {
    ...event,
    config: {
      ...event.config,
      controls: [
        ...(event.config.controls ?? []).filter((control) => control.key !== AUTO_ACCEPT),
        autoAcceptControl,
      ],
      providerOptions: { ...event.config.providerOptions, [AUTO_ACCEPT]: value },
      settings: [
        ...(event.config.settings ?? []).filter((setting) => setting.id !== AUTO_ACCEPT),
        {
          type: "toggle", id: AUTO_ACCEPT, label: autoAcceptControl.label,
          description: autoAcceptControl.description, value,
        },
      ],
    },
  };
}

const wireMessage = z.object({ jsonrpc: z.literal("2.0") }).passthrough();

function parseMessage(line: string): AcpStreamMessage {
  const value = wireMessage.parse(JSON.parse(line));
  // Validate the wire envelope without constraining provider-specific ACP fields.
  if ("method" in value && typeof value.method === "string") {
    if ("id" in value) {
      return { jsonrpc: "2.0", id: z.union([z.string(), z.number(), z.null()]).parse(value.id),
        method: value.method, params: value.params };
    }
    return { jsonrpc: "2.0", method: value.method, params: value.params };
  }
  const id = z.union([z.string(), z.number(), z.null()]).parse(value.id);
  if ("result" in value) return { jsonrpc: "2.0", id, result: value.result };
  return { jsonrpc: "2.0", id, error: z.object({
    code: z.number(), message: z.string(), data: z.unknown().optional(),
  }).parse(value.error) };
}

async function connectDsh(launch: ProviderLaunch, context?: OpenContext): Promise<AcpStream> {
  const env = { ...launch.env, ...context?.env };
  const overlay = await createSkillsOverlay();
  const child = spawnProcess(launch.command, [...launch.args, "--patch", overlay.path], { env, stdio: "pipe" });
  const write = async (message: AcpStreamMessage) => {
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(message) + "\n", (error) => error ? reject(error) : resolve());
    });
  };
  const compatibility = new DshAcpCompatibility(env, context?.replay ?? false, undefined, write, context?.approval);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let failure: Error | undefined;
  let closing = false;
  let stopping: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => child.once("close", resolve));
  void exited.then(() => overlay.close()).catch((error: unknown) => {
    console.error("Failed to clean up DSH skills overlay", error);
  });
  child.on("error", (error) => { failure = error; lines.close(); });
  child.stdin.on("error", (error) => { failure = error; lines.close(); });
  const stop = () => stopping ??= (async () => {
    closing = true;
    child.stdin.end();
    if (await Promise.race([exited.then(() => true), delay(500).then(() => false)])) return;
    await terminateProcess(child, "SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(1000).then(() => false)])) return;
    await terminateProcess(child);
    if (!await Promise.race([exited.then(() => true), delay(1000).then(() => false)])) {
      throw new Error("DSH ACP process did not terminate");
    }
  })();
  return {
    writable: new WritableStream<AcpStreamMessage>({
      async write(message) {
        await write(compatibility.toAgent(message));
      },
      close: stop,
      abort: stop,
    }),
    readable: new ReadableStream<AcpStreamMessage>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            if (closing) { controller.close(); return; }
            throw failure ?? new Error(`DSH ACP process closed (${child.signalCode ?? child.exitCode ?? "EOF"})${stderr ? `: ${stderr}` : ""}`);
          }
          for (const message of await compatibility.fromAgent(parseMessage(next.value))) {
            controller.enqueue(message);
          }
        } catch (error) {
          controller.error(error);
          await stop();
        }
      },
      async cancel() {
        lines.close();
        await stop();
      },
    }),
  };
}

export function createDshProvider(): ProviderRegistration {
  return {
    id: "deepseek",
    label: "DeepSeek Harness",
    description: "Official DeepSeek Harness ACP profile with session resume and history",
    icon: "icon.svg",
    command: ["dsh", "--profile", "acp"],
    async connect(request) {
      const context = new AsyncLocalStorage<OpenContext | undefined>();
      const launch = request.launch ?? {
        command: "dsh", args: ["--profile", "acp"],
        env: Object.fromEntries(Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        )),
      };
      const provider = runAcpProvider({
        id: "deepseek",
        label: "DeepSeek Harness",
        connector: () => connectDsh(launch, context.getStore()),
        acpOptions: { waitForInitialCommands: true },
        transformers: [{
          notification(notification, context) {
            if (notification.method === "dsh/skills_warning") {
              const params = z.object({ message: z.string(), dismissed: z.boolean().optional() }).parse(notification.params);
              return { type: "notice", notice: {
                id: "dsh-skills-discovery", severity: "warning",
                title: "Skills discovery", description: params.message,
                dismissed: params.dismissed,
              } };
            }
            if (notification.method !== historyItemMethod) return null;
            const event = ProviderEventSchema.parse({
              type: "timeline.item", sessionId: context.sessionId, item: notification.params,
            });
            if (event.type !== "timeline.item") throw new Error("Invalid DSH history timeline event");
            return { type: "timeline", item: event.item };
          },
        }],
      });
      const connection = await provider.connect(request);
      const capabilities = connection.capabilities;
      const listeners = new Set<(event: ProviderEvent) => void>();
      const queries = new Map<string, Extract<ProviderInput, { type: "sessions" }>>();
      const approval: ApprovalState = { pending: undefined, bySession: new Map() };
      const autoByBoundary = new Map<string, boolean>();
      const boundaryToNative = new Map<string, string>();
      const lastConfig = new Map<string, SessionConfigEvent["config"]>();
      const commands = new Map<string, Set<string>>();
      const stores = new Map<string, AutoAcceptStore>();
      const writes = new Map<string, Promise<void>>();
      const pendingOptions = new Map<string, { sessionId: string; auto: boolean }>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      const commitAutoAccept = (sessionId: string, auto: boolean) => {
        const operation = (writes.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
          const native = boundaryToNative.get(sessionId);
          const store = stores.get(sessionId);
          if (!native || !store) throw new Error(`Unknown session: ${sessionId}`);
          await store.write(native, auto);
          autoByBoundary.set(sessionId, auto);
          approval.bySession.set(native, auto);
          const config = lastConfig.get(sessionId);
          if (config) emit(withAutoAccept({ type: "session.config", sessionId, config }, auto));
        });
        writes.set(sessionId, operation);
        return operation;
      };
      const unsubscribe = connection.onEvent((event) => {
        if (event.type === "timeline.item" && event.item.type === "tool_call" &&
            event.item.status === "failed" && event.item.error === null) {
          // The ACP shim permits null here, but the client timeline requires an error.
          event = { ...event, item: {
            ...event.item, error: "DSH reported a failed tool call without error details",
          } };
        } else if (event.type === "session.opened") {
          const native = (event.persistence?.data as { sessionId?: unknown } | undefined)?.sessionId;
          if (typeof native === "string") {
            boundaryToNative.set(event.sessionId, native);
            const auto = autoByBoundary.get(event.sessionId) ?? false;
            approval.bySession.set(native, auto);
          }
        } else if (event.type === "session.config") {
          lastConfig.set(event.sessionId, event.config);
          event = withAutoAccept(event, autoByBoundary.get(event.sessionId) ?? false);
        } else if (event.type === "session.commands") {
          commands.set(event.sessionId, new Set(event.commands.map((command) => command.name)));
        } else if (event.type === "sessions") {
          const query = queries.get(event.requestId);
          queries.delete(event.requestId);
          if (query) {
            const text = query.query?.toLowerCase();
            const sessions = text ? event.sessions.filter((session) =>
              [session.title, session.cwd, JSON.stringify(session.persistence.data)]
                .some((value) => value?.toLowerCase().includes(text)),
            ) : event.sessions;
            event = { ...event, sessions: query.limit ? sessions.slice(0, query.limit) : sessions };
          }
        } else if (event.type === "request.failed") {
          queries.delete(event.requestId);
          pendingOptions.delete(event.requestId);
        } else if (event.type === "request.completed") {
          const pending = pendingOptions.get(event.requestId);
          pendingOptions.delete(event.requestId);
          if (pending) {
            const requestId = event.requestId;
            void commitAutoAccept(pending.sessionId, pending.auto).then(() => emit(event), (error: unknown) =>
              emit({ type: "request.failed", requestId,
                error: { message: error instanceof Error ? error.message : String(error) } }));
            return;
          }
        } else if (event.type === "session.closed") {
          const native = boundaryToNative.get(event.sessionId);
          if (native) approval.bySession.delete(native);
          boundaryToNative.delete(event.sessionId);
          autoByBoundary.delete(event.sessionId);
          lastConfig.delete(event.sessionId);
          commands.delete(event.sessionId);
          stores.delete(event.sessionId);
          writes.delete(event.sessionId);
        }
        emit(event);
      });
      return {
        ...connection,
        capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        send(input) {
          validateDshInput(input);
          if (input.type === "session.prompt" && input.prompt.input.type === "command" &&
              !commands.get(input.sessionId)?.has(input.prompt.input.name)) {
            throw new Error(`Unknown DSH skill command: ${input.prompt.input.name}`);
          }
          if (input.type === "sessions") {
            queries.set(input.requestId, input);
            return context.run(undefined, async () => {
              try {
                await connection.send({ ...input, limit: undefined });
              } catch (error) {
                queries.delete(input.requestId);
                throw error;
              }
            });
          }
          if (input.type === "session.open") {
            const store = new AutoAcceptStore({ ...launch.env, ...input.config.env });
            stores.set(input.sessionId, store);
            const stored = autoAcceptPersistence.safeParse(input.persistence);
            return (async () => {
              const persisted = stored.success ? await store.read(stored.data.data.sessionId) : undefined;
              const auto = persisted ??
                autoAcceptValue(input.config.providerOptions) ??
                autoAcceptValue(input.config.settings) ?? false;
              approval.pending = auto;
              autoByBoundary.set(input.sessionId, auto);
              // Plugin-owned options must not be forwarded as native DSH config.
              const config = {
                ...input.config,
                settings: withoutAutoAccept(input.config.settings) ?? {},
                providerOptions: withoutAutoAccept(input.config.providerOptions),
              };
              return await context.run({
                env: input.config.env, replay: input.history === "replay", approval,
              }, () => connection.send({ ...input, config }));
            })();
          }
          if (input.type === "session.configure") {
            const changes = input.changes;
            const auto = autoAcceptValue(changes.providerOptions) ?? autoAcceptValue(changes.settings);
            const settings = withoutAutoAccept(changes.settings);
            const providerOptions = withoutAutoAccept(changes.providerOptions);
            const forwarded: typeof input.changes = {};
            if (changes.model !== undefined) forwarded.model = changes.model;
            if (changes.mode !== undefined) forwarded.mode = changes.mode;
            if (changes.thinkingOption !== undefined) forwarded.thinkingOption = changes.thinkingOption;
            if (settings && Object.keys(settings).length > 0) forwarded.settings = settings;
            if (providerOptions && Object.keys(providerOptions).length > 0) {
              forwarded.providerOptions = providerOptions;
            }
            if (Object.keys(forwarded).length === 0) {
              if (!lastConfig.has(input.sessionId)) throw new Error(`Unknown session: ${input.sessionId}`);
              return (auto === undefined ? Promise.resolve() : commitAutoAccept(input.sessionId, auto)).then(() => {
                emit({ type: "request.completed", requestId: input.requestId });
              });
            }
            if (auto !== undefined) pendingOptions.set(input.requestId, { sessionId: input.sessionId, auto });
            return connection.send({ ...input, changes: forwarded }).catch((error: unknown) => {
              pendingOptions.delete(input.requestId);
              throw error;
            });
          }
          if (input.type === "session.close") {
            return (writes.get(input.sessionId) ?? Promise.resolve()).catch(() => {}).then(() =>
              context.run(undefined, () => connection.send(input)));
          }
          return context.run(undefined, () => connection.send(input));
        },
        async close() {
          try {
            await Promise.allSettled(writes.values());
            await connection.close();
          } finally {
            unsubscribe();
            queries.clear();
            pendingOptions.clear();
            autoByBoundary.clear();
            boundaryToNative.clear();
            lastConfig.clear();
            commands.clear();
            stores.clear();
            writes.clear();
            approval.bySession.clear();
            approval.pending = undefined;
            listeners.clear();
          }
        },
      };
    },
  };
}
