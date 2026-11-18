import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { AGENTS_MODULE, AGENT_PRESET_MODULE, OVERLAY_MODULE, SKILL_FILESYSTEM_MODULE } from "./embedded-overlay.ts";

type Message = AcpStreamMessage;
interface SkillAgent { session: { id: string }; }
interface SkillContext {
  agents: { get(id: string): SkillAgent | undefined };
  workingDirectory: { ensure(agent: SkillAgent): Promise<string> };
  skills: {
    snapshot(options: { cwd: string; scope: SkillAgent; signal?: AbortSignal }): Promise<{
      complete: boolean;
      skills: Array<{ name: string; description: string; invocation: { userInvocable: boolean } }>;
    }>;
  };
  logger: { warn(message: string): void };
  on(event: string, callback: () => void): void;
  effect(callback: () => () => void): void;
}
interface Stream {
  readable: ReadableStream<Message>;
  writable: WritableStream<Message>;
}

// Serialized into a DSH-owned Cordis module. Keep its runtime dependencies local.
export function withSkillCommands(
  ctx: SkillContext,
  config: Record<string, unknown>,
  acp: { apply(ctx: SkillContext, config: Record<string, unknown>): void },
  transport: Stream,
): void {
  const pending = new Map<string | number | null, { method: string; sessionId?: string }>();
  const lifetime = new AbortController();
  const sessions = new Map<string, number>();
  const warnings = new Set<string>();
  const writer = transport.writable.getWriter();
  let output = Promise.resolve();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (message: Message) => {
    const operation = output.then(() => writer.write(message));
    output = operation.catch(() => {});
    return operation;
  };
  const update = (sessionId: string, commands: Array<{ name: string; description: string }>) =>
    send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: commands } },
    });
  const refresh = async (sessionId: string) => {
    if (closed || !sessions.has(sessionId)) return;
    const revision = (sessions.get(sessionId) ?? 0) + 1;
    sessions.set(sessionId, revision);
    try {
      const agent = ctx.agents.get(sessionId);
      if (!agent) { sessions.delete(sessionId); return; }
      const cwd = await ctx.workingDirectory.ensure(agent);
      const snapshot = await ctx.skills.snapshot({ cwd, scope: agent, signal: lifetime.signal });
      if (closed || sessions.get(sessionId) !== revision) return;
      await update(sessionId, snapshot.skills.filter((skill) => skill.invocation.userInvocable)
        .map(({ name, description }) => ({ name, description })));
      if (!snapshot.complete) {
        warnings.add(sessionId);
        await send({
          jsonrpc: "2.0", method: "dsh/skills_warning",
          params: { sessionId, message: "DSH skill discovery is incomplete; only confirmed skills are listed." },
        });
      } else if (warnings.delete(sessionId)) {
        await send({
          jsonrpc: "2.0", method: "dsh/skills_warning",
          params: { sessionId, message: "DSH skill discovery completed.", dismissed: true },
        });
      }
    } catch (error) {
      if (closed || sessions.get(sessionId) !== revision) return;
      const message = `DSH skill discovery failed: ${String(error)}`;
      ctx.logger.warn(message);
      warnings.add(sessionId);
      await update(sessionId, []);
      await send({ jsonrpc: "2.0", method: "dsh/skills_warning", params: { sessionId, message } });
    }
  };
  ctx.on("skills/change", () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const id of sessions.keys()) {
        void refresh(id).catch((error: unknown) => ctx.logger.warn(`DSH skill update failed: ${String(error)}`));
      }
    }, 50);
  });
  ctx.effect(() => () => {
    closed = true;
    lifetime.abort();
    clearTimeout(timer);
    sessions.clear();
    warnings.clear();
    pending.clear();
  });
  acp.apply(ctx, {
    ...config,
    stream: {
      readable: transport.readable.pipeThrough(new TransformStream<Message, Message>({
        async transform(message, controller) {
          if ("method" in message) {
            if ("id" in message &&
                ["session/new", "session/resume", "session/close"].includes(message.method)) {
              const params = message.params as { sessionId?: string };
              pending.set(message.id, { method: message.method, sessionId: params.sessionId });
            }
            if (message.method === "session/prompt") {
              const params = message.params as { sessionId: string };
              await refresh(params.sessionId);
            }
          }
          controller.enqueue(message);
        },
      })),
      writable: new WritableStream<Message>({
        async write(message) {
          const request = "id" in message ? pending.get(message.id) : undefined;
          if ("id" in message && !("method" in message)) pending.delete(message.id);
          await send(message);
          if (request && "result" in message && message.result && typeof message.result === "object") {
            const result = message.result as { sessionId?: string };
            const id = result.sessionId ?? request.sessionId;
            if (id && request.method === "session/close") {
              sessions.delete(id);
              warnings.delete(id);
            } else if (id) {
              sessions.set(id, 0);
              await refresh(id);
            }
          }
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      }),
    },
  });
}

export async function createSkillsOverlay(skills?: {
  claudeSkills: boolean; copilotSkills: boolean; customSkillDirs: string[];
}): Promise<{ path: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-dsh-overlay-"));
  const path = join(directory, "overlay.json");
  const module = join(directory, "overlay.mjs");
  try {
    // Paseo evaluates the plugin server bundle with esbuild CJS, where
    // import.meta.url is not a usable plugin-directory path. Keep the DSH-side
    // modules embedded and materialize them beside the patch instead.
    await Promise.all([
      writeFile(module, OVERLAY_MODULE),
      writeFile(join(directory, "agents.mjs"), AGENTS_MODULE),
      writeFile(join(directory, "agent-preset.mjs"), AGENT_PRESET_MODULE),
      writeFile(join(directory, "skill-filesystem.mjs"), SKILL_FILESYSTEM_MODULE),
    ]);
    // Patch names are assertions, not replacements; mount the overlay separately.
    await writeFile(path, JSON.stringify([
      { id: "acp", name: "@deepseek-ai/dsh-acp", disabled: true },
      { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem", disabled: true },
      { insert: [{ id: "paseo-skill-filesystem", name: join(directory, "skill-filesystem.mjs"), config: skills ?? {} }] },
      { insert: [{ id: "paseo-dsh-overlay", name: module }] },
    ]));
    return { path, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
