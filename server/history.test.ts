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

test("ended or interrupted tools are not left running in restored history, and output limits remain visible", () => {
  for (const kind of ["interrupted", "error", "max-tokens"]) {
    const records = [
      { type: "tool/call", seq: 0, data: { callId: "call", name: "test", arguments: "{}" } },
      { type: "turn/end", seq: 1, data: { reason: { kind } } },
    ];
    const projected = projectHistory(jsonl([header, ...records]), sessionId);
    const last = projected.at(-1);
    assert.ok(last && "params" in last);
    assert.deepEqual(last.params, {
      type: "tool_call", id: "call", callId: "call", name: "test",
      detail: { type: "unknown", input: {}, output: null },
      status: kind === "interrupted" ? "canceled" : "failed",
      error: kind === "interrupted" ? null : "Tool outcome unavailable in the persisted DSH turn",
    });
    if (kind === "max-tokens") assert.ok(JSON.stringify(projected).includes("max-tokens"));
  }
});

test("non-text attachments have visible placeholders without reading or claiming to replay media", () => {
  const rows = [
    { type: "user/message", seq: 0, data: {
      id: "image", source: { kind: "user" }, content: [{ type: "image", attachmentId: "opaque" }],
    } },
  ];
  assert.ok(JSON.stringify(projectHistory(jsonl([header, ...rows]), sessionId))
    .includes("[image attachment retained in DSH session]"));
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

test("malformed compressed frames fail instead of truncating history", () => {
  const frame = zstdCompressSync(jsonl([header]));
  const badMagic = Buffer.from(frame);
  badMagic.writeUInt32LE(0, 0);
  assert.throws(() => decodeHistory(badMagic), /frame magic/);
  const reserved = Buffer.from(frame);
  reserved[4] |= 0x18;
  assert.throws(() => decodeHistory(reserved), /frame header/);
  const invalidBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x07, 0x00, 0x00]);
  assert.throws(() => decodeHistory(invalidBlock), /compression block/);
  assert.throws(() => decodeHistory(frame.subarray(0, 5)), /Incomplete/);
  assert.equal(decodeHistory(Buffer.alloc(0)), "");
});

test("non-JSON tool arguments stay as text instead of being guessed", () => {
  const rows = [
    { type: "tool/call", seq: 0, data: { callId: "call", name: "shell", arguments: "not json" } },
    { type: "turn/end", seq: 1, data: { reason: { kind: "end_turn" } } },
  ];
  const [call] = projectHistory(jsonl([header, ...rows]), sessionId);
  assert.ok(call && "params" in call);
  assert.deepEqual(call.params, {
    type: "tool_call", id: "call", callId: "call", name: "shell",
    status: "running", error: null,
    detail: { type: "unknown", input: "not json", output: null },
  });
});

test("history discovery honors the session root override, prefers zstd and ignores stray files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-root-"));
  try {
    const directory = join(root, "project", sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, "stray.txt"), "not a project directory");
    const plain = jsonl([{ ...header, cwd: root }, {
      type: "user/message", seq: 0, data: {
        id: "plain", source: { kind: "user" }, content: [{ type: "text", text: "plain copy" }],
      },
    }]);
    const compressed = jsonl([{ ...header, cwd: root }, {
      type: "user/message", seq: 0, data: {
        id: "compressed", source: { kind: "user" }, content: [{ type: "text", text: "compressed copy" }],
      },
    }]);
    await writeFile(join(directory, "session.v4.jsonl"), plain);
    await writeFile(join(directory, "session.v4.jsonl.zstd"), zstdCompressSync(compressed));
    const result = await readDshHistory({ sessionId, cwd: root }, { DSH_ACP_SESSION_ROOT: root });
    assert.deepEqual(result, projectHistory(compressed, sessionId));
    assert.ok(!JSON.stringify(result).includes("plain copy"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt compressed history fails instead of silently falling back to jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-corrupt-"));
  try {
    const directory = join(root, "project", sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.v4.jsonl.zstd"), "not a zstd frame");
    await writeFile(join(directory, "session.v4.jsonl"), jsonl([{ ...header, cwd: root }]));
    await assert.rejects(
      readDshHistory({ sessionId, cwd: root }, { DSH_ACP_SESSION_ROOT: root }),
      /frame magic/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous or missing persisted sessions fail explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-many-"));
  try {
    await mkdir(join(root, "one", sessionId), { recursive: true });
    await mkdir(join(root, "two", sessionId), { recursive: true });
    await assert.rejects(
      readDshHistory({ sessionId, cwd: root }, { DSH_ACP_SESSION_ROOT: root }),
      /Expected one persisted DSH session/,
    );
    await assert.rejects(
      readDshHistory(
        { sessionId: "22222222-2222-4222-8222-222222222222", cwd: root },
        { DSH_ACP_SESSION_ROOT: root },
      ),
      /found 0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history from a working directory that no longer exists is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-cwd-"));
  try {
    const directory = join(root, "project", sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "session.v4.jsonl"),
      jsonl([{ ...header, cwd: join(root, "deleted") }]),
    );
    await assert.rejects(
      readDshHistory({ sessionId, cwd: root }, { DSH_ACP_SESSION_ROOT: root }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turn end variants surface blocked warnings, aborts and missing error details", () => {
  const blocked = projectHistory(jsonl([header,
    { type: "turn/end", seq: 0, data: { reason: { kind: "blocked" } } }]), sessionId);
  assert.equal(blocked.length, 1);
  const [warning] = blocked;
  assert.ok(warning && "params" in warning);
  assert.deepEqual(warning.params, {
    type: "notification", id: `dsh-stop:${sessionId}:0`, level: "warning",
    message: "DSH turn ended with blocked; this does not establish that the task is complete.",
  });

  const aborted = projectHistory(jsonl([header,
    { type: "tool/call", seq: 0, data: { callId: "call", name: "test", arguments: "{}" } },
    { type: "turn/end", seq: 1, data: { reason: { kind: "aborted" } } }]), sessionId);
  const last = aborted.at(-1);
  assert.ok(last && "params" in last);
  assert.deepEqual(last.params, {
    type: "tool_call", id: "call", callId: "call", name: "test",
    detail: { type: "unknown", input: {}, output: null },
    status: "canceled", error: null,
  });

  assert.deepEqual(projectHistory(jsonl([header,
    { type: "turn/end", seq: 0, data: { reason: { kind: "error" } } }]), sessionId), []);

  assert.throws(() => projectHistory(jsonl([header, {
    type: "assistant/message", seq: 0, data: { message: { id: "a", content: [{ type: "text" }] } },
  }]), sessionId), /Missing text history text/);
});

