import assert from "node:assert/strict";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { defaultSettings, parseSettingsForm, settingsSchema } from "../shared/settings.ts";
import { effectiveSettings } from "./settings.ts";
import { createSkillsOverlay } from "./skills-bridge.ts";
import { readFile } from "node:fs/promises";
import contribute from "../index.server.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";

test("settings defaults preserve discovery and forms reject invalid paths and aliases", () => {
  assert.deepEqual(defaultSettings(), { agentDirs: [], skillDirs: [], claudeSkills: true, copilotSkills: true, modelAliases: {} });
  const form = { agentDirs: "~/agents\n/opt/agents\n~/agents", skillDirs: "", modelAliases: "{}", claudeSkills: false, copilotSkills: true };
  assert.deepEqual(parseSettingsForm(form).agentDirs, ["~/agents", "/opt/agents"]);
  for (const agentDirs of ["relative/agents", "~someone/agents", "/one\n\n/two", "/bad\0path"]) {
    assert.throws(() => parseSettingsForm({ ...form, agentDirs }));
  }
  for (const modelAliases of ["", "[]", '{"sonnet":{"model":"m"}}', '{"sonnet":{"provider":"bad/route","model":"m"}}', '{"sonnet":{"provider":"p","model":""}}', '{"sonnet":{"provider":"p","model":"m","command":"exec"}}', '{"unknown":{"provider":"p","model":"m"}}']) {
    assert.throws(() => parseSettingsForm({ ...form, modelAliases }));
  }
});

test("effective discovery merges environment first, expands and deduplicates without mutating inputs", () => {
  const values = settingsSchema.parse({
    agentDirs: ["~/agents", "/plugin-agents"], skillDirs: ["~/skills", join(homedir(), "skills")],
    modelAliases: { sonnet: { provider: "plugin", model: "one" }, opus: { provider: "plugin", model: "two", reasoningEffort: "high" } },
    copilotSkills: false,
  });
  const env = { KEEP: "untouched", DSH_ACP_AGENT_DIRS: ["/env-agents", join(homedir(), "agents")].join(delimiter),
    DSH_ACP_MODEL_ALIASES: JSON.stringify({ sonnet: { provider: "environment", model: "three" } }) };
  const original = JSON.stringify({ values, env });
  const result = effectiveSettings(values, env);
  assert.deepEqual(result.env.DSH_ACP_AGENT_DIRS.split(delimiter), ["/env-agents", join(homedir(), "agents"), "/plugin-agents"]);
  assert.deepEqual(JSON.parse(result.env.DSH_ACP_MODEL_ALIASES), {
    sonnet: { provider: "environment", model: "three" }, opus: { provider: "plugin", model: "two", reasoningEffort: "high" },
  });
  assert.deepEqual(result.skills, { claudeSkills: true, copilotSkills: false, customSkillDirs: [join(homedir(), "skills")] });
  assert.equal(result.env.KEEP, "untouched");
  assert.equal(JSON.stringify({ values, env }), original);
  for (const bad of ["{broken", "[]", '{"sonnet":{"model":"m"}}']) {
    assert.throws(() => effectiveSettings(values, { DSH_ACP_MODEL_ALIASES: bad }), /Invalid DSH_ACP_MODEL_ALIASES/);
  }
});

test("launch patch passes only the plugin filesystem envelope and retains native profile row", async () => {
  const skills = { claudeSkills: false, copilotSkills: true, customSkillDirs: ["/extra-skills"] };
  const overlay = await createSkillsOverlay(skills);
  try {
    const patch = JSON.parse(await readFile(overlay.path, "utf8"));
    assert.deepEqual(patch.find((row: { id?: string }) => row.id === "skill-filesystem"), {
      id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem", disabled: true,
    });
    assert.deepEqual(patch.flatMap((row: { insert?: unknown[] }) => row.insert ?? [])
      .find((row: { id: string }) => row.id === "paseo-skill-filesystem").config, skills);
  } finally { await overlay.close(); }
});

test("invalid persisted host settings refuse the provider connection instead of launching with defaults", async () => {
  let provider: ProviderRegistration | undefined;
  contribute({
    registerSettings: () => ({ read: async () => ({ status: "invalid", revision: "bad", error: "Unsupported settings version" }) }),
    registerProvider: (value: ProviderRegistration) => { provider = value; },
  } as unknown as PluginServerContext);
  assert.ok(provider);
  await assert.rejects(provider.connect({ versions: [1], capabilities: [],
    launch: { command: "/must-not-launch", args: [], env: {} },
  }), /DSH plugin settings are invalid: Unsupported settings version/);
});
