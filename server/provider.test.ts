import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createDshProvider } from "./provider.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";

async function harness() {
  const provider = createDshProvider();
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.command", "prompt.steer", "prompt.image",
      "session.configure", "session.persistence", "session.list", "permission", "permission.tool_policy"],
    launch: {
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url))],
      env: Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      )),
    },
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const wait = (predicate: (event: ProviderEvent) => boolean) => new Promise<ProviderEvent>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Fixture event timeout")); }, 5000);
    const off = connection.onEvent((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
  const request = async (input: ProviderInput) => {
    if (!("requestId" in input)) throw new Error("Missing request ID");
    const result = wait((event) => "requestId" in event && event.requestId === input.requestId &&
      ["request.completed", "request.failed", "session.ready", "catalog", "sessions"].includes(event.type));
    await connection.send(input);
    const event = await result;
    await setImmediate();
    return event;
  };
  const prompt = (id: string, text: string) => connection.send({
    type: "session.prompt", sessionId: "boundary",
    prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } },
  });
  const open = () => request({
    type: "session.open", requestId: "open", sessionId: "boundary", history: "skip",
    config: { cwd: "/project", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  const openWith = (settings: { auto_accept?: boolean }) => request({
    type: "session.open", requestId: "open", sessionId: "boundary", history: "skip",
    config: { cwd: "/project", env: {}, mcpServers: {}, settings, persist: true },
  });
  return { connection, events, wait, request, prompt, open, openWith };
}

test("capabilities, cursor pagination, query and limit are truthful at the provider boundary", async () => {
  const h = await harness();
  try {
    assert.ok(!h.connection.capabilities.includes("prompt.command"));
    assert.ok(!h.connection.capabilities.includes("prompt.steer"));
    assert.ok(!h.connection.capabilities.includes("permission.tool_policy"));
    const result = await h.request({
      type: "sessions", requestId: "list", query: "needle", limit: 1, cwd: "/project",
    });
    assert.equal(result.type, "sessions");
    if (result.type !== "sessions") assert.fail();
    assert.equal(result.sessions.length, 1);
    assert.deepEqual(result.sessions[0].persistence.data, { sessionId: "old" });
    await h.open();
    const opened = h.events.find((event) => event.type === "session.opened");
    assert.ok(opened && !opened.capabilities.includes("prompt.command"));
  } finally { await h.connection.close(); }
});

test("cancel and concurrent auto input end the old turn exactly once and accept the next prompt", async () => {
  const h = await harness();
  try {
    await h.open();
    const started = h.wait((event) => event.type === "session.turn" && event.state === "started");
    const toolStarted = h.wait((event) => event.type === "timeline.item" &&
      event.item.type === "tool_call" && event.item.status === "running");
    await h.prompt("first", "wait");
    await started;
    await toolStarted;
    const canceled = h.wait((event) => event.type === "session.turn" && event.turnId === "acp:first" && event.state === "canceled");
    const completed = h.wait((event) => event.type === "session.turn" && event.turnId === "acp:second" && event.state === "completed");
    await h.prompt("second", "after-interrupt");
    await canceled;
    await completed;
    const tools = h.events.filter((event) => event.type === "timeline.item" && event.item.type === "tool_call");
    const ended = tools.at(-1);
    assert.ok(ended?.type === "timeline.item" && ended.item.type === "tool_call" &&
      ended.item.status === "canceled" && ended.item.error === null);
    assert.ok(h.events.some((event) => event.type === "timeline.item" &&
      event.item.type === "assistant_message" && event.item.text === "after-interrupt"));
    const third = h.wait((event) => event.type === "session.turn" && event.turnId === "acp:third" && event.state === "started");
    await h.prompt("third", "wait"); await third;
    const stopped = h.wait((event) => event.type === "session.turn" && event.turnId === "acp:third" && event.state === "canceled");
    await h.request({ type: "session.interrupt", requestId: "stop", sessionId: "boundary" });
    await stopped;
    for (const id of ["first", "second", "third"]) {
      assert.equal(h.events.filter((event) => event.type === "session.turn" &&
        event.turnId === `acp:${id}` && event.state !== "started").length, 1);
    }
  } finally { await h.connection.close(); }
});

test("permission action mismatch is rejected and the unchanged prompt can still be allowed or denied once", async () => {
  const h = await harness();
  try {
    await h.open();
    for (const behavior of ["allow", "deny"] as const) {
      const asked = h.wait((event) => event.type === "session.permission");
      await h.prompt(behavior, "permission");
      const event = await asked;
      if (event.type !== "session.permission") assert.fail();
      const permissionId = event.request.id;
      assert.throws(() => h.connection.send({
        type: "session.permission", sessionId: "boundary", permissionId,
        response: { behavior, selectedActionId: behavior === "allow" ? "reject-once" : "allow-once" },
      }), /does not match/);
      const completed = h.wait((event) => event.type === "session.turn" &&
        event.turnId === `acp:${behavior}` && event.state === "completed");
      await h.connection.send({
        type: "session.permission", sessionId: "boundary", permissionId,
        response: { behavior, selectedActionId: behavior === "allow" ? "allow-once" : "reject-once" },
      });
      await completed;
      assert.ok(h.events.some((event) => event.type === "timeline.item" &&
        event.item.type === "assistant_message" && event.item.text === `${behavior === "allow" ? "allow" : "reject"}-once`));
    }
  } finally { await h.connection.close(); }
});

test("model and thought selections preserve opaque IDs and report errors without committing invalid configuration", async () => {
  const h = await harness();
  try {
    await h.open();
    const changed = await h.request({
      type: "session.configure", requestId: "valid", sessionId: "boundary",
      changes: { model: '["fixture","beta"]', thinkingOption: "off" },
    });
    assert.equal(changed.type, "request.completed");
    const committed = h.events.filter((event) => event.type === "session.config").at(-1);
    assert.equal(committed?.config.model, '["fixture","beta"]');
    assert.equal(committed?.config.thinkingOption, "off");
    const failed = await h.request({
      type: "session.configure", requestId: "invalid", sessionId: "boundary",
      changes: { model: '["fixture","missing"]' },
    });
    assert.equal(failed.type, "request.failed");
    const after = h.events.filter((event) => event.type === "session.config").at(-1);
    assert.equal(after?.config.model, '["fixture","beta"]');
    const partial = await h.request({
      type: "session.configure", requestId: "partial-failure", sessionId: "boundary",
      changes: { model: '["fixture","alpha"]', thinkingOption: "unsupported" },
    });
    assert.equal(partial.type, "request.failed");
    const next = await h.request({
      type: "session.configure", requestId: "after-rollback", sessionId: "boundary",
      changes: { thinkingOption: "high" },
    });
    assert.equal(next.type, "request.completed");
    const restored = h.events.filter((event) => event.type === "session.config").at(-1);
    assert.equal(restored?.config.model, '["fixture","beta"]');
    assert.equal(restored?.config.thinkingOption, "high");
  } finally { await h.connection.close(); }
});

test("DSH tool result content stays visible in the live timeline", async () => {
  const h = await harness();
  try {
    await h.open();
    const resultTool = h.wait((event) => event.type === "timeline.item" &&
      event.item.type === "tool_call" && event.item.callId === "tool-result" && event.item.status === "completed");
    const resultTurn = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:tool-result" && event.state === "completed");
    await h.prompt("tool-result", "tool-result");
    const completed = await resultTool;
    await resultTurn;
    assert.ok(completed.type === "timeline.item" && completed.item.type === "tool_call" &&
      completed.item.detail.type === "unknown");
    assert.deepEqual(completed.item.detail, {
      type: "unknown", input: {}, output: "fixture tool result",
    });
    const failedTool = h.wait((event) => event.type === "timeline.item" &&
      event.item.type === "tool_call" && event.item.callId === "tool-failed-result" && event.item.status === "failed");
    const failedTurn = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:tool-failed-result" && event.state === "completed");
    await h.prompt("tool-failed-result", "tool-failed-result");
    const failed = await failedTool;
    await failedTurn;
    assert.ok(failed.type === "timeline.item" && failed.item.type === "tool_call" &&
      failed.item.detail.type === "unknown");
    assert.deepEqual(failed.item.detail, {
      type: "unknown", input: {}, output: "fixture tool failure detail",
    });
    assert.equal(failed.item.error, "fixture tool failure detail");
  } finally { await h.connection.close(); }
});

test("output limits warn before completion, API errors fail, and process death is not successful completion", async () => {
  const h = await harness();
  try {
    await h.open();
    const toolFailed = h.wait((event) => event.type === "timeline.item" &&
      event.item.type === "tool_call" && event.item.callId === "empty-error" && event.item.status === "failed");
    const toolFinished = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:tool-error" && event.state === "completed");
    await h.prompt("tool-error", "tool-error");
    const failedTool = await toolFailed;
    await toolFinished;
    assert.ok(failedTool.type === "timeline.item" && failedTool.item.type === "tool_call" &&
      typeof failedTool.item.error === "string" && failedTool.item.error.includes("without error details"));
    const limit = h.wait((event) => event.type === "session.turn" && event.turnId === "acp:limit" && event.state === "completed");
    await h.prompt("limit", "limit"); await limit;
    const warning = h.events.findIndex((event) => event.type === "timeline.item" &&
      event.item.type === "notification" && event.item.message.includes("max_tokens"));
    assert.ok(warning >= 0);
    assert.ok(warning < h.events.findIndex((event) => event.type === "session.turn" &&
      event.turnId === "acp:limit" && event.state === "completed"));
    const failed = h.wait((event) => event.type === "session.turn" && event.turnId === "acp:error" && event.state === "failed");
    await h.prompt("error", "error"); await failed;
    const crashed = h.wait((event) => event.type === "session.runtime_failed");
    await h.prompt("crash", "crash"); await crashed;
    assert.ok(!h.events.some((event) => event.type === "session.turn" &&
      event.turnId === "acp:crash" && event.state === "completed"));
  } finally { await h.connection.close(); }
});

test("a missing launch command rejects at connect instead of hanging", { timeout: 10000 }, async () => {
  const provider = createDshProvider();
  await assert.rejects(provider.connect({
    versions: [1], capabilities: ["prompt.message"],
    launch: { command: "/definitely/missing/dsh-binary", args: [], env: {} },
  }));
});

test("close escalates to SIGKILL when the agent ignores stdin EOF and SIGTERM", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-hung-"));
  const pidFile = join(directory, "pid");
  const connection = await createDshProvider().connect({
    versions: [1], capabilities: ["prompt.message"],
    launch: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/hung-agent.mjs", import.meta.url))],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      )), DSH_HUNG_PID_FILE: pidFile },
    },
  });
  try {
    // The capability probe writes the PID file first, then exits; opening a real
    // session starts the long-lived process that overwrites it.
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("hung fixture did not open")), 5000);
      const off = connection.onEvent((event) => {
        if (event.type === "session.ready") { clearTimeout(timer); off(); resolve(); }
      });
    });
    await connection.send({
      type: "session.open", requestId: "open", sessionId: "boundary", history: "skip",
      config: { cwd: process.cwd(), env: {}, mcpServers: {}, settings: {}, persist: true },
    });
    await ready;
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.doesNotThrow(() => process.kill(pid, 0));
    const started = Date.now();
    await connection.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1400, `expected the SIGTERM grace period before SIGKILL, got ${elapsed}ms`);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await connection.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("history replay reaches the timeline through the provider connection", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-replay-"));
  const project = join(root, "project");
  const sessionRoot = join(root, "sessions");
  const directory = join(sessionRoot, "project", sessionId);
  await mkdir(directory, { recursive: true });
  await mkdir(project, { recursive: true });
  const text = [
    JSON.stringify({ type: "session", version: 4, id: sessionId, cwd: project }),
    JSON.stringify({
      type: "user/message", seq: 0,
      data: { id: "replayed", source: { kind: "user" }, content: [{ type: "text", text: "replayed history" }] },
    }),
    JSON.stringify({
      type: "request/context", seq: 1,
      data: { provider: "fixture", model: "fixture", contextWindow: 1000 },
    }),
    JSON.stringify({
      type: "assistant/message", seq: 2,
      data: {
        message: { id: "replayed-assistant", content: [{ type: "text", text: "replayed answer" }] },
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 250 },
      },
    }),
    "",
  ].join("\n");
  await writeFile(join(directory, "session.v4.jsonl"), text);
  const h = await harness();
  try {
    const ready = await h.request({
      type: "session.open", requestId: "replay", sessionId, history: "replay",
      persistence: { version: 1, data: { sessionId } },
      config: {
        cwd: project, env: { DSH_ACP_SESSION_ROOT: sessionRoot },
        mcpServers: {}, settings: {}, persist: true,
      },
    });
    assert.equal(ready.type, "session.ready");
    const usage = h.events.find((event) => event.type === "session.usage");
    assert.ok(usage?.type === "session.usage");
    assert.equal(usage.usage.contextWindowUsedTokens, 250);
    assert.equal(usage.usage.contextWindowMaxTokens, 1000);
    const replay = h.events.findIndex((event) => event.type === "timeline.item" &&
      event.item.type === "user_message" && event.item.text === "replayed history");
    const opened = h.events.findIndex((event) => event.type === "session.opened");
    const readyIndex = h.events.findIndex((event) => event.type === "session.ready");
    assert.ok(replay >= 0, "replayed history must reach the timeline");
    assert.ok(replay < opened, "history must be replayed before the session opens");
    assert.ok(replay < readyIndex, "history must be replayed before the session is ready");
  } finally {
    await h.connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live non-text tool output keeps a type placeholder", async () => {
  const h = await harness();
  try {
    await h.open();
    const finished = h.wait((event) => event.type === "timeline.item" &&
      event.item.type === "tool_call" && event.item.callId === "tool-image-result" &&
      event.item.status === "completed");
    const turn = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:tool-image-result" && event.state === "completed");
    await h.prompt("tool-image-result", "tool-image-result");
    const event = await finished;
    await turn;
    assert.ok(event.type === "timeline.item" && event.item.type === "tool_call");
    assert.deepEqual(event.item.detail, {
      type: "unknown", input: {}, output: "[image attachment retained in DSH session]",
    });
  } finally { await h.connection.close(); }
});

