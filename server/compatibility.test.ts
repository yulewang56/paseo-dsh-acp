import assert from "node:assert/strict";
import { test } from "node:test";
import { DshAcpCompatibility } from "./compatibility.ts";
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
