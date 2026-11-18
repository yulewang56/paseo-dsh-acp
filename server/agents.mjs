import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * A named agent definition, parsed from a Markdown file.
 *
 * Discovery roots are DSH-specific plus Claude Code and Copilot compatibility
 * roots. Parsing and normalization are shared: a definition's capabilities do
 * not depend on which directory supplied it. Source adapters only translate
 * ecosystem tool names and fields into their DSH equivalents.
 */
export const DEFAULT_PRESET_ID = "dsh-default";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DESCRIPTION = 2_000;
const MAX_AGENTS = 200;
const MAX_ALIASES = 32;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "opusplan", "inherit"]);

const DISPLAY_FIELDS = new Set(["name", "description", "metadata", "color", "argument-hint", "target"]);
const EXECUTION_FIELDS = new Set([
  "tools", "allowed-tools", "disallowedTools", "disallowed-tools",
  "model", "provider", "reasoningEffort", "reasoning-effort", "effort",
  "maxTokens", "max-tokens", "user-invocable", "disable-model-invocation", "infer",
]);
const UNSUPPORTED_FIELDS = new Map([
  ["hooks", "hooks are not executed by DSH"],
  ["permissions", "permission overrides are not applied; DSH process permissions remain"],
  ["permissionMode", "permission modes are not mapped; DSH process permissions remain"],
  ["permission-mode", "permission modes are not mapped; DSH process permissions remain"],
  ["mcpServers", "per-agent MCP servers are not installed"],
  ["mcp-servers", "per-agent MCP servers are not installed"],
  ["plugins", "plugin injection is not supported"],
  ["extensions", "extensions are not supported"],
  ["commands", "custom command injection is not supported"],
  ["script", "scripts are not executed"],
  ["scripts", "scripts are not executed"],
  ["exec", "executable payloads are not supported"],
  ["execute", "executable payloads are not supported"],
  ["command", "commands are not executed"],
  ["preToolUse", "hooks are not executed"],
  ["postToolUse", "hooks are not executed"],
  ["background", "background execution is not mapped for root agents"],
  ["memory", "agent memory is not mapped"],
  ["skills", "per-agent skill preload is not mapped"],
  ["maxTurns", "turn caps are not enforced"],
  ["autoCompactWindow", "compaction window overrides are not mapped"],
  ["omitClaudeMd", "instruction-file omission is not mapped"],
  ["isolation", "worktree isolation is not applied to agent selection"],
  ["initialPrompt", "initial prompt injection is not mapped"],
  ["experimental", "experimental fields are not mapped"],
  ["handoffs", "handoffs are not supported"],
  ["handOff", "handoffs are not supported"],
  ["systemPrompt", "system prompt overrides are not supported"],
  ["target", "Copilot target selection is not enforced by DSH"],
]);

/** First-party DSH tool names known at authoring time. Unknown names are explicit diagnostics. */
const DSH_TOOLS = new Set([
  "read", "write", "edit", "bash", "pwsh", "glob", "grep",
  "web_search", "web_fetch", "todo_write", "skill", "subagent", "subagent_fork",
  "send_message", "interrupt_agent", "list_agents", "delegate_to_agent",
  "ask_user_question", "job_output", "job_kill", "job_list", "workflow",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "create_goal", "update_goal", "goal", "enter_plan_mode", "exit_plan_mode",
]);

const CLAUDE_TOOLS = new Map([
  ["Read", ["read"]],
  ["Write", ["write"]],
  ["Edit", ["edit"]],
  ["Bash", ["bash"]],
  ["Glob", ["glob"]],
  ["Grep", ["grep"]],
  ["WebFetch", ["web_fetch"]],
  ["WebSearch", ["web_search"]],
  ["TodoWrite", ["todo_write"]],
  ["Task", ["subagent"]],
  ["Agent", ["subagent"]],
  ["Skill", ["skill"]],
  ["SendMessage", ["send_message"]],
  ["AskUserQuestion", ["ask_user_question"]],
]);

