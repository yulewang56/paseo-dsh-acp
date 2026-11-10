import assert from "node:assert/strict";
import { test } from "node:test";
import { DshAcpCompatibility } from "./compatibility.ts";
import { historyItemMethod } from "./history.ts";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

const sessionId = "11111111-2222-4333-8444-555555555555";
const load: AcpStreamMessage = {
  jsonrpc: "2.0", id: 2, method: "session/load",
  params: { sessionId, cwd: "/project", mcpServers: [], _meta: { kept: true } },
};

async function initialize(bridge: DshAcpCompatibility, capabilities: object) {
  bridge.toAgent({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  return bridge.fromAgent({
    jsonrpc: "2.0", id: 1,
    result: { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [] },
  });
}

test("resume-only DSH gains real load compatibility and replays before the load result", async () => {
  const history: AcpStreamMessage[] = [{
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk" } },
  }];
  const bridge = new DshAcpCompatibility({ DSH_HOME: "/data" }, true, async (identity, env) => {
    assert.deepEqual(identity, { sessionId, cwd: "/project" });
    assert.equal(env.DSH_HOME, "/data");
    return history;
  });
  const [initialized] = await initialize(bridge, { sessionCapabilities: { resume: {}, list: {}, close: {} } });
  assert.deepEqual(initialized, {
    jsonrpc: "2.0", id: 1,
    result: { protocolVersion: 1, authMethods: [],
      agentCapabilities: { sessionCapabilities: { resume: {}, list: {}, close: {} }, loadSession: true } },
  });
  assert.deepEqual(bridge.toAgent(load), { ...load, method: "session/resume" });
  const result: AcpStreamMessage = { jsonrpc: "2.0", id: 2, result: { configOptions: [] } };
  assert.deepEqual(await bridge.fromAgent(result), [...history, result]);
});

test("history skip still resumes the original session without reading or replaying history", async () => {
  const bridge = new DshAcpCompatibility({}, false, async () => assert.fail("History must be skipped"));
  await initialize(bridge, { sessionCapabilities: { resume: {} } });
  assert.deepEqual(bridge.toAgent(load), { ...load, method: "session/resume" });
  const result: AcpStreamMessage = { jsonrpc: "2.0", id: 2, result: {} };
  assert.deepEqual(await bridge.fromAgent(result), [result]);
});

test("resume errors propagate unchanged and never create replacement sessions", async () => {
  const bridge = new DshAcpCompatibility({}, true, async () => assert.fail("Resume failed"));
  await initialize(bridge, { sessionCapabilities: { resume: {} } });
  bridge.toAgent(load);
  const error: AcpStreamMessage = {
    jsonrpc: "2.0", id: 2, error: { code: -32602, message: "session is not resumable" },
  };
  assert.deepEqual(await bridge.fromAgent(error), [error]);
});

test("history read failures fail the load explicitly instead of returning empty success", async () => {
  const bridge = new DshAcpCompatibility({}, true, async () => { throw new Error("corrupt log"); });
  await initialize(bridge, { sessionCapabilities: { resume: {} } });
  bridge.toAgent(load);
  const [result] = await bridge.fromAgent({ jsonrpc: "2.0", id: 2, result: {} });
  assert.ok("error" in result);
  assert.match(result.error.message, /Cannot replay DSH history: corrupt log/);
});

test("native load support and agents without either capability are not rewritten", async () => {
  for (const capabilities of [{ loadSession: true, sessionCapabilities: { resume: {} } }, {}]) {
    const bridge = new DshAcpCompatibility({}, true);
    const [result] = await initialize(bridge, capabilities);
    assert.deepEqual(result, {
      jsonrpc: "2.0", id: 1,
      result: { protocolVersion: 1, agentCapabilities: capabilities, authMethods: [] },
    });

    assert.deepEqual(bridge.toAgent(load), load);
  }
});

test("pagination preserves cwd and metadata, deduplicates entries and fails on a repeated cursor", async () => {
  const forwarded: AcpStreamMessage[] = [];
  const bridge = new DshAcpCompatibility({}, false, undefined, async (message) => { forwarded.push(message); });
  bridge.toAgent({
    jsonrpc: "2.0", id: 8, method: "session/list", params: { cwd: "/project", _meta: { kept: true } },
  });
  const first: AcpStreamMessage = { jsonrpc: "2.0", id: 8, result: {
    sessions: [{ sessionId, cwd: "/project" }], nextCursor: "page2",
  } };
  assert.deepEqual(await bridge.fromAgent(first), []);
  assert.deepEqual(forwarded, [{
    jsonrpc: "2.0", id: 8, method: "session/list",
    params: { cwd: "/project", _meta: { kept: true }, cursor: "page2" },
  }]);
  const [failed] = await bridge.fromAgent(first);
  assert.ok("error" in failed);
  assert.match(failed.error.message, /repeated a pagination cursor/);
});

test("pagination returns all distinct sessions, and a later page error never becomes partial success", async () => {
  const bridge = new DshAcpCompatibility({}, false, undefined, async () => {});
  const begin = (id: number) => bridge.toAgent({ jsonrpc: "2.0", id, method: "session/list" });
  const page = (id: number): AcpStreamMessage => ({ jsonrpc: "2.0", id, result: {
    sessions: [{ sessionId, cwd: "/project" }], nextCursor: "next",
  } });
  begin(10);
  await bridge.fromAgent(page(10));
  const [result] = await bridge.fromAgent({ jsonrpc: "2.0", id: 10, result: {
    sessions: [{ sessionId, cwd: "/project" }, { sessionId: "older", cwd: "/project" }],
  } });
  assert.deepEqual(result, { jsonrpc: "2.0", id: 10, result: {
    sessions: [{ sessionId, cwd: "/project" }, { sessionId: "older", cwd: "/project" }], nextCursor: null,
  } });
  begin(11);
  await bridge.fromAgent(page(11));
  const error: AcpStreamMessage = {
    jsonrpc: "2.0", id: 11, error: { code: -32603, message: "storage unavailable" },
  };
  assert.deepEqual(await bridge.fromAgent(error), [error]);
});

test("DSH ID-only permission requests acquire tool context without inventing tool arguments", async () => {
  const bridge = new DshAcpCompatibility({}, false);
  const request: AcpStreamMessage = {
    jsonrpc: "2.0", id: "permission", method: "session/request_permission",
    params: { sessionId, toolCall: { toolCallId: "call" }, options: [] },
  };
  assert.deepEqual(await bridge.fromAgent(request), [{
    ...request, params: { sessionId, toolCall: { toolCallId: "call", title: undefined, rawInput: null }, options: [] },
  }]);
  await bridge.fromAgent({
    jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "call", title: "Read a file", rawInput: { path: "/file" },
    } },
  });
  assert.deepEqual(await bridge.fromAgent(request), [{
    ...request, params: { sessionId, toolCall: {
      toolCallId: "call", title: "Read a file", rawInput: { path: "/file" },
    }, options: [] },
  }]);
});

