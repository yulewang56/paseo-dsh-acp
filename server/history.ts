import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const sessionIdentity = z.object({
  sessionId: z.uuid(),
  cwd: z.string().min(1),
});
const headerSchema = z.object({
  type: z.literal("session"),
  version: z.literal(4),
  id: z.string(),
  cwd: z.string(),
});
const eventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
});
const messageSchema = z.object({
  id: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
export const historyItemMethod = "dsh/history_item";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function frameEnd(bytes: Buffer, start: number): number {
  let position = start;
  const advance = (length: number) => {
    if (length > bytes.length - position) throw new Error("Incomplete compressed DSH history frame");
    position += length;
  };
  advance(5);
  if (bytes.readUInt32LE(start) !== 0xfd2fb528) throw new Error("Invalid DSH history frame magic");
  const descriptor = bytes[start + 4];
  if (descriptor & 0x18) throw new Error("Invalid DSH history frame header");
  const sizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const dictionaryFlag = descriptor & 3;
  advance((singleSegment ? 0 : 1) +
    (dictionaryFlag === 3 ? 4 : dictionaryFlag) +
    (sizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << sizeFlag));
  let last = false;
  while (!last) {
    advance(3);
    const block = bytes.readUIntLE(position - 3, 3);
    const kind = (block >>> 1) & 3;
    if (kind === 3) throw new Error("Invalid DSH history compression block");
    advance(kind === 1 ? 1 : block >>> 3);
    last = (block & 1) !== 0;
  }
  if (descriptor & 4) advance(4);
  return position;
}

export function decodeHistory(bytes: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    // DSH appends independent frames; a one-shot Node decode reads only the first.
    const end = frameEnd(bytes, offset);
    chunks.push(zstdDecompressSync(bytes.subarray(offset, end)));
    offset = end;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function blockText(block: { type: string; text?: string }): string | undefined {
  if (block.type === "text" || block.type === "reasoning") {
    if (block.text === undefined) throw new Error(`Missing ${block.type} history text`);
    return block.text;
  }
  if (block.type === "tool-call") return undefined;
  return `[${block.type} attachment retained in DSH session]`;
}

export function projectHistory(text: string, sessionId: string): AcpStreamMessage[] {
  if (!text.endsWith("\n")) throw new Error("DSH history has an incomplete final record");
  const lines = text.trimEnd().split("\n");
  const header = headerSchema.parse(JSON.parse(lines[0]));
  if (header.id !== sessionId) throw new Error("DSH history session ID does not match");
  const messages: AcpStreamMessage[] = [];
  const tools = new Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>();
  const append = (item: ProviderTimelineItem) => {
    messages.push({
      jsonrpc: "2.0",
      method: historyItemMethod,
      params: item,
    });
  };
  const appendMessage = (message: z.infer<typeof messageSchema>, user: boolean) => {
    let reply = "";
    let reasoning = "";
    for (const block of message.content) {
      const text = blockText(block);
      if (text === undefined) continue;
      if (!user && block.type === "reasoning") {
        reasoning += text;
        append({ type: "reasoning", id: JSON.stringify(["agent_thought_chunk", message.id]), text: reasoning });
      } else {
        reply += text;
        append({
          type: user ? "user_message" : "assistant_message",
          id: JSON.stringify([user ? "user_message_chunk" : "agent_message_chunk", message.id]),
          messageId: message.id,
          text: reply,
        });
      }
    }
  };
  const finishTools = (cancelled: boolean) => {
    for (const call of tools.values()) {
      append(cancelled
        ? { ...call, status: "canceled", error: null }
        : { ...call, status: "failed", error: "Tool outcome unavailable in the persisted DSH turn" });
    }
    tools.clear();
  };
  for (let index = 1; index < lines.length; index++) {
    const event = eventSchema.parse(JSON.parse(lines[index]));
    if (event.seq !== index - 1) throw new Error("DSH history is not contiguous");
    if (event.type === "user/message") {
      const source = z.object({ kind: z.string() }).parse(event.data.source);
      if (source.kind !== "user") continue;
      appendMessage(messageSchema.parse(event.data), true);
    } else if (event.type === "assistant/message") {
      appendMessage(messageSchema.parse(event.data.message), false);
    } else if (event.type === "tool/call") {
      const call = z.object({
        callId: z.string(), name: z.string(), arguments: z.string(),
      }).parse(event.data);
      let rawInput: z.infer<ReturnType<typeof z.json>>;
      try {
        rawInput = z.json().parse(JSON.parse(call.arguments));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        rawInput = call.arguments;
      }
      const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
        type: "tool_call", id: call.callId, callId: call.callId,
        name: call.name, status: "running", error: null,
        detail: { type: "unknown", input: rawInput, output: null },
      };
      tools.set(call.callId, item);
      append(item);
    } else if (event.type === "tool/result") {
      const result = messageSchema.extend({
        toolCallId: z.string(), isError: z.boolean().optional(),
      }).parse(event.data.message);
      const text = result.content.map(blockText).filter((value) => value !== undefined).join("\n");
      const call = tools.get(result.toolCallId);
      if (!call || call.detail.type !== "unknown") throw new Error("DSH history tool result has no call");
      append({
        ...call,
        detail: { ...call.detail, output: text },
        ...(result.isError
          ? { status: "failed", error: text }
          : { status: "completed", error: null }),
      });
      tools.delete(result.toolCallId);
    } else if (event.type === "turn/end") {
      const reason = z.object({
        kind: z.string(), error: z.object({ message: z.string() }).optional(),
      }).parse(event.data.reason);
      if (reason.kind === "error" && reason.error) {
        append({ type: "error", id: `dsh-error:${sessionId}:${event.seq}`, message: reason.error.message });
      }
      if (["max-tokens", "blocked"].includes(reason.kind)) {
        append({
          type: "notification", id: `dsh-stop:${sessionId}:${event.seq}`,
          level: "warning", message: `DSH turn ended with ${reason.kind}; this does not establish that the task is complete.`,
        });
      }
      finishTools(["aborted", "interrupted"].includes(reason.kind));
    }
  }
  finishTools(false);
  return messages;
}

export async function readDshHistory(
  identity: { sessionId: string; cwd: string },
  env: NodeJS.ProcessEnv,
): Promise<AcpStreamMessage[]> {
  const { sessionId, cwd } = sessionIdentity.parse(identity);
  const root = env.DSH_ACP_SESSION_ROOT ??
    join(env.DSH_HOME || join(homedir(), ".dsh"), "sessions");
  const projects = await readdir(root, { withFileTypes: true });
  const matches: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name, sessionId);
    try {
      await readdir(directory);
      matches.push(directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one persisted DSH session ${sessionId}; found ${matches.length} in ${root}`);
  }
  const directory = matches[0];
  let text: string;
  try {
    text = decodeHistory(await readFile(join(directory, "session.v4.jsonl.zstd")));
  } catch (error) {
    if (!isMissing(error)) throw error;
    text = await readFile(join(directory, "session.v4.jsonl"), "utf8");
  }
  const header = headerSchema.parse(JSON.parse(text.split("\n", 1)[0]));
  if (await realpath(header.cwd) !== await realpath(cwd)) {
    throw new Error("DSH history working directory does not match");
  }
  return projectHistory(text, sessionId);
}
