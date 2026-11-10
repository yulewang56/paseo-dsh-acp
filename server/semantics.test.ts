import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { validateDshInput } from "./semantics.ts";

export const config: ProviderSessionConfig = {
  cwd: "/project", env: {}, mcpServers: {}, settings: {}, persist: true,
};

test("unsupported launch settings fail explicitly before launching or replacing a session", () => {
  for (const patch of [
    { systemPrompt: "instructions" }, { persist: false }, { mode: "plan" },
    { providerOptions: { fast: true } }, { settings: { arbitrary: "ignored" } },
    { toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "tools", tool: "*" }] } },
    { mcpServers: { server: { type: "sse" as const, url: "http://localhost/mcp" } } },
    { mcpServers: { server: { type: "stdio" as const, command: "node" } } },
  ]) {
    assert.throws(() => validateDshInput({
      type: "session.open", requestId: "open", sessionId: "session",
      history: "skip", config: { ...config, ...patch },
    }));
  }
  assert.throws(() => validateDshInput({
    type: "session.open", requestId: "open", sessionId: "session",
    history: "skip", config, persistence: { version: 1, data: {} },
  }), /refusing to create a replacement/);
  assert.doesNotThrow(() => validateDshInput({
    type: "session.open", requestId: "open", sessionId: "session",
    history: "skip", persistence: { version: 1, data: { sessionId: "session" } },
    config: {
      ...config, toolPolicy: { preapproved: [] }, providerOptions: {}, systemPrompt: "",
      mcpServers: { server: { type: "stdio", command: process.execPath } },
    },
  }));
});

test("unsupported prompt and configuration semantics are not downgraded into ordinary text", () => {
  const prompt = {
    clientMessageId: "message", delivery: "auto" as const,
    input: { type: "message" as const, content: [{ type: "text" as const, text: "hello" }] },
  };
  for (const patch of [
    { delivery: "steer" as const },
    { input: { type: "command" as const, name: "plan", arguments: "" } },
    { outputSchema: {} }, { clearPendingPermissions: true },
  ]) {
    assert.throws(() => validateDshInput({
      type: "session.prompt", sessionId: "session", prompt: { ...prompt, ...patch },
    }), /does not support/);
  }
  const withOptions = {
    type: "session.configure" as const, requestId: "change", sessionId: "session",
    changes: { settings: {}, providerOptions: { ignored: true } },
  };
  assert.throws(() => validateDshInput(withOptions), /providerOptions/);
  assert.throws(() => validateDshInput({
    type: "session.configure", requestId: "change", sessionId: "session",
    changes: { mode: "plan" },
  }), /agent modes/);
  assert.doesNotThrow(() => validateDshInput({
    type: "session.configure", requestId: "change", sessionId: "session",
    changes: { model: '["route","model"]', thinkingOption: "high" },
  }));
});

test("single-use permission decisions do not silently become persistent grants or rewrites", () => {
  for (const response of [
    { behavior: "allow" as const, updatedInput: { command: "changed" } },
    { behavior: "allow" as const, updatedPermissions: [{}] },
    { behavior: "deny" as const, interrupt: true },
    { behavior: "deny" as const, message: "reason that cannot be conveyed" },
  ]) {
    assert.throws(() => validateDshInput({
      type: "session.permission", sessionId: "session", permissionId: "permission", response,
    }), /does not support/);
  }
  for (const response of [
    { behavior: "allow" as const, selectedActionId: "allow-once" },
    { behavior: "deny" as const, selectedActionId: "reject-once" },
  ]) {
    assert.doesNotThrow(() => validateDshInput({
      type: "session.permission", sessionId: "session", permissionId: "permission", response,
    }));
  }
});

test("session.open without a persist flag is rejected instead of silently persisting", () => {
  assert.throws(() => validateDshInput({
    type: "session.open", requestId: "open", sessionId: "session", history: "skip",
    config: { ...config, persist: undefined as unknown as boolean },
  }), /persist=false/);
});
