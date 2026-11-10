import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { withSkillCommands } from "./skills-bridge.ts";

function harness() {
  const input = new TransformStream<AcpStreamMessage, AcpStreamMessage>();
  const messages: AcpStreamMessage[] = [];
  const warnings: string[] = [];
  const listeners = new Map<string, () => void>();
  const agent = { session: { id: "native" } };
  let cleanup = () => {};
  let cwd = "/project";
  let complete = true;
  let failed = false;
  let skills = [
    { name: "shared", description: "Shared skill", invocation: { userInvocable: true } },
    { name: "model-only", description: "Not a command", invocation: { userInvocable: false } },
  ];
  let observed = () => {};
  const ctx: Parameters<typeof withSkillCommands>[0] = {
    agents: { get: (id) => id === "native" ? agent : undefined },
    workingDirectory: { ensure: async (scope) => { assert.equal(scope, agent); return cwd; } },
    skills: { snapshot: async (options) => {
      assert.equal(options.scope, agent);
      assert.equal(options.cwd, cwd);
      if (failed) throw new Error("unreadable registry");
      return { complete, skills };
    } },
    on: (event, listener) => { listeners.set(event, listener); },
    effect: (effect) => { cleanup = effect(); },
    logger: { warn: (message) => { warnings.push(message); } },
  };
  let native: { readable: ReadableStream<AcpStreamMessage>; writable: WritableStream<AcpStreamMessage> } | undefined;
  withSkillCommands(ctx, {}, { apply: (_ctx, config) => {
    native = config.stream as NonNullable<typeof native>;
  } }, {
    readable: input.readable,
    writable: new WritableStream({
      write(message) { messages.push(message); observed(); },
    }),
  });
  assert.ok(native);
  const reader = native.readable.getReader();
  const writer = native.writable.getWriter();
  const source = input.writable.getWriter();
  return {
    messages, warnings, writer,
    cleanup: () => cleanup(),
    setSkills: (value: typeof skills) => { skills = value; },
    incomplete: () => { complete = false; },
    fail: () => { failed = true; },
    recover: () => { failed = false; complete = true; },
    move: () => { cwd = "/other"; },
    changed: () => listeners.get("skills/change")?.(),
    nextUpdate: () => new Promise<void>((resolve) => { observed = resolve; }),
    async request(method: string, id = 1) {
      const request: AcpStreamMessage = {
        jsonrpc: "2.0", id, method, params: { sessionId: "native" },
      };
      const sent = source.write(request);
      assert.deepEqual((await reader.read()).value, request);
      await sent;
    },
  };
}

test("the native scoped registry supplies user commands on new, resume and invalidation", { timeout: 5000 }, async () => {
  const h = harness();
  try {
    await h.request("session/new");
    await h.writer.write({ jsonrpc: "2.0", id: 1, result: { sessionId: "native" } });
    assert.deepEqual(h.messages.at(-1), {
      jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "native",
        update: { sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "shared", description: "Shared skill" }] },
      },
    });
    h.move();
    h.setSkills([{ name: "changed", description: "New registry winner", invocation: { userInvocable: true } }]);
    const updated = h.nextUpdate();
    h.changed();
    await updated;
    assert.match(JSON.stringify(h.messages.at(-1)), /New registry winner/);
    await h.request("session/close", 2);
    await h.writer.write({ jsonrpc: "2.0", id: 2, result: {} });
    await h.request("session/resume", 3);
    await h.writer.write({ jsonrpc: "2.0", id: 3, result: { configOptions: [] } });
    assert.match(JSON.stringify(h.messages.at(-1)), /available_commands_update/);
  } finally { h.cleanup(); }
});

test("incomplete and failed discovery is explicit and failed discovery clears stale commands", async () => {
  const h = harness();
  try {
    h.incomplete();
    await h.request("session/new");
    await h.writer.write({ jsonrpc: "2.0", id: 1, result: { sessionId: "native" } });
    assert.match(JSON.stringify(h.messages.at(-1)), /dsh\/skills_warning.*incomplete/);
    h.fail();
    await h.request("session/prompt", 2);
    assert.match(h.warnings[0], /unreadable registry/);
    assert.match(JSON.stringify(h.messages.at(-2)), /"availableCommands":\[\]/);
    assert.match(JSON.stringify(h.messages.at(-1)), /dsh\/skills_warning.*unreadable registry/);
    h.recover();
    await h.request("session/prompt", 3);
    assert.match(JSON.stringify(h.messages.at(-1)), /"dismissed":true/);
  } finally { h.cleanup(); }
});

test("failed opens and closed sessions never publish phantom commands", async () => {
  const h = harness();
  try {
    await h.request("session/new");
    await h.writer.write({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "failed" } });
    assert.equal(h.messages.length, 1);
    await h.request("session/new", 2);
    await h.writer.write({ jsonrpc: "2.0", id: 2, result: { sessionId: "native" } });
    await h.request("session/close", 3);
    await h.writer.write({ jsonrpc: "2.0", id: 3, result: {} });
    const offset = h.messages.length;
    await h.request("session/prompt", 4);
    assert.equal(h.messages.length, offset);
  } finally { h.cleanup(); }
});