test("permission for an already completed tool does not invent arguments", async () => {
  const h = await harness();
  try {
    await h.open();
    const asked = h.wait((event) => event.type === "session.permission");
    await h.prompt("permission-after-complete", "permission-after-complete");
    const event = await asked;
    if (event.type !== "session.permission") assert.fail();
    assert.equal(event.request.title, undefined);
    assert.deepEqual(event.request.input, {});
    const completed = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:permission-after-complete" && event.state === "completed");
    await h.connection.send({
      type: "session.permission", sessionId: "boundary", permissionId: event.request.id,
      response: { behavior: "allow", selectedActionId: "allow-once" },
    });
    await completed;
  } finally { await h.connection.close(); }
});

test("session queries filter by title, cwd and persistence metadata and honor limit", async () => {
  const h = await harness();
  try {
    const upper = await h.request({ type: "sessions", requestId: "upper", query: "NEEDLE", cwd: "/project" });
    assert.equal(upper.type, "sessions");
    if (upper.type !== "sessions") assert.fail();
    assert.deepEqual(upper.sessions.map((session) => (session.persistence.data as { sessionId?: string }).sessionId), ["old"]);

    const metadata = await h.request({ type: "sessions", requestId: "meta", query: "old", cwd: "/project" });
    assert.equal(metadata.type, "sessions");
    if (metadata.type !== "sessions") assert.fail();
    assert.deepEqual(metadata.sessions.map((session) => (session.persistence.data as { sessionId?: string }).sessionId), ["old"]);

    const cwd = await h.request({ type: "sessions", requestId: "cwd", query: "/PROJECT", cwd: "/project" });
    assert.equal(cwd.type, "sessions");
    if (cwd.type !== "sessions") assert.fail();
    assert.equal(cwd.sessions.length, 2);

    const limited = await h.request({ type: "sessions", requestId: "limit", limit: 1, cwd: "/project" });
    assert.equal(limited.type, "sessions");
    if (limited.type !== "sessions") assert.fail();
    assert.deepEqual(limited.sessions.map((session) => (session.persistence.data as { sessionId?: string }).sessionId), ["new"]);
  } finally { await h.connection.close(); }
});

