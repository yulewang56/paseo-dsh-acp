import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpStream, type AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { DshAcpCompatibility } from "./compatibility.ts";
import { historyItemMethod } from "./history.ts";

interface OpenContext {
  env: Readonly<Record<string, string>>;
  replay: boolean;
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

function connectDsh(launch: ProviderLaunch, context?: OpenContext): AcpStream {
  const env = { ...launch.env, ...context?.env };
  const compatibility = new DshAcpCompatibility(env, context?.replay ?? false);
  const child = spawnProcess(launch.command, launch.args, { env, stdio: "pipe" });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let failure: Error | undefined;
  let closing = false;
  let stopping: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => child.once("close", resolve));
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
        const payload = JSON.stringify(compatibility.toAgent(message)) + "\n";
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(payload, (error) => error ? reject(error) : resolve());
        });
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
            throw failure ?? new Error(`DSH ACP process closed (${child.signalCode ?? child.exitCode ?? "EOF"})`);
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
    id: "dsh",
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
        id: "dsh",
        label: "DeepSeek Harness",
        connector: () => connectDsh(launch, context.getStore()),
        transformers: [{
          notification(notification, context) {
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
      return {
        ...connection,
        send(input) {
          return context.run(input.type === "session.open" ? {
            env: input.config.env, replay: input.history === "replay",
          } : undefined, () => connection.send(input));
        },
      };
    },
  };
}
