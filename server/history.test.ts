import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { decodeHistory, projectHistory, readDshHistory } from "./history.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";
const header = { type: "session", version: 4, id: sessionId, cwd: "/project" };
const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");
const events = [
  { type: "user/message", seq: 0, data: {
    id: "injected", source: { kind: "runtime-context" }, content: [{ type: "text", text: "hidden" }],
  } },
  { type: "user/message", seq: 1, data: {
    id: "user-1", source: { kind: "user" }, content: [{ type: "text", text: "hello" }],
  } },
  { type: "assistant/message", seq: 2, data: { message: {
    id: "assistant-1", content: [
      { type: "reasoning", text: "thought" }, { type: "text", text: "answer" },
      { type: "tool-call", id: "call-1" },
    ],
  } } },
  { type: "tool/call", seq: 3, data: { callId: "call-1", name: "read", arguments: '{"path":"/file"}' } },
  { type: "tool/result", seq: 4, data: { message: {
    id: "result-1", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "contents" }],
  } } },
  { type: "turn/end", seq: 5, data: { reason: { kind: "error", error: { message: "API unavailable" } } } },
];

test("all concatenated zstd frames are decoded, not only the session header", () => {
  const log = Buffer.concat([
    zstdCompressSync(jsonl([header])),
    zstdCompressSync(jsonl(events.slice(0, 3))),
    zstdCompressSync(jsonl(events.slice(3))),
  ]);
  assert.equal(decodeHistory(log), jsonl([header, ...events]));
  assert.throws(() => decodeHistory(log.subarray(0, log.length - 2)));
});

test("replay includes user, reply, reasoning, tool results and errors but not injected context", () => {
  const messages = projectHistory(jsonl([header, ...events]), sessionId);
  assert.equal(messages.length, 6);
  assert.deepEqual(messages.map((message) => "params" in message ? message.params : null), [
    { type: "user_message", id: '["user_message_chunk","user-1"]', messageId: "user-1", text: "hello" },
    { type: "reasoning", id: '["agent_thought_chunk","assistant-1"]', text: "thought" },
    { type: "assistant_message", id: '["agent_message_chunk","assistant-1"]', messageId: "assistant-1", text: "answer" },
    { type: "tool_call", id: "call-1", callId: "call-1", name: "read",
      status: "running", error: null, detail: { type: "unknown", input: { path: "/file" }, output: null } },
    { type: "tool_call", id: "call-1", callId: "call-1", name: "read",
      status: "completed", error: null, detail: { type: "unknown", input: { path: "/file" }, output: "contents" } },
    { type: "error", id: `dsh-error:${sessionId}:5`, message: "API unavailable" },
  ]);
  const replay = JSON.stringify(messages);
  assert.ok(!replay.includes("hidden"));
  assert.ok(!replay.includes("injected"));
  for (const value of ["hello", "thought", "answer", "contents", "API unavailable"]) {
    assert.ok(replay.includes(value));
  }
  assert.ok(replay.includes('"input":{"path":"/file"}'));
  assert.ok(replay.includes('"status":"completed"'));
  assert.deepEqual(projectHistory(jsonl([header, ...events]), sessionId), messages);
});

test("missing records, foreign sessions and unsupported format versions fail rather than erase history", () => {
  assert.throws(() => projectHistory(jsonl([{ ...header, version: 5 }]), sessionId));
  assert.throws(() => projectHistory(jsonl([{ ...header, id: "different" }]), sessionId));
  assert.throws(() => projectHistory(jsonl([header, events[1]]), sessionId), /not contiguous/);
  assert.throws(() => projectHistory(jsonl([header]).trimEnd(), sessionId), /incomplete/);
});

test("read-only restoration finds the existing file, validates cwd, and leaves its contents unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-test-"));
  try {
    const directory = join(root, "sessions", "project", sessionId);
    await mkdir(directory, { recursive: true });
    const text = jsonl([{ ...header, cwd: root }, ...events]);
    const file = join(directory, "session.v4.jsonl");
    await writeFile(file, text, { mode: 0o600 });
    const result = await readDshHistory({ sessionId, cwd: root }, { DSH_HOME: root });
    assert.deepEqual(result, projectHistory(text, sessionId));
    await assert.rejects(readDshHistory({ sessionId, cwd: tmpdir() }, { DSH_HOME: root }), /directory does not match/);
    await assert.rejects(readDshHistory({ sessionId: "../other", cwd: root }, { DSH_HOME: root }));
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(file, "utf8"), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