test("unsubscribed listeners stop receiving events", async () => {
  const h = await harness();
  try {
    const seen: string[] = [];
    const off = h.connection.onEvent((event) => seen.push(event.type));
    off();
    await h.open();
    assert.deepEqual(seen, []);
  } finally { await h.connection.close(); }
});

test("sending after close rejects instead of leaving a pending query", async () => {
  const h = await harness();
  await h.connection.close();
  await assert.rejects(h.connection.send({ type: "sessions", requestId: "late", cwd: "/project" }));
});

test("the Auto Accept setting approves permissions without a client prompt", async () => {
  const h = await harness();
  try {
    await h.openWith({ auto_accept: true });
    const config = h.events.filter((event) => event.type === "session.config").at(-1);
    assert.ok(config?.type === "session.config");
    assert.deepEqual(config.config.settings.find((setting) => setting.id === "auto_accept"), {
      type: "toggle", id: "auto_accept", label: "Auto Accept",
      description: "Automatically approve DSH permission requests.", value: true,
    });
    const completed = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:permission" && event.state === "completed");
    await h.prompt("permission", "permission");
    await completed;
    assert.ok(!h.events.some((event) => event.type === "session.permission"));
    assert.ok(h.events.some((event) => event.type === "timeline.item" &&
      event.item.type === "notification" && event.item.message.includes("Auto Accept")));
    assert.ok(h.events.some((event) => event.type === "timeline.item" &&
      event.item.type === "assistant_message" && event.item.text === "allow-once"));
  } finally { await h.connection.close(); }
});