test("tool output is not overwritten when DSH already supplied rawOutput", async () => {
  const bridge = new DshAcpCompatibility({}, false);
  const update: AcpStreamMessage = {
    jsonrpc: "2.0", method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ignored" } }],
      rawOutput: "kept by DSH",
    } },
  };
  assert.deepEqual(await bridge.fromAgent(update), [update]);
});

test("pagination without a transport and unparseable pages fail instead of returning partial lists", async () => {
  const bridge = new DshAcpCompatibility({}, false);
  bridge.toAgent({ jsonrpc: "2.0", id: 8, method: "session/list", params: {} });
  const [unavailable] = await bridge.fromAgent({
    jsonrpc: "2.0", id: 8, result: { sessions: [], nextCursor: "page2" },
  });
  assert.ok("error" in unavailable);
  assert.match(unavailable.error.message, /transport is unavailable/);

  bridge.toAgent({ jsonrpc: "2.0", id: 9, method: "session/list", params: {} });
  const [invalid] = await bridge.fromAgent({
    jsonrpc: "2.0", id: 9, result: { sessions: "not an array" },
  });
  assert.ok("error" in invalid);
  assert.equal(invalid.error.code, -32603);
});

test("every explicit output limit warns, while ordinary completion does not", async () => {
  for (const stopReason of ["max_tokens", "max_turn_requests", "refusal"]) {
    const bridge = new DshAcpCompatibility({}, false);
    bridge.toAgent({
      jsonrpc: "2.0", id: 7, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
    });
    const [warning, result] = await bridge.fromAgent({
      jsonrpc: "2.0", id: 7, result: { stopReason },
    });
    assert.ok("method" in warning && warning.method === historyItemMethod);
    const params = warning.params as { level: string; message: string };
    assert.equal(params.level, "warning");
    assert.ok(params.message.includes(stopReason));
    assert.ok("result" in result);
  }
  const bridge = new DshAcpCompatibility({}, false);
  bridge.toAgent({
    jsonrpc: "2.0", id: 8, method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
  });
  const normal = await bridge.fromAgent({ jsonrpc: "2.0", id: 8, result: { stopReason: "end_turn" } });
  assert.equal(normal.length, 1);
  assert.ok("result" in normal[0]);
});