const COPILOT_TOOLS = new Map([
  ["execute", ["bash"]],
  ["shell", ["bash"]],
  ["bash", ["bash"]],
  ["read", ["read"]],
  ["Read", ["read"]],
  ["view", ["read"]],
  ["edit", ["edit", "write"]],
  ["Edit", ["edit"]],
  ["Write", ["write"]],
  ["str_replace", ["edit"]],
  ["str_replace_editor", ["edit"]],
  ["search", ["grep", "glob"]],
  ["Grep", ["grep"]],
  ["Glob", ["glob"]],
  ["agent", ["subagent"]],
  ["custom-agent", ["subagent"]],
  ["Task", ["subagent"]],
  ["web", ["web_search", "web_fetch"]],
  ["WebSearch", ["web_search"]],
  ["WebFetch", ["web_fetch"]],
  ["todo", ["todo_write"]],
  ["TodoWrite", ["todo_write"]],
]);

function abort(signal) {
  signal?.throwIfAborted();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(message, limit = 400) {
  return message.length > limit ? `${message.slice(0, limit - 3)}...` : message;
}

function readYamlParser(yaml) {
  if (!yaml || typeof yaml.parseDocument !== "function" || typeof yaml.visit !== "function") {
    throw new Error("YAML parser module is required; pass the `yaml` package");
  }
  return yaml;
}

/** Parse frontmatter with a real YAML parser while preserving raw source. */
export function parseFrontmatter(text, yamlModule) {
  const yaml = readYamlParser(yamlModule);
  const normalized = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] === undefined || !/^---[ \t]*$/.test(lines[0])) throw new Error("missing YAML frontmatter opening delimiter");
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index])) {
      closing = index;
      break;
    }
  }
  if (closing < 0) throw new Error("unterminated YAML frontmatter");
  const raw = lines.slice(1, closing).join("\n");
  if (Buffer.byteLength(raw, "utf8") > MAX_FRONTMATTER_BYTES) {
    throw new Error(`frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`);
  }
  const body = lines.slice(closing + 1).join("\n").replace(/^\n/, "");
  let document;
  try {
    document = yaml.parseDocument(raw, {
      schema: "core",
      uniqueKeys: true,
      prettyErrors: true,
      maxAliasCount: MAX_ALIASES,
      version: "1.2",
    });
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document.errors.length > 0) {
    throw new Error(`invalid YAML frontmatter: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  let aliasCount = 0;
  let customTag;
  yaml.visit(document, {
    Alias() {
      aliasCount += 1;
    },
    Node(_key, node) {
      if (customTag !== undefined || !node || typeof node !== "object" || !("tag" in node)) return;
      const tag = node.tag;
      if (typeof tag === "string" && !tag.startsWith("tag:yaml.org,2002:")) customTag = tag;
    },
  });
  if (aliasCount > MAX_ALIASES) throw new Error(`frontmatter aliases exceed ${MAX_ALIASES}`);
  if (customTag !== undefined) throw new Error(`unsupported YAML tag "${customTag}"`);
  let data;
  try {
    data = document.toJS({ maxAliasCount: MAX_ALIASES, mapAsMap: false });
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (data === null) data = {};
  if (!isRecord(data)) throw new Error("frontmatter must be a YAML mapping");
  return { data, body, raw };
}

function booleanField(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "true":
      case "yes":
      case "on":
      case "1":
        return true;
      case "false":
      case "no":
      case "off":
      case "0":
        return false;
    }
  }
  throw new Error(`frontmatter field "${key}" must be a boolean`);
}

function stringField(value, key) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`frontmatter field "${key}" must be a non-empty string`);
  return value.trim();
}

function stringList(value, key) {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
    return parts;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string" || item.trim() === "") throw new Error(`frontmatter field "${key}" must contain strings`);
      return item.trim();
    });
  }
  throw new Error(`frontmatter field "${key}" must be a list or comma-separated string`);
}

function mapToolNames(value, source, field, issues) {
  const raw = stringList(value, field);
  if (raw === undefined) return undefined;
  const names = [];
  for (const item of raw) {
    if (item === "*") {
      names.push("*");
      continue;
    }
    if (item.includes("(") || item.includes(")") || item.includes(":*")) {
      issues.push(`${field} entry "${item}" uses a command/path filter with no DSH equivalent`);
      continue;
    }
    let mapped;
    if (source === "native") {
      mapped = DSH_TOOLS.has(item) ? [item] : undefined;
      if (mapped === undefined) issues.push(`unknown DSH tool "${item}"`);
    } else if (source === "claude") {
      mapped = CLAUDE_TOOLS.get(item);
      if (mapped === undefined) issues.push(`Claude tool "${item}" has no verified DSH equivalent`);
    } else {
      mapped = COPILOT_TOOLS.get(item) ?? COPILOT_TOOLS.get(item.toLowerCase());
      if (mapped === undefined) {
        if (item.startsWith("mcp__") || item.includes("/")) issues.push(`MCP tool "${item}" cannot be enabled without an equivalent DSH MCP mount`);
        else issues.push(`Copilot tool "${item}" has no verified DSH equivalent`);
      }
    }
    if (mapped !== undefined) names.push(...mapped);
  }
  return names;
}

function normalizeToolObject(value, source, issues) {
  if (!isRecord(value)) return undefined;
  const unknown = Object.keys(value).filter((key) => key !== "allow" && key !== "deny");
  if (unknown.length > 0) issues.push(`tools object has unsupported keys: ${unknown.join(", ")}`);
  const allowValue = value.allow;
  const denyValue = value.deny;
  const allow = allowValue === undefined ? undefined : mapToolNames(allowValue, source, "tools.allow", issues);
  const deny = denyValue === undefined ? undefined : mapToolNames(denyValue, source, "tools.deny", issues);
  if (allow === undefined && deny === undefined) {
    issues.push("tools object must declare allow and/or deny");
    return undefined;
  }
  return { allow, deny, explicitEmpty: Array.isArray(allowValue) && allowValue.length === 0 };
}

function normalizeTools(value, disallowedValue, source, issues) {
  let allow;
  let deny;
  let none = false;
  if (value !== undefined) {
    if (Array.isArray(value) || typeof value === "string") {
      const raw = stringList(value, "tools");
      if (raw !== undefined && raw.length === 0) none = true;
      else allow = mapToolNames(value, source, "tools", issues);
    } else if (isRecord(value)) {
      const parsed = normalizeToolObject(value, source, issues);
      if (parsed) {
        allow = parsed.allow;
        deny = parsed.deny;
        if (parsed.explicitEmpty && parsed.deny === undefined) none = true;
      }
    } else {
      issues.push("tools must be a list, comma-separated string, or allow/deny object");
    }
  }
  if (disallowedValue !== undefined) {
    const mapped = mapToolNames(disallowedValue, source, "disallowedTools", issues);
    if (mapped !== undefined && mapped.length > 0) deny = [...(deny ?? []), ...mapped];
  }
  if (allow?.includes("*")) {
    allow = allow.filter((name) => name !== "*");
    if (allow.length === 0) allow = undefined;
  }
  if (none) return { none: true };
  if (allow !== undefined && allow.length === 0) return { none: true };
  const filter = {};
  if (allow !== undefined) filter.allow = [...new Set(allow)];
  if (deny !== undefined) filter.deny = [...new Set(deny)];
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function normalizeModelFields(data, source, issues, modelAliases) {
  const provider = data.provider === undefined ? undefined : stringField(data.provider, "provider");
  if (provider !== undefined && !PROVIDER_ROUTE.test(provider)) throw new Error("frontmatter field \"provider\" must be a DSH provider route");
  const effortValue = data.reasoningEffort ?? data["reasoning-effort"] ?? data.effort;
  let reasoningEffort;
  if (effortValue !== undefined) {
    if (typeof effortValue !== "string" || effortValue.trim() === "") throw new Error("frontmatter field \"reasoningEffort\" must be a non-empty string");
    reasoningEffort = effortValue.trim();
  }
  const maxTokens = data.maxTokens ?? data["max-tokens"];
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new Error("frontmatter field \"maxTokens\" must be a positive integer");
  }
  let providerValue = provider;
  let model = data.model;
  let modelAlias;
  if (model !== undefined && model !== null) {
    if (typeof model !== "string" || model.trim() === "") throw new Error("frontmatter field \"model\" must be a non-empty string");
    model = model.trim();
    if (model === "inherit") model = undefined;
    else if (MODEL_ALIASES.has(model)) {
      const alias = model;
      const mapped = modelAliases?.[alias];
      if (!isRecord(mapped) || typeof mapped.provider !== "string" || typeof mapped.model !== "string") {
        modelAlias = alias;
        issues.push(`model alias "${alias}" is not mapped; configure DSH_ACP_MODEL_ALIASES with provider and model`);
        model = undefined;
      } else {
        modelAlias = alias;
        model = mapped.model;
        providerValue = mapped.provider;
        if (mapped.reasoningEffort !== undefined) reasoningEffort = String(mapped.reasoningEffort);
      }
    }
  }
  if (providerValue !== undefined && model === undefined) {
    issues.push("provider is set without a model");
  }
  if (reasoningEffort !== undefined && model === undefined) {
    issues.push("reasoningEffort requires an explicit model");
  }
  if (maxTokens !== undefined && model === undefined) {
    issues.push("maxTokens requires an explicit model");
  }
  return {
    provider: providerValue,
    model,
    modelAlias,
    reasoningEffort,
    maxTokens,
  };
}

function displayField(data, key, warnings) {
  const value = data[key];
  if (value === undefined) return undefined;
  if (key === "metadata" && isRecord(value)) return value;
  if (typeof value === "string") return value;
  warnings.push(`field "${key}" must be ${key === "metadata" ? "a mapping" : "a string"}; it is retained as raw data but not applied`);
  return undefined;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function contentHash(definition) {
  return createHash("sha256").update(JSON.stringify({
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    tools: definition.tools ?? null,
    provider: definition.provider ?? null,
    model: definition.model ?? null,
    reasoningEffort: definition.reasoningEffort ?? null,
    maxTokens: definition.maxTokens ?? null,
    userInvocable: definition.userInvocable,
    modelInvocable: definition.modelInvocable,
    rawFrontmatter: definition.rawFrontmatter,
    unsupportedFields: definition.unsupportedFields,
  })).digest("hex").slice(0, 16);
}

/** Parse one agent Markdown document into a definition, or throw a bounded error. */
export function parseAgentDocument(text, options) {
  const source = options.source;
  if (source !== "native" && source !== "claude" && source !== "copilot") throw new Error(`unknown agent source: ${source}`);
  const { data, body, raw } = parseFrontmatter(text, options.yaml);
  const warnings = [];
  const unsupportedFields = [];
  const toolIssues = [];
  const modelIssues = [];
  for (const key of Object.keys(data)) {
    if (DISPLAY_FIELDS.has(key) || EXECUTION_FIELDS.has(key)) continue;
    const reason = UNSUPPORTED_FIELDS.get(key);
    if (reason !== undefined) {
      if (key === "target") warnings.push(`field "target" is retained but not enforced by DSH`);
      else unsupportedFields.push({ field: key, reason });
    } else {
      unsupportedFields.push({ field: key, reason: "unknown frontmatter field" });
    }
  }
  if (data.target !== undefined) warnings.push("field \"target\" is retained but not enforced by DSH");
  if (Object.hasOwn(data, "allowed-tools") && Object.hasOwn(data, "tools")) {
    unsupportedFields.push({ field: "tools", reason: "both tools and allowed-tools are present; merge them into one list" });
  }
  if (Object.hasOwn(data, "infer") && Object.hasOwn(data, "disable-model-invocation")) {
    warnings.push("both infer and disable-model-invocation are set; disable-model-invocation wins");
  }
  const rawName = data.name === undefined ? undefined : stringField(data.name, "name");
  if (source === "claude" && rawName === undefined) throw new Error("Claude agent requires a name");
  const id = slugify(rawName ?? options.nameHint);
  if (!id || !SKILL_NAME.test(id)) throw new Error("agent name must normalize to kebab-case");
  if (id.length > 64) throw new Error("agent name is too long");
  const name = rawName ?? id;
  const description = stringField(data.description, "description");
  if (description.length > MAX_DESCRIPTION) throw new Error(`description exceeds ${MAX_DESCRIPTION} characters`);
  const prompt = body.trim();
  if (!prompt) throw new Error("agent body must not be empty");
  if (Buffer.byteLength(prompt, "utf8") > MAX_BODY_BYTES) throw new Error(`agent body exceeds ${MAX_BODY_BYTES} bytes`);
  const toolsValue = Object.hasOwn(data, "tools") ? data.tools : data["allowed-tools"];
  const disallowedValue = data.disallowedTools ?? data["disallowed-tools"];
  const sourceIssues = toolIssues;
  const tools = normalizeTools(toolsValue, disallowedValue, source, sourceIssues);
  const modelFields = normalizeModelFields(data, source, modelIssues, options.modelAliases);
  const metadata = displayField(data, "metadata", warnings);
  const color = displayField(data, "color", warnings);
  const argumentHint = displayField(data, "argument-hint", warnings);
  const infer = data.infer === undefined ? undefined : booleanField(data.infer, "infer");
  const disableModelInvocation = data["disable-model-invocation"] === undefined
    ? (infer === undefined ? undefined : Boolean(infer))
    : booleanField(data["disable-model-invocation"], "disable-model-invocation");
  const userInvocable = data["user-invocable"] === undefined ? true : booleanField(data["user-invocable"], "user-invocable");
  const baseBlocking = [
    ...unsupportedFields.map((entry) => `${entry.field}: ${entry.reason}`),
    ...sourceIssues,
    ...modelIssues,
  ];
  const rootBlocking = [...baseBlocking];
  if (modelFields.maxTokens !== undefined) rootBlocking.push("maxTokens is child-only and is not applied to a root agent");
  const childBlocking = [...baseBlocking];
  const definition = {
    id,
    name,
    description,
    prompt,
    tools,
    provider: modelFields.provider,
    model: modelFields.model,
    modelAlias: modelFields.modelAlias,
    reasoningEffort: modelFields.reasoningEffort,
    maxTokens: modelFields.maxTokens,
    userInvocable,
    modelInvocable: disableModelInvocation === undefined ? true : !disableModelInvocation,
    metadata,
    color,
    argumentHint,
    target: typeof data.target === "string" ? data.target : undefined,
    rawFrontmatter: raw,
    rawData: data,
    unsupportedFields,
    warnings,
    toolIssues: sourceIssues,
    modelIssues,
    availableForRoot: rootBlocking.length === 0,
    availableForChild: childBlocking.length === 0,
    unavailableForRoot: rootBlocking.length === 0 ? undefined : boundedMessage(rootBlocking.join("; "), 500),
    unavailableForChild: childBlocking.length === 0 ? undefined : boundedMessage(childBlocking.join("; "), 500),
    source: options.source,
    path: options.path,
    rank: options.rank,
    projectRoot: options.projectRoot,
  };
  definition.contentHash = contentHash(definition);
  definition.presetId = presetIdForDefinition(definition);
  return definition;
}

/** Stable, project-scoped agent id. It contains no display text. */
export function presetIdForDefinition(definition) {
  const project = createHash("sha256").update(resolve(definition.projectRoot)).digest("hex").slice(0, 8);
  return `dsh-agent-${project}-${definition.id}`;
}

async function projectRootFor(cwd, signal) {
  let current = resolve(cwd);
  while (true) {
    abort(signal);
    try {
      const info = await stat(join(current, ".git"));
      if (info.isDirectory() || info.isFile()) return current;
    } catch {
      // A missing marker is expected while climbing.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function customDirsFrom(env, explicit) {
  if (explicit !== undefined) return explicit.map((dir) => resolve(dir));
  const raw = env.DSH_ACP_AGENT_DIRS;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw.split(delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => resolve(entry));
}

function modelAliasesFrom(env) {
  const raw = env.DSH_ACP_MODEL_ALIASES;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`DSH_ACP_MODEL_ALIASES must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readCandidate(path, signal) {
  abort(signal);
  const info = await stat(path);
  if (!info.isFile()) return undefined;
  if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  return await readFile(path, { encoding: "utf8", signal });
}

async function scanRoot(root, signal, seenFiles, yaml, modelAliases, parseSource) {
  const definitions = [];
  const warnings = [];
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return { definitions, warnings };
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    abort(signal);
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (entry.name === "AGENTS.md" || entry.name === "README.md") continue;
    if (entry.isDirectory() && root.kind === "native") {
      // Directory bundle: <name>/AGENT.md.
    } else if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) {
      continue;
    }
    const nameHint = entry.name.replace(parseSource === "copilot" ? /(?:\.agent)?\.md$/i : /\.md$/i, "");
    const path = entry.isDirectory() ? join(root.path, entry.name, "AGENT.md") : join(root.path, entry.name);
    try {
      let text;
      try {
        const canonical = await realpath(path);
        if (seenFiles.has(canonical)) continue;
        seenFiles.add(canonical);
        text = await readCandidate(path, signal);
      } catch (error) {
        if (error && error.code === "ENOENT" && entry.isDirectory()) continue;
        throw error;
      }
      if (text === undefined) continue;
      const definition = parseAgentDocument(text, {
        source: parseSource,
        path,
        nameHint,
        rank: root.rank,
        projectRoot: root.projectRoot,
        yaml,
        modelAliases,
      });
      definitions.push(definition);
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (definitions.length > MAX_AGENTS) throw new Error(`more than ${MAX_AGENTS} agent definitions`);
  }
  return { definitions, warnings };
}

/** Bounded discovery across project, shared, custom, user, Claude, and Copilot roots. */
export async function discoverAgentDefinitions(options) {
  const yaml = readYamlParser(options.yaml);
  const env = options.env ?? process.env;
  const signal = options.signal;
  const cwd = resolve(options.cwd);
  const projectRoot = await projectRootFor(cwd, signal);
  const home = options.home ?? env.HOME ?? homedir();
  const dshHome = resolve(env.DSH_HOME ?? join(home, ".dsh"));
  const agentsHome = resolve(env.DSH_AGENTS_HOME ?? join(home, ".agents"));
  const customDirs = customDirsFrom(env, options.customDirs);
  const modelAliases = options.modelAliases ?? modelAliasesFrom(env);
  const roots = [
    { path: join(projectRoot, ".dsh", "agents"), source: "project-dsh", rank: 100, kind: "native", projectRoot },
    { path: join(projectRoot, ".agents", "agents"), source: "project-agents", rank: 200, kind: "native", projectRoot },
    ...customDirs.map((path) => ({ path, source: "custom", rank: 300, kind: "native", projectRoot })),
    { path: join(dshHome, "agents"), source: "user-dsh", rank: 400, kind: "native", projectRoot },
    { path: join(agentsHome, "agents"), source: "user-agents", rank: 500, kind: "native", projectRoot },
    { path: join(projectRoot, ".claude", "agents"), source: "project-claude", rank: 700, kind: "claude", projectRoot },
    { path: join(home, ".claude", "agents"), source: "user-claude", rank: 800, kind: "claude", projectRoot },
    { path: join(projectRoot, ".copilot", "agents"), source: "project-copilot", rank: 900, kind: "copilot", projectRoot },
    { path: join(home, ".copilot", "agents"), source: "user-copilot", rank: 1000, kind: "copilot", projectRoot },
  ];
  const warnings = [];
  const candidates = [];
  const seenRoots = new Set();
  const seenFiles = new Set();
  const resolvedRoots = [];
  const kindByCanonical = new Map();
  for (const root of roots) {
    abort(signal);
    try {
      const canonical = await realpath(root.path);
      const resolved = { ...root, canonical };
      resolvedRoots.push(resolved);
      const info = await lstat(root.path);
      const actualPath = !info.isSymbolicLink();
      if (!kindByCanonical.has(canonical) || actualPath) kindByCanonical.set(canonical, root.kind);
    } catch (error) {
      if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      warnings.push(`${root.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const root of resolvedRoots) {
    abort(signal);
    if (seenRoots.has(root.canonical)) continue;
    seenRoots.add(root.canonical);
    try {
      const parseSource = kindByCanonical.get(root.canonical) ?? root.kind;
      const scanned = await scanRoot(root, signal, seenFiles, yaml, modelAliases, parseSource);
      candidates.push(...scanned.definitions);
      warnings.push(...scanned.warnings);
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      warnings.push(`${root.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  candidates.sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
  const winners = new Map();
  for (const definition of candidates) {
    const previous = winners.get(definition.id);
    if (previous !== undefined) {
      warnings.push(`${definition.path}: shadowed by higher-priority agent "${previous.path}"`);
      continue;
    }
    winners.set(definition.id, definition);
  }
  const agents = [...winners.values()].sort((left, right) => left.name.localeCompare(right.name));
  return { agents, warnings };
}

function unavailableSuffix(definition) {
  const reasons = [];
  if (!definition.availableForRoot && definition.unavailableForRoot) reasons.push(`root: ${definition.unavailableForRoot}`);
  if (!definition.availableForChild && definition.unavailableForChild) reasons.push(`delegation: ${definition.unavailableForChild}`);
  return reasons.length === 0 ? "" : ` — Unavailable ${boundedMessage(reasons.join("; "), 320)}`;
}

/** Rich choices for the Paseo composer picker. Unavailable entries remain visible. */
export function agentControlChoices(definitions) {
  return [
    { value: DEFAULT_PRESET_ID, label: "Default", description: "Default DeepSeek Harness agent" },
    ...definitions.filter((definition) => definition.userInvocable).map((definition) => ({
      value: definition.presetId,
      label: definition.name,
      description: `${definition.description}${unavailableSuffix(definition)}`,
    })),
  ];
}

/** ACP config option injected into session/new and session/resume responses. */
export function agentConfigOption(definitions, current) {
  const value = typeof current === "string" && current !== "" ? current : DEFAULT_PRESET_ID;
  const choices = agentControlChoices(definitions);
  if (!choices.some((choice) => choice.value === value)) {
    choices.push({
      value,
      label: value,
      description: "The selected agent definition is no longer available.",
    });
  }
  return {
    id: "agent",
    name: "Agent",
    description: "Select a DeepSeek Harness agent for this session",
    type: "select",
    currentValue: value,
    options: choices.map((choice) => ({
      value: choice.value,
      name: choice.label,
      ...(choice.description ? { description: choice.description } : {}),
    })),
  };
}

/** Model-facing catalog. Only child-executable definitions are listed. */
export function agentCatalogText(definitions) {
  const visible = definitions.filter((definition) => definition.modelInvocable && definition.availableForChild);
  if (visible.length === 0) return "";
  const lines = visible.map((definition) => {
    const description = definition.description.length > 300 ? `${definition.description.slice(0, 297)}...` : definition.description;
    return `- ${definition.id}: ${description}`;
  });
  return [
    "<available_agents>",
    "The following named agent definitions are available for delegation. Use the `delegate_to_agent` tool with the exact agent id to run a self-contained task in a fresh child session. Agent definitions do not change this session's model, reasoning effort, permissions, or sandbox.",
    ...lines,
    "</available_agents>",
  ].join("\n");
}

/** Resolve a picker value or tool argument to a definition in this workspace. */
export function findAgentDefinition(definitions, value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const wanted = value.trim();
  return definitions.find((definition) => definition.presetId === wanted)
    ?? definitions.find((definition) => definition.id === wanted)
    ?? definitions.find((definition) => definition.name === wanted);
}

/** Synchronous parsed-model projection for diagnostics and tests. */
export function agentOptionsForDefinition(definition) {
  if (definition.model === undefined) {
    if (definition.provider !== undefined || definition.reasoningEffort !== undefined || definition.maxTokens !== undefined) {
      throw new Error(`agent "${definition.id}" sets provider, reasoningEffort, or maxTokens without a model id`);
    }
    return undefined;
  }
  return {
    ...(definition.provider !== undefined ? { provider: definition.provider } : {}),
    model: definition.model,
    ...(definition.reasoningEffort ? { reasoningEffort: definition.reasoningEffort } : {}),
    ...(definition.maxTokens ? { maxTokens: definition.maxTokens } : {}),
  };
}

/** Resolve one definition's model against the live DSH LLM catalog. */
export async function resolveAgentModel(definition, llm) {
  if (definition.model === undefined) return undefined;
  if (!llm || typeof llm.listProviders !== "function" || typeof llm.listModels !== "function" || typeof llm.resolveModelInfo !== "function") {
    throw new Error("DSH LLM catalog is unavailable for model validation");
  }
  const providers = await llm.listProviders();
  const providerIds = new Set(providers.map((provider) => provider.id));
  let provider = definition.provider;
  let model = definition.model;
  if (provider !== undefined) {
    if (!providerIds.has(provider)) throw new Error(`DSH provider "${provider}" is not registered`);
    const models = await llm.listModels(provider);
    if (!models.some((entry) => entry.id === model)) {
      await llm.resolveModelInfo(provider, model);
    }
  } else {
    const matches = [];
    for (const providerId of providerIds) {
      let models;
      try {
        models = await llm.listModels(providerId);
      } catch {
        continue;
      }
      if (models.some((entry) => entry.id === model)) matches.push(providerId);
    }
    if (matches.length === 1) provider = matches[0];
    else if (matches.length > 1) throw new Error(`model "${model}" is ambiguous across providers: ${matches.join(", ")}`);
    else {
      const slash = model.indexOf("/");
      if (slash > 0 && providerIds.has(model.slice(0, slash))) {
        const candidateProvider = model.slice(0, slash);
        const candidateModel = model.slice(slash + 1);
        const models = await llm.listModels(candidateProvider);
        if (models.some((entry) => entry.id === candidateModel)) {
          provider = candidateProvider;
          model = candidateModel;
        }
      }
      if (provider === undefined) throw new Error(`model "${model}" is not present in the DSH catalog`);
    }
  }
  const info = await llm.resolveModelInfo(provider, model);
  let reasoningEffort = definition.reasoningEffort;
  if (reasoningEffort !== undefined) {
    const efforts = info.reasoning?.efforts ?? [];
    if (!efforts.some((effort) => String(effort.id) === reasoningEffort)) {
      throw new Error(`reasoningEffort "${reasoningEffort}" is not supported by ${provider}/${model}`);
    }
  }
  return { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
}

/** AgentOptions for a delegated child after catalog validation. */
export function childAgentOptions(definition, selection) {
  if (selection === undefined) return undefined;
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(definition.maxTokens !== undefined ? { maxTokens: definition.maxTokens } : {}),
  };
}
