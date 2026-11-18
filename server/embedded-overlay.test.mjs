import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { AGENTS_MODULE, AGENT_PRESET_MODULE, OVERLAY_MODULE, SKILL_FILESYSTEM_MODULE } from "./embedded-overlay.ts";

const read = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

test("embedded DSH modules match their source files", async () => {
  const [agents, helper, overlay, skills] = await Promise.all([
    read("agents.mjs"),
    read("agent-preset.mjs"),
    read("overlay.mjs"),
    read("skill-filesystem.mjs"),
  ]);
  assert.equal(AGENTS_MODULE, agents, "run npm run embed after editing server/agents.mjs");
  assert.equal(AGENT_PRESET_MODULE, helper, "run npm run embed after editing server/agent-preset.mjs");
  assert.equal(OVERLAY_MODULE, overlay, "run npm run embed after editing server/overlay.mjs");
  assert.equal(SKILL_FILESYSTEM_MODULE, skills, "run npm run embed after editing server/skill-filesystem.mjs");
});
