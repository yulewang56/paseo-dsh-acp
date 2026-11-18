import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import {
  DEFAULT_PRESET_ID,
  agentCatalogText,
  agentConfigOption,
  childAgentOptions,
  discoverAgentDefinitions,
  findAgentDefinition,
  resolveAgentModel,
} from "./agents.mjs";

export const name = "paseo-dsh-overlay";
export const inject = [
  "agents",
  "llm",
  "sessionPersistence",
  "sessions",
  "skills",
  "workingDirectory",
  "loader",
  "tools",
  "subagents",
  "systemPrompt",
];

const HELPER_PATH = fileURLToPath(new URL("./agent-preset.mjs", import.meta.url));

export async function apply(ctx, config = {}) {
  const requireDsh = createRequire(realpathSync(process.argv[1]));
  const acpPath = requireDsh.resolve("@deepseek-ai/dsh-acp");
  const acp = await import(pathToFileURL(acpPath).href);
  const sdk = await import(pathToFileURL(createRequire(acpPath).resolve("@agentclientprotocol/sdk")).href);
  const loader = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/cordis-plugin-loader")).href);
  const tools = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/dsh-tools")).href);
  const llm = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/dsh-llm")).href);
  const yaml = await import(pathToFileURL(requireDsh.resolve("yaml")).href);
  const helper = await import(pathToFileURL(HELPER_PATH).href);
  const entry = [...ctx.loader.entries()].find((item) => item.options.id === "acp");
  if (!entry || entry.options.name !== "@deepseek-ai/dsh-acp") {
    throw new Error("Cannot locate the official DSH ACP configuration");
  }
  const options = acp.Config(loader.interpolate(entry.ctx, entry.options.config ?? {}));
  const stream = config.stream ?? sdk.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  return withExtensions(ctx, options, acp, stream, {
    defineTool: tools.defineTool,
    createUserMessage: llm.createUserMessage,
    helperPath: HELPER_PATH,
    discoverAgentDefinitions,
    agentConfigOption,
    agentCatalogText,
    findAgentDefinition,
    resolveAgentModel,
    childAgentOptions,
    yaml,
    DEFAULT_PRESET_ID,
    async mountAgent(agent, definition) {
      if (!definition) return async () => {};
      const fiber = agent.ctx.plugin(helper, {
        prompt: definition.prompt,
        tools: definition.tools ?? null,
      });
      await fiber;
      return async () => { await fiber.dispose(); };
    },
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function catalogDigest(definitions) {
  return createHash("sha256")
    .update(definitions.map((definition) => `${definition.presetId}:${definition.contentHash}`).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function mergeAgentOption(configOptions, agentOption) {
  const base = Array.isArray(configOptions) ? configOptions.filter((option) => option?.id !== "agent") : [];
  return [...base, agentOption];
}

function requestedAgentFrom(params) {
  const value = params?._meta?._paseo?.providerOptions?.agent;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function modelOptionOf(configOptions) {
  return Array.isArray(configOptions)
    ? configOptions.find((option) => option?.id === "model" || option?.category === "model")
    : undefined;
}

function reasoningOptionOf(configOptions) {
  return Array.isArray(configOptions)
    ? configOptions.find((option) => option?.id === "reasoning_effort" || option?.category === "thought_level")
    : undefined;
}

function modelSelectionFromOptions(configOptions) {
  const option = modelOptionOf(configOptions);
  if (typeof option?.currentValue !== "string") return undefined;
  try {
    const parsed = JSON.parse(option.currentValue);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return undefined;
    const reasoning = reasoningOptionOf(configOptions);
    const effort = typeof reasoning?.currentValue === "string" && reasoning.currentValue !== "" ? reasoning.currentValue : undefined;
    return { provider: parsed[0], model: parsed[1], ...(effort ? { reasoningEffort: effort } : {}) };
  } catch {
    return undefined;
  }
}

function modelSelectionValue(provider, model) {
  return JSON.stringify([provider, model]);
}

function ensureSelectLeaf(option, value, name, groupName) {
  const entries = Array.isArray(option.options) ? option.options : [];
  const hasValue = (candidate) => "value" in candidate
    ? candidate.value === value
    : Array.isArray(candidate.options) && candidate.options.some((leaf) => leaf.value === value);
  if (hasValue) return;
  const group = groupName === undefined ? undefined : entries.find((entry) => entry.group === groupName);
  if (group && Array.isArray(group.options)) {
    group.options = [{ value, name }, ...group.options];
    return;
  }
  if (entries.some((entry) => "group" in entry)) {
    entries.push({ group: groupName ?? "custom", name: groupName ?? "Custom", options: [{ value, name }] });
    return;
  }
  entries.push({ value, name });
}

function withModelSelection(configOptions, selection) {
  const options = structuredClone(configOptions);
  const modelOption = modelOptionOf(options);
  if (!modelOption) throw new Error("DSH session does not expose a model config option");
  const value = modelSelectionValue(selection.provider, selection.model);
  ensureSelectLeaf(modelOption, value, selection.model, selection.provider);
  modelOption.currentValue = value;
  const reasoningOption = reasoningOptionOf(options);
  if (selection.reasoningEffort !== undefined) {
    if (!reasoningOption) throw new Error(`model ${selection.provider}/${selection.model} does not expose a reasoning effort option`);
    ensureSelectLeaf(reasoningOption, selection.reasoningEffort, selection.reasoningEffort);
    reasoningOption.currentValue = selection.reasoningEffort;
  } else if (reasoningOption) {
    ensureSelectLeaf(reasoningOption, "", "Provider default");
    reasoningOption.currentValue = "";
  }
  return options;
}

function sameModelSelection(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.provider === right.provider && left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort;
}

/**
 * Production wrapper. Exported so a fixture can drive the ACP stream without
 * launching DSH or calling a model.
 */
export function withExtensions(ctx, config, acp, transport, deps) {
  const pending = new Map();
  const sessions = new Map();
  const caches = new Map();
  const catalogDigests = new Map();
  const warningState = new Map();
  const pendingChildMounts = new Map();
  const childMountPromises = new Map();
  const lifetime = new AbortController();
  const writer = transport.writable.getWriter();
  let output = Promise.resolve();
  let closed = false;
  let timer;

  const send = (message) => {
    const operation = output.then(() => writer.write(message));
    output = operation.catch(() => {});
    return operation;
  };

  const refreshSkills = async (sessionId) => {
    if (closed) return;
    try {
      const agent = ctx.agents.get(sessionId);
      if (!agent) return;
      const cwd = await ctx.workingDirectory.ensure(agent);
      const snapshot = await ctx.skills.snapshot({ cwd, scope: agent, signal: lifetime.signal });
      const commands = snapshot.skills
        .filter((skill) => skill.invocation.userInvocable)
        .map(({ name, description }) => ({ name, description }));
      await send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: commands },
        },
      });
      const warning = snapshot.complete
        ? undefined
        : "DSH skill discovery is incomplete; only confirmed skills are listed.";
      await publishWarning(sessionId, "skills", warning);
    } catch (error) {
      if (closed) return;
      ctx.logger.warn(`DSH skill refresh failed: ${String(error)}`);
      await send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: [] },
        },
      });
      await publishWarning(sessionId, "skills", `DSH skill discovery failed: ${String(error)}`);
    }
  };

  const publishWarning = async (sessionId, kind, message) => {
    if (closed) return;
    const current = warningState.get(sessionId) ?? {};
    if (message === undefined) {
      if (current[kind] === undefined) return;
      current[kind] = undefined;
      warningState.set(sessionId, current);
      await send({
        jsonrpc: "2.0",
        method: kind === "skills" ? "dsh/skills_warning" : "dsh/agents_warning",
        params: kind === "skills"
          ? { sessionId, message: "DSH skill discovery completed.", dismissed: true }
          : { sessionId, message: "DSH agent discovery completed.", dismissed: true },
      });
      return;
    }
    if (current[kind] === message) return;
    current[kind] = message;
    warningState.set(sessionId, current);
    await send({
      jsonrpc: "2.0",
      method: kind === "skills" ? "dsh/skills_warning" : "dsh/agents_warning",
      params: { sessionId, message },
    });
  };

  const ensureAgents = async (cwd, signal) => {
    const discovery = await deps.discoverAgentDefinitions({ cwd, env: process.env, signal, yaml: deps.yaml });
    const digest = catalogDigest(discovery.agents);
    const cached = caches.get(cwd);
    if (cached?.digest === digest) return cached;
    const entry = {
      digest,
      agents: discovery.agents,
      warnings: [...discovery.warnings],
    };
    caches.set(cwd, entry);
    return entry;
  };

  const definitionFor = (state, value) => {
    if (value === deps.DEFAULT_PRESET_ID) return undefined;
    return state.agents.find((definition) => definition.presetId === value);
  };

  const rootChangeAllowed = (agent) => {
    const boundary = ctx.agents.turnBoundaryOf(agent.session);
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0;
  };

  const applyRootModel = (agent, state, selection) => {
    if (selection === undefined) return false;
    if (!agent.model || typeof agent.model.select !== "function") {
      throw new Error("DSH agent model control is unavailable");
    }
    const options = withModelSelection(state.configOptions, selection);
    agent.model.select(selection);
    state.configOptions = options;
    return true;
  };

  const installRootMount = async (state, agent, definition) => {
    const previousMount = state.rootMount;
    const previousDefinition = state.rootDefinition;
    if (previousMount) {
      try {
        await previousMount();
      } catch (error) {
        ctx.logger.warn(`DSH root agent composition cleanup failed: ${String(error)}`);
      }
    }
    state.rootMount = undefined;
    state.rootDefinition = undefined;
    if (!definition) return;
    try {
      state.rootMount = await deps.mountAgent(agent, definition);
      state.rootDefinition = definition;
    } catch (error) {
      if (previousDefinition) {
        try {
          state.rootMount = await deps.mountAgent(agent, previousDefinition);
          state.rootDefinition = previousDefinition;
        } catch (restoreError) {
          ctx.logger.warn(`DSH root agent composition restore failed: ${String(restoreError)}`);
        }
      }
      throw error;
    }
  };

  const attachAgent = async (sessionId, cwd, result, existing, requested, resume) => {
    const entry = await ensureAgents(cwd);
    const state = existing ?? {
      cwd,
      configOptions: [],
      agents: [],
      agentValue: DEFAULT_PRESET_ID,
      agentOption: undefined,
      digest: undefined,
      rootMount: undefined,
      rootDefinition: undefined,
      baseSelection: undefined,
      modelOverridden: false,
      pendingInitialAgent: false,
      queue: Promise.resolve(),
    };
    state.cwd = cwd;
    state.agents = entry.agents;
    state.digest = entry.digest;
    state.configOptions = Array.isArray(result?.configOptions) ? result.configOptions : state.configOptions;
    state.queue ??= Promise.resolve();
    const currentSelection = modelSelectionFromOptions(state.configOptions);
    state.baseSelection = currentSelection;
    const value = typeof requested === "string" && requested !== "" ? requested : DEFAULT_PRESET_ID;
    const definition = definitionFor(state, value);
    if (value !== DEFAULT_PRESET_ID && !definition) {
      throw new Error(`The selected agent definition is no longer available: ${value}`);
    }
    if (definition && !definition.availableForRoot) {
      throw new Error(`${definition.name} cannot be selected for a root agent: ${definition.unavailableForRoot}`);
    }
    const agent = ctx.agents.get(sessionId);
    if (definition && !agent) throw new Error("DSH agent is unavailable for agent composition");
    let modelApplied = false;
    let selection;
    if (!resume && definition?.model !== undefined) {
      selection = await deps.resolveAgentModel(definition, ctx.llm);
      if (!selection) throw new Error(`agent "${definition.id}" has no resolvable model`);
      if (!currentSelection) throw new Error("DSH session has no committed model selection to restore");
      modelApplied = applyRootModel(agent, state, selection);
    }
    try {
      await installRootMount(state, agent, definition);
    } catch (error) {
      if (modelApplied && currentSelection) {
        applyRootModel(agent, state, currentSelection);
      }
      throw error;
    }
    state.agentValue = value;
    state.modelOverridden = Boolean(definition?.model);
    state.pendingInitialAgent = !resume && definition !== undefined;
    state.agentOption = deps.agentConfigOption(entry.agents, value);
    state.configOptions = mergeAgentOption(state.configOptions, state.agentOption);
    sessions.set(sessionId, state);
    if (result && typeof result === "object") result.configOptions = state.configOptions;
    if (entry.warnings.length > 0) {
      await publishWarning(sessionId, "agents", entry.warnings.slice(0, 3).join("; "));
    } else {
      await publishWarning(sessionId, "agents", undefined);
    }
    return state;
  };

  const fail = async (id, message) => {
    await send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message },
    });
  };

  const doSetAgent = async (id, params) => {
    const sessionId = params.sessionId;
    const state = sessions.get(sessionId);
    if (!state) {
      await fail(id, `Unknown session: ${sessionId}`);
      return;
    }
    if (typeof params.value !== "string" || params.value.trim() === "") {
      await fail(id, "Agent selection requires a non-empty agent id");
      return;
    }
    const requested = params.value;
    const agent = ctx.agents.get(sessionId);
    if (!agent) {
      await fail(id, `Unknown session: ${sessionId}`);
      return;
    }
    try {
      const entry = await ensureAgents(state.cwd);
      state.agents = entry.agents;
      const definition = definitionFor(state, requested);
      if (requested !== deps.DEFAULT_PRESET_ID && !definition) {
        throw new Error(`Unknown agent definition: ${requested}`);
      }
      if (definition && !definition.availableForRoot) {
        throw new Error(`${definition.name} cannot be selected for a root agent: ${definition.unavailableForRoot}`);
      }
      if (requested !== state.agentValue && !rootChangeAllowed(agent)) {
        throw new Error("Agent can only be selected before this session's first turn; create a new agent to change it");
      }
      const previousSelection = modelSelectionFromOptions(state.configOptions);
      let targetSelection;
      if (requested === deps.DEFAULT_PRESET_ID) targetSelection = state.baseSelection;
      else if (definition.model !== undefined) {
        targetSelection = await deps.resolveAgentModel(definition, ctx.llm);
        if (!targetSelection) throw new Error(`agent "${definition.name}" has no resolvable model`);
      } else if (state.modelOverridden) {
        targetSelection = state.baseSelection;
      }
      if (targetSelection !== undefined && !previousSelection) {
        throw new Error("DSH session has no committed model selection to restore");
      }
      const needsChange = requested !== state.agentValue;
      const initialReapply = !needsChange && state.pendingInitialAgent;
      const modelChanged = targetSelection !== undefined && !sameModelSelection(previousSelection, targetSelection);
      let modelApplied = false;
      try {
        if ((needsChange || initialReapply) && modelChanged) modelApplied = applyRootModel(agent, state, targetSelection);
        if (needsChange) await installRootMount(state, agent, definition);
      } catch (error) {
        if ((needsChange || initialReapply) && modelChanged && modelApplied && previousSelection) {
          applyRootModel(agent, state, previousSelection);
        }
        throw error;
      }
      if (needsChange) {
        state.agentValue = requested;
        state.modelOverridden = definition?.model !== undefined;
        state.pendingInitialAgent = false;
      } else if (initialReapply) {
        state.pendingInitialAgent = false;
      }
      state.agentOption = deps.agentConfigOption(entry.agents, requested);
      state.configOptions = mergeAgentOption(state.configOptions, state.agentOption);
      if (entry.warnings.length > 0) {
        await publishWarning(sessionId, "agents", entry.warnings.slice(0, 3).join("; "));
      }
      await send({ jsonrpc: "2.0", id, result: { configOptions: state.configOptions } });
      await publishConfig(sessionId);
    } catch (error) {
      ctx.logger.warn(`DSH agent selection failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      await fail(id, `Agent selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setAgent = async (id, params) => {
    const state = sessions.get(params?.sessionId);
    if (!state) {
      await fail(id, `Unknown session: ${params?.sessionId}`);
      return;
    }
    const operation = state.queue.then(() => doSetAgent(id, params));
    state.queue = operation.catch(() => {});
    await operation;
  };

  const refreshAgents = async (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) return;
    const previous = state.agentOption?.currentValue;
    const previousDigest = state.digest;
    const entry = await ensureAgents(state.cwd, lifetime.signal);
    state.agents = entry.agents;
    state.digest = entry.digest;
    state.agentOption = deps.agentConfigOption(entry.agents, state.agentValue);
    state.configOptions = mergeAgentOption(state.configOptions, state.agentOption);
    if (previous !== state.agentOption.currentValue || previousDigest !== entry.digest) {
      await send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: state.configOptions },
        },
      });
    }
  };

  const refreshSession = async (sessionId) => {
    await refreshSkills(sessionId);
    await refreshAgents(sessionId);
  };

  const publishConfig = async (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) return;
    await send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: state.configOptions },
      },
    });
  };

  ctx.on("skills/change", () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const id of sessions.keys()) {
        void refreshSkills(id).catch((error) => ctx.logger.warn(`DSH skill update failed: ${String(error)}`));
      }
    }, 50);
  });

  const takePendingChild = (agent, messages) => {
    const parentId = agent.session.header.parentSession;
    if (parentId === undefined) return undefined;
    const queue = pendingChildMounts.get(String(parentId));
    if (!queue || queue.length === 0) return undefined;
    const text = messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    let index = queue.findIndex((entry) => text.includes(entry.task));
    if (index < 0) index = 0;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) pendingChildMounts.delete(String(parentId));
    return entry;
  };

  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    if (!childMountPromises.has(agent.session.id)) {
      const pending = takePendingChild(agent, messages);
      if (pending) {
        pending.claimed = true;
        const mount = deps.mountAgent(agent, pending.definition).then(() => undefined);
        childMountPromises.set(agent.session.id, mount);
        try {
          await mount;
        } catch (error) {
          childMountPromises.delete(agent.session.id);
          ctx.logger.warn(`DSH child agent composition failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          throw error;
        }
      }
    }
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const entry = await ensureAgents(cwd, signal);
    const text = deps.agentCatalogText(entry.agents);
    if (text === "") return decision;
    const digest = catalogDigest(entry.agents);
    if (catalogDigests.get(agent.session.id) === digest) return decision;
    catalogDigests.set(agent.session.id, digest);
    signal.throwIfAborted();
    return {
      ...decision,
      messages: [
        ...decision.messages,
        deps.createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      ],
    };
  });

  const delegate = deps.defineTool({
    name: "delegate_to_agent",
    description: "Delegate a self-contained task to a configured agent definition in a fresh child session. Use an exact agent id from the available_agents catalog. The child gets its own conversation, persona, and tool restrictions; the result arrives as a completion notice. This does not change the current session's model, reasoning effort, or permissions.",
    parameters: {
      agent: { type: "string", required: true, description: "Exact agent id from available_agents." },
      task: { type: "string", required: true, description: "Self-contained task for the child agent." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          childId: { type: "string", required: true },
          agent: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `started subagent ${value.childId} using agent ${value.agent}` }],
    },
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const entry = await ensureAgents(cwd, exec.signal);
      const definition = deps.findAgentDefinition(entry.agents, args.agent);
      if (!definition) throw new Error(`Unknown agent definition: ${args.agent}`);
      if (!definition.modelInvocable) throw new Error(`Agent "${definition.id}" is not available for model invocation`);
      if (!definition.availableForChild) {
        throw new Error(`Agent "${definition.id}" is not executable: ${definition.unavailableForChild}`);
      }
      const selection = await deps.resolveAgentModel(definition, ctx.llm);
      const agentOptions = deps.childAgentOptions(definition, selection);
      const parentId = String(exec.agent.id);
      const pending = { definition, task: args.task, claimed: false };
      const queue = pendingChildMounts.get(parentId) ?? [];
      queue.push(pending);
      pendingChildMounts.set(parentId, queue);
      let activation;
      try {
        activation = await ctx.subagents.startActivation({
          provider: "spawn",
          label: definition.name,
          request: {
            parent: exec.agent,
            prompt: [{ type: "text", text: args.task }],
            ...(agentOptions ? { agentOptions } : {}),
          },
          signal: exec.signal,
          delivery: "parent",
        });
      } catch (error) {
        const remaining = (pendingChildMounts.get(parentId) ?? []).filter((entry) => entry !== pending);
        if (remaining.length === 0) pendingChildMounts.delete(parentId);
        else pendingChildMounts.set(parentId, remaining);
        throw error;
      }
      const child = ctx.agents.get(activation.childId);
      if (!child) {
        await activation.dispose();
        throw new Error("The delegated child is unavailable before agent composition");
      }
      const existingMount = childMountPromises.get(child.session.id);
      if (existingMount) {
        try {
          await existingMount;
        } catch (error) {
          await activation.dispose();
          throw new Error(`Agent composition failed before the child's first step: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        const remaining = (pendingChildMounts.get(parentId) ?? []).filter((entry) => entry !== pending);
        if (remaining.length === 0) pendingChildMounts.delete(parentId);
        else pendingChildMounts.set(parentId, remaining);
        const boundary = ctx.agents.turnBoundaryOf(child.session);
        if (boundary.lastStepStartSeq !== null) {
          await activation.dispose();
          throw new Error("The delegated child started before its agent composition could be applied");
        }
        const mount = deps.mountAgent(child, definition).then(() => undefined);
        childMountPromises.set(child.session.id, mount);
        try {
          await mount;
        } catch (error) {
          childMountPromises.delete(child.session.id);
          await activation.dispose();
          throw new Error(`Agent composition failed before the child's first step: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { childId: String(activation.childId), agent: definition.id };
    },
  });
  ctx.effect(() => ctx.tools.register(delegate), "paseo-agent-definition.delegate");

  ctx.effect(() => () => {
    closed = true;
    lifetime.abort();
    clearTimeout(timer);
    for (const state of sessions.values()) if (state.rootMount) void state.rootMount();
    pending.clear();
    sessions.clear();
    caches.clear();
    catalogDigests.clear();
    warningState.clear();
  });

  const readable = transport.readable.pipeThrough(new TransformStream({
    async transform(message, controller) {
      if (!isRecord(message) || !("method" in message)) {
        controller.enqueue(message);
        return;
      }
      if ("id" in message) {
        const params = isRecord(message.params) ? message.params : {};
        if (message.method === "session/new") {
          pending.set(message.id, {
            method: message.method,
            cwd: params.cwd,
            agent: requestedAgentFrom(params),
          });
        } else if (message.method === "session/resume" || message.method === "session/close") {
          pending.set(message.id, {
            method: message.method,
            sessionId: params.sessionId,
            agent: requestedAgentFrom(params),
          });
        } else if (message.method === "session/set_config_option") {
          if (params.configId === "agent") {
            await setAgent(message.id, params);
            return;
          }
          const state = sessions.get(params.sessionId);
          if (state && (params.configId === "model" || params.configId === "reasoning_effort")) {
            await state.queue.catch(() => {});
          }
          pending.set(message.id, {
            method: message.method,
            sessionId: params.sessionId,
            configId: params.configId,
          });
        } else if (message.method === "session/prompt") {
          await refreshSession(params.sessionId);
        }
      }
      controller.enqueue(message);
    },
  }));

  const writable = new WritableStream({
    async write(message) {
      let openedSessionId;
      if (isRecord(message) && "id" in message && !("method" in message)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (request) {
          try {
            if (request.method === "session/new" && isRecord(message.result)) {
              const sessionId = message.result.sessionId;
              if (typeof sessionId === "string") {
                const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
                await attachAgent(sessionId, cwd, message.result, undefined, request.agent, false);
                openedSessionId = sessionId;
              }
            } else if (request.method === "session/resume" && isRecord(message.result)) {
              const sessionId = typeof message.result.sessionId === "string"
                ? message.result.sessionId
                : request.sessionId;
              if (typeof sessionId === "string") {
                const agent = ctx.agents.get(sessionId);
                const cwd = agent ? await ctx.workingDirectory.ensure(agent) : process.cwd();
                const existing = sessions.get(sessionId);
                await attachAgent(sessionId, cwd, message.result, existing, request.agent, true);
                openedSessionId = sessionId;
              }
            } else if (request.method === "session/set_config_option" && isRecord(message.result)) {
              const state = sessions.get(request.sessionId);
              if (state) {
                state.configOptions = Array.isArray(message.result.configOptions)
                  ? message.result.configOptions
                  : state.configOptions;
                state.agentOption = deps.agentConfigOption(state.agents, state.agentValue);
                state.configOptions = mergeAgentOption(state.configOptions, state.agentOption);
                if (request.configId === "model" || request.configId === "reasoning_effort") {
                  state.baseSelection = modelSelectionFromOptions(state.configOptions) ?? state.baseSelection;
                }
                message.result.configOptions = state.configOptions;
              }
            } else if (request.method === "session/close" && request.sessionId) {
              const state = sessions.get(request.sessionId);
              if (state?.rootMount) await state.rootMount();
              sessions.delete(request.sessionId);
              catalogDigests.delete(request.sessionId);
              warningState.delete(request.sessionId);
            }
          } catch (error) {
            await send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32602,
                message: error instanceof Error ? error.message : String(error),
              },
            });
            return;
          }
        }
      } else if (isRecord(message) && message.method === "session/update" && isRecord(message.params)) {
        const params = message.params;
        const state = sessions.get(params.sessionId);
        if (state && isRecord(params.update) && params.update.sessionUpdate === "config_option_update") {
          state.configOptions = Array.isArray(params.update.configOptions)
            ? params.update.configOptions
            : state.configOptions;
          state.agentOption = deps.agentConfigOption(state.agents, state.agentValue);
          state.configOptions = mergeAgentOption(state.configOptions, state.agentOption);
          params.update.configOptions = state.configOptions;
        }
      }
      await send(message);
      // ACP clients must know the native session id before receiving commands.
      if (openedSessionId) {
        await refreshSkills(openedSessionId);
        await publishConfig(openedSessionId);
      }
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });

  acp.apply(ctx, {
    ...config,
    stream: { readable, writable },
  });
}
