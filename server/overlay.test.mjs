import assert from "node:assert/strict";
import { test } from "node:test";
import * as yaml from "yaml";
import {
  DEFAULT_PRESET_ID,
  agentConfigOption,
  agentCatalogText,
  agentControlChoices,
  childAgentOptions,
  findAgentDefinition,
  resolveAgentModel,
} from "./agents.mjs";
import { withExtensions } from "./overlay.mjs";

const FLASH = JSON.stringify(["deepseek-official", "deepseek/deepseek-v4-flash"]);
const PRO = JSON.stringify(["deepseek-official", "deepseek/deepseek-v4-pro"]);

function configOptions(model = FLASH, effort = "high") {
  return [
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: model,
      options: [{
        group: "deepseek-official", name: "DeepSeek",
        options: [
          { value: FLASH, name: "DeepSeek V4 Flash" },
          { value: PRO, name: "DeepSeek V4 Pro" },
        ],
      }],
    },
    {
      id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
      currentValue: effort,
      options: [
        { value: "", name: "Provider default" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

function definition(id, extra = {}) {
  return {
    id,
    name: id,
    description: `${id} description`,
    prompt: `You are ${id}.`,
    userInvocable: true,
    modelInvocable: true,
    source: "native",
    path: `/project/.agents/agents/${id}.md`,
    rank: 200,
    projectRoot: "/project",
    contentHash: `hash-${id}`,
    presetId: `dsh-agent-abc12345-${id}`,
    rawFrontmatter: `name: ${id}`,
    rawData: { name: id },
    unsupportedFields: [],
    warnings: [],
    toolIssues: [],
    modelIssues: [],
    availableForRoot: true,
    availableForChild: true,
    ...extra,
  };
}

const reviewer = definition("reviewer", {
  description: "Reviews changes",
  tools: { allow: ["read"] },
  provider: "deepseek-official",
  model: "deepseek/deepseek-v4-pro",
  reasoningEffort: "low",
  maxTokens: undefined,
});
const refuter = definition("refuter", { description: "Finds counterexamples" });
const maxTokensAgent = definition("max-tokens", {
  description: "Child-only token cap",
  provider: "deepseek-official",
  model: "deepseek/deepseek-v4-pro",
  maxTokens: 10,
  availableForRoot: false,
  unavailableForRoot: "maxTokens is child-only and is not applied to a root agent",
});
const unsupported = definition("unsupported", {
  description: "Uses hooks",
  availableForRoot: false,
  availableForChild: false,
  unavailableForRoot: "hooks: hooks are not executed by DSH",
  unavailableForChild: "hooks: hooks are not executed by DSH",
  unsupportedFields: [{ field: "hooks", reason: "hooks are not executed by DSH" }],
});

const allDefinitions = [reviewer, refuter, maxTokensAgent, unsupported];

function mockLlm() {
  return {
    listProviders: async () => [{ id: "deepseek-official" }],
    listModels: async (provider) => provider === "deepseek-official"
      ? [{ id: "deepseek/deepseek-v4-flash" }, { id: "deepseek/deepseek-v4-pro" }]
      : [],
    resolveModelInfo: async (provider, model) => {
      if (provider !== "deepseek-official" || !["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"].includes(model)) {
        throw new Error("not found");
      }
      return { reasoning: { efforts: [{ id: "low" }, { id: "high" }] } };
    },
  };
}

function harness(options = {}) {
  const input = new TransformStream();
  const outputs = [];
  const nativeRequests = [];
  const mounted = [];
  const disposed = [];
  const starts = [];
  const modelSelections = [];
  const listeners = new Map();
  let native;
  let cleanup;
  let locked = options.locked ?? false;
  let tool;
  let model = { provider: "deepseek-official", model: "deepseek/deepseek-v4-flash", reasoningEffort: "high" };
  let definitionList = options.definitions ?? allDefinitions;
  let throwMountFor = options.throwMountFor;
  const agent = {
    id: "native",
    session: { id: "native", header: {} },
    ctx: { id: "native-ctx" },
    model: {
      current: () => model,
      select: (selection) => { model = { ...selection }; modelSelections.push({ ...selection }); },
    },
  };
  const child = {
    id: "child-1",
    session: { id: "child-1", header: { parentSession: "native" } },
    ctx: { id: "child-ctx" },
  };
  const ctx = {
    agents: {
      get: (id) => id === "native" ? agent : id === "child-1" ? child : undefined,
      turnBoundaryOf: (session) => session.id === "child-1"
        ? { openTurnStartSeq: 1, lastStepStartSeq: null, lastTurn: 1 }
        : locked
          ? { openTurnStartSeq: 1, lastStepStartSeq: 1, lastTurn: 1 }
          : { openTurnStartSeq: null, lastStepStartSeq: null, lastTurn: 0 },
    },
    workingDirectory: { ensure: async () => "/project" },
    skills: { snapshot: async () => ({ complete: true, skills: [] }) },
    llm: mockLlm(),
    tools: {
      register: (registered) => { tool = registered; return () => {}; },
      definitions: () => [],
    },
    subagents: {
      startActivation: async (spec) => {
        starts.push(spec);
        return { childId: "child-1", dispose: async () => {} };
      },
    },
    logger: { warn: () => {} },
    on: (event, listener) => { listeners.set(event, listener); },
    effect: (effect) => { cleanup = effect(); },
  };
  const deps = {
    defineTool: (value) => value,
    createUserMessage: (value) => value,
    helperPath: "/plugin/agent-preset.mjs",
    yaml,
    discoverAgentDefinitions: async () => ({ agents: definitionList, warnings: [] }),
    agentConfigOption,
    agentControlChoices,
    agentCatalogText,
    findAgentDefinition,
    resolveAgentModel,
    childAgentOptions,
    DEFAULT_PRESET_ID,
    async mountAgent(target, value) {
      if (value.id === throwMountFor) throw new Error("mount failed");
      const entry = { agentId: target.id, definition: value };
      mounted.push(entry);
      return async () => { disposed.push(entry); };
    },
  };
  const acp = { apply(_ctx, config) { native = config.stream; } };
  const output = new WritableStream({ write(message) { outputs.push(message); } });
  withExtensions(ctx, {}, acp, { readable: input.readable, writable: output }, deps);
  assert.ok(native);
  const nativeReader = native.readable.getReader();
  const nativeWriter = native.writable.getWriter();
  const source = input.writable.getWriter();
  const nativeQueue = [];
  const nativeWaiters = [];
  void (async () => {
    while (true) {
      const { done, value } = await nativeReader.read();
      if (done) return;
      nativeRequests.push(value);
      const waiter = nativeWaiters.shift();
      if (waiter) waiter(value);
      else nativeQueue.push(value);
    }
  })();
  const nextNative = async () => {
    if (nativeQueue.length > 0) return nativeQueue.shift();
    return await new Promise((resolve) => nativeWaiters.push(resolve));
  };
  const nextOutput = async (predicate = () => true) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const found = outputs.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for output; saw ${JSON.stringify(outputs)}`);
  };
  const send = async (message) => { await source.write(message); };
  return {
    outputs, nativeRequests, mounted, disposed, starts, modelSelections, listeners, ctx, agent,
    nativeWriter, nextNative, nextOutput, send,
    get tool() { return tool; },
    get model() { return model; },
    lock() { locked = true; },
    setThrowMount(id) { throwMountFor = id; },
    setDefinitions(value) { definitionList = value; },
    cleanup() { cleanup?.(); },
  };
}

async function openSession(h, id = 1, requested, options = configOptions()) {
  await h.send({
    jsonrpc: "2.0", id, method: "session/new",
    params: {
      cwd: "/project",
      ...(requested ? { _meta: { _paseo: { providerOptions: { agent: requested } } } } : {}),
    },
  });
  assert.equal((await h.nextNative()).method, "session/new");
  await h.nativeWriter.write({ jsonrpc: "2.0", id, result: { sessionId: "native", configOptions: options } });
  return await h.nextOutput((message) => message.id === id && message.result);
}

const option = (result, id) => result.result.configOptions.find((entry) => entry.id === id);

test("publishes skills after successful new and resume responses", async () => {
  const h = harness();
  h.ctx.skills.snapshot = async () => ({ complete: true, skills: [
    { name: "paseo", description: "Paseo operations", invocation: { userInvocable: true } },
    { name: "internal", description: "Internal", invocation: { userInvocable: false } },
  ] });
  const isCommands = (message) => message.params?.update?.sessionUpdate === "available_commands_update";
  try {
    await openSession(h);
    const initial = h.outputs.find(isCommands);
    assert.deepEqual(initial?.params.update.availableCommands, [{ name: "paseo", description: "Paseo operations" }]);
    assert.ok(h.outputs.indexOf(initial) > h.outputs.findIndex((message) => message.id === 1));
    h.outputs.length = 0;
    await h.send({ jsonrpc: "2.0", id: 2, method: "session/resume", params: { sessionId: "native" } });
    await h.nextNative();
    await h.nativeWriter.write({ jsonrpc: "2.0", id: 2, result: { configOptions: [] } });
    assert.ok(h.outputs.findIndex(isCommands) > h.outputs.findIndex((message) => message.id === 2));
    h.ctx.skills.snapshot = async () => { throw new Error("unreadable registry"); };
    await h.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "native" } });
    const warning = await h.nextOutput((message) => message.method === "dsh/skills_warning");
    assert.deepEqual(h.outputs.filter(isCommands).at(-1).params.update.availableCommands, []);
    assert.match(warning.params.message, /unreadable registry/);
  } finally { h.cleanup(); }
});

test("selecting an agent applies its model and effort to the root and syncs config options", async () => {
  const h = harness();
  try {
    const opened = await openSession(h);
    assert.equal(option(opened, "agent").currentValue, DEFAULT_PRESET_ID);
    assert.equal(option(opened, "model").currentValue, FLASH);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: reviewer.presetId },
    });
    const selected = await h.nextOutput((message) => message.id === 2 && message.result);
    assert.deepEqual(h.modelSelections.at(-1), {
      provider: "deepseek-official", model: "deepseek/deepseek-v4-pro", reasoningEffort: "low",
    });
    assert.equal(option(selected, "model").currentValue, PRO);
    assert.equal(option(selected, "reasoning_effort").currentValue, "low");
    assert.equal(option(selected, "agent").currentValue, reviewer.presetId);
    assert.deepEqual(h.mounted.map((entry) => entry.definition.presetId), [reviewer.presetId]);
    assert.equal(h.nativeRequests.length, 1, "agent selection is not forwarded to the official ACP handler");
  } finally { h.cleanup(); }
});

test("Default restores the base model and effort and unmounts the persona", async () => {
  const h = harness();
  try {
    await openSession(h);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: reviewer.presetId },
    });
    await h.nextOutput((message) => message.id === 2 && message.result);
    await h.send({
      jsonrpc: "2.0", id: 3, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: DEFAULT_PRESET_ID },
    });
    const restored = await h.nextOutput((message) => message.id === 3 && message.result);
    assert.equal(option(restored, "model").currentValue, FLASH);
    assert.equal(option(restored, "reasoning_effort").currentValue, "high");
    assert.equal(option(restored, "agent").currentValue, DEFAULT_PRESET_ID);
    assert.equal(h.modelSelections.at(-1).model, "deepseek/deepseek-v4-flash");
    assert.equal(h.disposed.length, 1);
  } finally { h.cleanup(); }
});

test("applies a requested definition at session creation and reapplies its model after initial Paseo model config", async () => {
  const h = harness();
  try {
    const opened = await openSession(h, 1, reviewer.presetId);
    assert.equal(option(opened, "agent").currentValue, reviewer.presetId);
    assert.equal(option(opened, "model").currentValue, PRO);
    assert.equal(option(opened, "reasoning_effort").currentValue, "low");
    assert.deepEqual(h.mounted.map((entry) => entry.definition.presetId), [reviewer.presetId]);

    // Paseo applies its own configured model after session/new, then its initial
    // agent setting. The definition model must win after that sequence.
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "model", value: FLASH },
    });
    assert.equal((await h.nextNative()).method, "session/set_config_option");
    await h.nativeWriter.write({ jsonrpc: "2.0", id: 2, result: { configOptions: configOptions(FLASH, "high") } });
    await h.nextOutput((message) => message.id === 2 && message.result);
    await h.send({
      jsonrpc: "2.0", id: 3, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: reviewer.presetId },
    });
    const reapplied = await h.nextOutput((message) => message.id === 3 && message.result);
    assert.equal(option(reapplied, "model").currentValue, PRO);
    assert.equal(option(reapplied, "reasoning_effort").currentValue, "low");
  } finally { h.cleanup(); }
});

test("resume remounts persona without overwriting a persisted model", async () => {
  const h = harness();
  try {
    await openSession(h);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/resume",
      params: { sessionId: "native", _meta: { _paseo: { providerOptions: { agent: reviewer.presetId } } } },
    });
    assert.equal((await h.nextNative()).method, "session/resume");
    await h.nativeWriter.write({ jsonrpc: "2.0", id: 2, result: { sessionId: "native", configOptions: configOptions(FLASH, "high") } });
    const resumed = await h.nextOutput((message) => message.id === 2 && message.result);
    assert.equal(option(resumed, "agent").currentValue, reviewer.presetId);
    assert.equal(option(resumed, "model").currentValue, FLASH);
    assert.equal(option(resumed, "reasoning_effort").currentValue, "high");
    assert.deepEqual(h.modelSelections, []);
    assert.deepEqual(h.mounted.map((entry) => entry.definition.presetId), [reviewer.presetId]);
  } finally { h.cleanup(); }
});

test("rejects post-first-turn changes and preserves the old agent, model, and persona", async () => {
  const h = harness();
  try {
    await openSession(h);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: reviewer.presetId },
    });
    await h.nextOutput((message) => message.id === 2 && message.result);
    h.lock();
    const before = h.model;
    await h.send({
      jsonrpc: "2.0", id: 3, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: refuter.presetId },
    });
    const rejected = await h.nextOutput((message) => message.id === 3);
    assert.match(rejected.error.message, /before this session's first turn/);
    assert.deepEqual(h.model, before);
    assert.deepEqual(h.mounted.map((entry) => entry.definition.presetId), [reviewer.presetId]);
    assert.equal(h.disposed.length, 0);
  } finally { h.cleanup(); }
});

test("rolls back a model change when persona mounting fails", async () => {
  const h = harness({ throwMountFor: "reviewer" });
  try {
    await openSession(h);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: reviewer.presetId },
    });
    const rejected = await h.nextOutput((message) => message.id === 2);
    assert.match(rejected.error.message, /mount failed/);
    assert.equal(h.model.model, "deepseek/deepseek-v4-flash");
    assert.equal(h.model.reasoningEffort, "high");
    assert.equal(h.mounted.length, 0);
  } finally { h.cleanup(); }
});

test("keeps unsupported and child-only definitions visible with unavailable reasons and rejects them", async () => {
  const h = harness();
  try {
    const opened = await openSession(h);
    const choices = option(opened, "agent").options;
    assert.match(choices.find((choice) => choice.value === unsupported.presetId).description, /Unavailable/);
    assert.match(choices.find((choice) => choice.value === maxTokensAgent.presetId).description, /child-only/);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: unsupported.presetId },
    });
    assert.match((await h.nextOutput((message) => message.id === 2)).error.message, /hooks/);
    await h.send({
      jsonrpc: "2.0", id: 3, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: maxTokensAgent.presetId },
    });
    assert.match((await h.nextOutput((message) => message.id === 3)).error.message, /child-only/);
    assert.equal(h.model.model, "deepseek/deepseek-v4-flash");
    assert.equal(h.mounted.length, 0);
    assert.doesNotMatch(agentCatalogText([unsupported]), /unsupported/);
    assert.match(agentCatalogText([maxTokensAgent]), /max-tokens/);
  } finally { h.cleanup(); }
});

test("delegates a child with resolved model and rejects non-executable definitions", async () => {
  const h = harness();
  try {
    await openSession(h);
    const result = await h.tool.execute(
      { agent: "max-tokens", task: "Check the diff" },
      { agent: h.agent, signal: new AbortController().signal },
    );
    assert.deepEqual(result, { childId: "child-1", agent: "max-tokens" });
    assert.deepEqual(h.starts[0].request.agentOptions, {
      provider: "deepseek-official", model: "deepseek/deepseek-v4-pro", maxTokens: 10,
    });
    assert.deepEqual(h.mounted.map((entry) => [entry.agentId, entry.definition.presetId]), [["child-1", maxTokensAgent.presetId]]);
    await assert.rejects(
      () => h.tool.execute({ agent: "unsupported", task: "No" }, { agent: h.agent, signal: new AbortController().signal }),
      /not executable/,
    );
  } finally { h.cleanup(); }
});

test("a manual model change becomes the new Default baseline", async () => {
  const h = harness();
  try {
    await openSession(h);
    await h.send({
      jsonrpc: "2.0", id: 2, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: reviewer.presetId },
    });
    await h.nextOutput((message) => message.id === 2 && message.result);
    await h.send({
      jsonrpc: "2.0", id: 3, method: "session/set_config_option",
      params: { sessionId: "native", configId: "model", value: FLASH },
    });
    await h.nextNative();
    await h.nativeWriter.write({ jsonrpc: "2.0", id: 3, result: { configOptions: configOptions(FLASH, "high") } });
    await h.nextOutput((message) => message.id === 3 && message.result);
    await h.send({
      jsonrpc: "2.0", id: 4, method: "session/set_config_option",
      params: { sessionId: "native", configId: "agent", value: DEFAULT_PRESET_ID },
    });
    const restored = await h.nextOutput((message) => message.id === 4 && message.result);
    assert.equal(option(restored, "model").currentValue, FLASH);
    assert.equal(option(restored, "reasoning_effort").currentValue, "high");
  } finally { h.cleanup(); }
});

test("serializes concurrent agent selections", async () => {
  const h = harness();
  try {
    await openSession(h);
    await Promise.all([
      h.send({ jsonrpc: "2.0", id: 2, method: "session/set_config_option", params: { sessionId: "native", configId: "agent", value: reviewer.presetId } }),
      h.send({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId: "native", configId: "agent", value: refuter.presetId } }),
    ]);
    const final = await h.nextOutput((message) => message.id === 3 && message.result);
    assert.equal(option(final, "agent").currentValue, refuter.presetId);
    assert.deepEqual(h.mounted.map((entry) => entry.definition.presetId), [reviewer.presetId, refuter.presetId]);
  } finally { h.cleanup(); }
});
