import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createDshProvider } from "./provider.ts";

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
  return { connection, events, wait, request, prompt, open };
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
