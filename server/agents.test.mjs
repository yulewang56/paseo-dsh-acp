import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as yaml from "yaml";
import {
  DEFAULT_PRESET_ID,
  agentConfigOption,
  agentControlChoices,
  agentOptionsForDefinition,
  agentCatalogText,
  childAgentOptions,
  discoverAgentDefinitions,
  parseAgentDocument,
  parseFrontmatter,
  resolveAgentModel,
} from "./agents.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-agents-test-"));
  const project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  return {
    root,
    project,
    async write(relative, text) {
      const path = join(project, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
      return path;
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

const document = (extra = "", body = "You review changes.") => `---
name: reviewer
description: Reviews changes for correctness
${extra}---\n${body}`;

function parse(text, source = "native", extra = {}) {
  return parseAgentDocument(text, {
    source,
    path: "/tmp/reviewer.md",
    nameHint: "reviewer",
    rank: 200,
    projectRoot: "/tmp/project",
    yaml,
    ...extra,
  });
}

function mockLlm() {
  const models = new Map([
    ["p1", ["m1", "shared", "deepseek/deepseek-v4-pro"]],
    ["p2", ["shared"]],
  ]);
  return {
    calls: [],
    listProviders: async () => [...models.keys()].map((id) => ({ id })),
    listModels: async (provider) => (models.get(provider) ?? []).map((id) => ({ id })),
    resolveModelInfo: async (provider, model) => {
      if (!(models.get(provider) ?? []).includes(model)) throw new Error("not found");
      return { reasoning: { efforts: [{ id: "low" }, { id: "high" }] } };
    },
  };
}

test("parses complete YAML: block and folded scalars, nested maps/lists, quoted colons, BOM and CRLF", () => {
  const text = "﻿---\r\nname: reviewer\r\ndescription: >-\r\n  Reviews changes\r\n  for correctness\r\nmetadata:\r\n  owner: team\r\n  nested:\r\n    values:\r\n      - one\r\n      - \"two: three\"\r\n    note: 'keep: this'\r\ntools:\r\n  allow:\r\n    - read\r\n    - grep\r\n  deny: [bash]\r\nmodel: deepseek/deepseek-v4-pro\r\nprovider: deepseek-official\r\nreasoningEffort: high\r\nmaxTokens: 2048\r\nuser-invocable: false\r\ndisable-model-invocation: true\r\ncolor: blue\r\nargument-hint: \"[diff]\"\r\ntarget: vscode\r\n---\r\n\r\nBody line.\r\n---\r\nTail.\r\n";
  const parsed = parseFrontmatter(text, yaml);
  assert.equal(parsed.data.description, "Reviews changes for correctness");
  assert.deepEqual(parsed.data.metadata, {
    owner: "team",
    nested: { values: ["one", "two: three"], note: "keep: this" },
  });
  assert.match(parsed.raw, /description: >-/);
  const definition = parse(text.replace(/\r\n/g, "\n").replace(/^﻿/, ""));
  assert.deepEqual(definition.tools, { allow: ["read", "grep"], deny: ["bash"] });
  assert.equal(definition.provider, "deepseek-official");
  assert.equal(definition.model, "deepseek/deepseek-v4-pro");
  assert.equal(definition.reasoningEffort, "high");
  assert.equal(definition.maxTokens, 2048);
  assert.equal(definition.userInvocable, false);
  assert.equal(definition.modelInvocable, false);
  assert.equal(definition.metadata.owner, "team");
  assert.equal(definition.color, "blue");
  assert.equal(definition.argumentHint, "[diff]");
  assert.equal(definition.target, "vscode");
  assert.match(definition.rawFrontmatter, /metadata:/);
  assert.equal(definition.availableForRoot, false);
  assert.match(definition.unavailableForRoot, /maxTokens is child-only/);
  assert.equal(definition.availableForChild, true);
});

test("rejects duplicate keys, malformed YAML, custom tags, and excessive aliases", () => {
  assert.throws(() => parseFrontmatter("---\nname: a\nname: b\n---\nX", yaml), /invalid YAML|Map keys/);
  assert.throws(() => parseFrontmatter("---\nname: [\n---\nX", yaml), /invalid YAML/);
  assert.throws(() => parseFrontmatter("---\nname: !custom x\n---\nX", yaml), /unsupported YAML tag|invalid YAML/);
  const anchors = "a0: &a0 x";
  const aliases = Array.from({ length: 40 }, (_, index) => `b${index}: *a0`).join("\n");
  assert.throws(() => parseFrontmatter(`---\n${anchors}\n${aliases}\n---\nX`, yaml), /aliases/i);
});

test("uses one schema across native, Claude, and Copilot sources while translating tool names", () => {
  const native = parse(document("tools: [read, grep]\nmodel: deepseek/deepseek-v4-pro\nprovider: deepseek-official\n"), "native");
  const claude = parse(`---
name: reviewer
description: Reviews changes for correctness
tools: Read, Grep
model: deepseek/deepseek-v4-pro
provider: deepseek-official
---
You review changes.
`, "claude");
  const copilot = parse(`---
name: reviewer
description: Reviews changes for correctness
tools: [Read, Grep]
model: deepseek/deepseek-v4-pro
provider: deepseek-official
---
You review changes.
`, "copilot");
  for (const definition of [native, claude, copilot]) {
    assert.deepEqual(definition.tools, { allow: ["read", "grep"] });
    assert.equal(definition.model, "deepseek/deepseek-v4-pro");
    assert.equal(definition.provider, "deepseek-official");
    assert.equal(definition.availableForRoot, true);
    assert.equal(definition.availableForChild, true);
  }
  assert.notEqual(native.source, claude.source);
  assert.notEqual(claude.source, copilot.source);
});

test("maps Claude and Copilot aliases without weakening tools; explicit empty means no tools", () => {
  const copilotSearch = parse(document("tools: [search]\n"), "copilot");
  assert.deepEqual(copilotSearch.tools, { allow: ["grep", "glob"] });
  const claudeWrite = parse(`---
name: reviewer
description: X
tools: [Write]
---
Body.
`, "claude");
  assert.deepEqual(claudeWrite.tools, { allow: ["write"] });
  const empty = parse(document("tools: []\n"), "copilot");
  assert.deepEqual(empty.tools, { none: true });
  assert.equal(empty.availableForRoot, true);
  const allDeny = parse(document("tools: ['*']\ndisallowedTools: [bash]\n"), "native");
  assert.deepEqual(allDeny.tools, { deny: ["bash"] });
  const param = parse(document("tools: ['Bash(git:*)']\n"), "claude");
  assert.equal(param.availableForRoot, false);
  assert.match(param.unavailableForRoot, /no DSH equivalent/);
  const unknown = parse(document("tools: [NotATool]\n"), "claude");
  assert.equal(unknown.availableForRoot, false);
  assert.match(unknown.toolIssues.join("\n"), /no verified DSH equivalent/);
  const mcp = parse(document("tools: [github/read]\n"), "copilot");
  assert.equal(mcp.availableForRoot, false);
  assert.match(mcp.toolIssues.join("\n"), /MCP tool/);
});

test("retains unknown and unsupported fields, exposes diagnostics, and blocks execution", () => {
  const unknown = parse(document("mystery: true\n"));
  assert.equal(unknown.rawData.mystery, true);
  assert.deepEqual(unknown.unsupportedFields, [{ field: "mystery", reason: "unknown frontmatter field" }]);
  assert.equal(unknown.availableForRoot, false);
  assert.match(unknown.availableForRoot ? "" : unknown.unavailableForRoot, /unknown frontmatter field/);
  assert.match(agentControlChoices([unknown])[1].description, /Unavailable/);
  assert.equal(agentCatalogText([unknown]), "");
  const hooks = parse(document("hooks:\n  preToolUse: nope\n"));
  assert.equal(hooks.rawData.hooks.preToolUse, "nope");
  assert.equal(hooks.availableForRoot, false);
  assert.match(hooks.unavailableForRoot, /hooks are not executed/);
  const maxTokens = parse(document("model: deepseek/deepseek-v4-pro\nmaxTokens: 10\n"));
  assert.equal(maxTokens.availableForRoot, false);
  assert.equal(maxTokens.availableForChild, true);
  assert.match(maxTokens.unavailableForRoot, /maxTokens is child-only/);
});

test("parses model aliases only through an explicit mapping", () => {
  const unmapped = parse(document("model: sonnet\n"), "claude");
  assert.equal(unmapped.availableForRoot, false);
  assert.match(unmapped.modelIssues.join("\n"), /DSH_ACP_MODEL_ALIASES/);
  const mapped = parse(document("model: sonnet\n"), "claude", {
    modelAliases: { sonnet: { provider: "p1", model: "m1", reasoningEffort: "high" } },
  });
  assert.equal(mapped.model, "m1");
  assert.equal(mapped.provider, "p1");
  assert.equal(mapped.reasoningEffort, "high");
  assert.equal(mapped.modelAlias, "sonnet");
  assert.equal(mapped.rawData.model, "sonnet");
  assert.equal(mapped.availableForRoot, true);
});

test("resolves exact, unique, ambiguous, and invalid model routes against the catalog", async () => {
  const llm = mockLlm();
  const exact = parse(document("model: deepseek/deepseek-v4-pro\n"), "native");
  assert.deepEqual(await resolveAgentModel(exact, llm), { provider: "p1", model: "deepseek/deepseek-v4-pro" });
  const unique = parse(document("model: m1\n"), "native");
  assert.deepEqual(await resolveAgentModel(unique, llm), { provider: "p1", model: "m1" });
  const ambiguous = parse(document("model: shared\n"), "native");
  await assert.rejects(() => resolveAgentModel(ambiguous, llm), /ambiguous/);
  const missing = parse(document("model: absent\n"), "native");
  await assert.rejects(() => resolveAgentModel(missing, llm), /not present/);
  const badEffort = parse(document("model: m1\nreasoningEffort: lowish\n"), "native");
  await assert.rejects(() => resolveAgentModel(badEffort, llm), /not supported/);
  assert.deepEqual(childAgentOptions(badEffort, { provider: "p1", model: "m1", reasoningEffort: "low" }), {
    provider: "p1", model: "m1", reasoningEffort: "low",
  });
});

test("requires required identity fields and reports malformed files through discovery", async () => {
  assert.throws(() => parse("---\ndescription: Missing name\n---\nBody", "claude"), /requires a name/);
  assert.throws(() => parse("---\nname: x\n---\nBody"), /description/);
  assert.throws(() => parse("---\nname: x\ndescription: X\n---\n"), /body/);
  const f = await fixture();
  try {
    await f.write(".agents/agents/good.md", document());
    await f.write(".agents/agents/bad.md", "---\nname: [\n---\nBody");
    const result = await discoverAgentDefinitions({ cwd: f.project, env: {}, home: f.root, yaml });
    assert.deepEqual(result.agents.map((agent) => agent.id), ["reviewer"]);
    assert.match(result.warnings.join("\n"), /invalid YAML/);
  } finally {
    await f.close();
  }
});

test("discovers Copilot agents from the Git root and symlinked user files", async () => {
  const f = await fixture();
  try {
    const target = await f.write("copilot-refuter.md", "---\nname: refuter\ndescription: Finds counterexamples\n---\nRefute claims.");
    const userRoot = join(f.root, ".copilot", "agents");
    await mkdir(userRoot, { recursive: true });
    await symlink(target, join(userRoot, "refuter.md"));
    await f.write(".github/agents/checker.agent.md", "---\ndescription: Checks changes\n---\nCheck changes.");
    const cwd = join(f.project, "src");
    await mkdir(cwd);
    const result = await discoverAgentDefinitions({ cwd, env: {}, home: f.root, yaml });
    assert.deepEqual(result.agents.map((agent) => agent.id), ["checker", "refuter"]);
    assert.equal(result.agents[0].source, "copilot");
    assert.equal(result.agents[1].source, "copilot");
    assert.equal(result.agents[1].availableForRoot, true);
  } finally {
    await f.close();
  }
});

test("deduplicates linked roots/files by real path and shadows only distinct files with the same id", async () => {
  const f = await fixture();
  try {
    await f.write(".copilot/agents/reviewer.md", document());
    await mkdir(join(f.project, ".agents"));
    await mkdir(join(f.project, ".claude"));
    await symlink(join(f.project, ".copilot", "agents"), join(f.project, ".agents", "agents"), "dir");
    await symlink(join(f.project, ".agents", "agents"), join(f.project, ".claude", "agents"), "dir");
    const linked = await discoverAgentDefinitions({ cwd: f.project, env: {}, home: f.root, yaml });
    assert.equal(linked.agents.length, 1);
    assert.equal(linked.agents[0].rank, 200);
    assert.deepEqual(linked.warnings, []);

    await f.write(".dsh/agents/reviewer.md", document().replace("Reviews changes", "Higher priority"));
    const shadowed = await discoverAgentDefinitions({ cwd: f.project, env: {}, home: f.root, yaml });
    assert.equal(shadowed.agents.length, 1);
    assert.equal(shadowed.agents[0].description, "Higher priority for correctness");
    assert.match(shadowed.warnings.join("\n"), /shadowed/);
  } finally {
    await f.close();
  }
});

test("preserves raw frontmatter and model-facing metadata in controls", () => {
  const definition = parse(document("model: deepseek/deepseek-v4-pro\nprovider: deepseek-official\nreasoningEffort: high\nmaxTokens: 2048\nuser-invocable: false\n"));
  assert.equal(definition.userInvocable, false);
  assert.deepEqual(agentOptionsForDefinition(definition), {
    provider: "deepseek-official",
    model: "deepseek/deepseek-v4-pro",
    reasoningEffort: "high",
    maxTokens: 2048,
  });
  const option = agentConfigOption([definition], definition.presetId);
  assert.equal(option.id, "agent");
  assert.equal(option.currentValue, definition.presetId);
  assert.equal(option.options[0].value, DEFAULT_PRESET_ID);
  assert.deepEqual(agentControlChoices([definition]).map((choice) => choice.label), ["Default"]);
  assert.match(agentCatalogText([definition]), /reviewer/);
});

test("keeps Copilot semantics when .agents/agents links to .copilot/agents", async () => {
  const f = await fixture();
  try {
    await f.write(".copilot/agents/copilot-reviewer.md", `---
name: copilot-reviewer
description: Uses Copilot aliases
tools: [search, read]
---
Use search and read.
`);
    await mkdir(join(f.project, ".agents"), { recursive: true });
    await symlink(join(f.project, ".copilot", "agents"), join(f.project, ".agents", "agents"), "dir");
    const result = await discoverAgentDefinitions({ cwd: f.project, env: {}, home: f.root, yaml });
    const found = result.agents.find((agent) => agent.id === "copilot-reviewer");
    assert.ok(found);
    assert.equal(found.source, "copilot");
    assert.equal(found.rank, 200);
    assert.deepEqual(found.tools, { allow: ["grep", "glob", "read"] });
    assert.equal(found.availableForRoot, true);
    assert.deepEqual(result.warnings, []);
  } finally {
    await f.close();
  }
});
