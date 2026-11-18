import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { withProviderControls } from "./provider.ts";

type SessionConfigEvent = Extract<ProviderEvent, { type: "session.config" }>;

const definition = {
  id: "reviewer",
  name: "reviewer",
  description: "Reviews changes",
  prompt: "You review changes.",
  tools: { allow: ["read"] },
  userInvocable: true,
  modelInvocable: true,
  source: "native" as const,
  path: "/project/.agents/agents/reviewer.md",
  rank: 200,
  projectRoot: "/project",
  contentHash: "hash-reviewer",
  presetId: "dsh-agent-abc12345-reviewer",
  rawFrontmatter: "name: reviewer\ndescription: Reviews changes",
  rawData: { name: "reviewer", description: "Reviews changes" },
  unsupportedFields: [],
  warnings: [],
  toolIssues: [],
  modelIssues: [],
  availableForRoot: true,
  availableForChild: true,
};

function event(): SessionConfigEvent {
  return {
    type: "session.config",
    sessionId: "session",
    config: {
      model: "m",
      models: [], modes: [], thinkingOptions: [], settings: [],
    },
  };
}

test("adds the native Agent select beside the existing controls", () => {
  const output = withProviderControls(event(), true, {
    agents: [definition],
    value: definition.presetId,
    warnings: [],
    warned: false,
  });
  const control = output.config.controls?.find((entry) => entry.key === "agent");
  assert.ok(control && control.type === "select");
  assert.deepEqual(control.choices.map((choice) => choice.value), ["dsh-default", definition.presetId]);
  assert.deepEqual(control.choices.map((choice) => choice.label), ["Default", "reviewer"]);
  assert.equal(output.config.providerOptions?.agent, definition.presetId);
  assert.ok(output.config.controls?.some((entry) => entry.key === "auto_accept"));
  const setting = output.config.settings?.find((entry) => entry.id === "agent");
  assert.ok(setting && setting.type === "select");
  assert.equal(setting.value, definition.presetId);
});

test("keeps the default picker visible when no definitions exist", () => {
  const output = withProviderControls(event(), false, {
    agents: [],
    value: "dsh-default",
    warnings: [],
    warned: false,
  });
  const control = output.config.controls?.find((entry) => entry.key === "agent");
  assert.ok(control && control.type === "select");
  assert.deepEqual(control.choices.map((choice) => choice.value), ["dsh-default"]);
  assert.equal(output.config.providerOptions?.agent, "dsh-default");
});

test("shows an unavailable selection rather than silently falling back", () => {
  const output = withProviderControls(event(), false, {
    agents: [],
    value: "dsh-agent-missing-reviewer",
    warnings: ["ignored"],
    warned: true,
  });
  const control = output.config.controls?.find((entry) => entry.key === "agent");
  assert.ok(control && control.type === "select");
  assert.equal(control.choices.at(-1)?.value, "dsh-agent-missing-reviewer");
  assert.match(control.choices.at(-1)?.description ?? "", /no longer available/);
  assert.equal(output.config.providerOptions?.agent, "dsh-agent-missing-reviewer");
});