test("Auto Accept can be toggled at runtime and off again", async () => {
  const h = await harness();
  try {
    await h.open();
    await h.request({
      type: "session.configure", requestId: "auto-on", sessionId: "boundary",
      changes: { settings: { auto_accept: true } },
    });
    const enabled = h.events.filter((event) => event.type === "session.config").at(-1);
    assert.ok(enabled?.type === "session.config");
    assert.equal(enabled.config.settings.find((setting) => setting.id === "auto_accept")?.value, true);

    const autoCompleted = h.wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:permission" && event.state === "completed");
    await h.prompt("permission", "permission");
    await autoCompleted;
    assert.ok(!h.events.some((event) => event.type === "session.permission"));

    await h.request({
      type: "session.configure", requestId: "auto-off", sessionId: "boundary",
      changes: { settings: { auto_accept: false } },
    });
    const asked = h.wait((event) => event.type === "session.permission");
    await h.prompt("permission", "permission");
    const event = await asked;
    if (event.type !== "session.permission") assert.fail();
    const completed = h.wait((e) => e.type === "session.turn" && e.turnId === "acp:permission" && e.state === "completed");
    await h.connection.send({
      type: "session.permission", sessionId: "boundary", permissionId: event.request.id,
      response: { behavior: "allow", selectedActionId: "allow-once" },
    });
    await completed;
  } finally { await h.connection.close(); }
});
