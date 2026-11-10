import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createDshProvider } from "./provider.ts";

test("official DSH: pagination, opaque model choices, cancel, next prompt and same-session replay", {
  skip: !process.env.DSH_TEST_COMMAND || !process.env.DSH_TEST_MODEL,
  timeout: 120000,
}, async () => {
  const command = process.env.DSH_TEST_COMMAND!;
  const selected: unknown = JSON.parse(process.env.DSH_TEST_MODEL!);
  assert.ok(Array.isArray(selected) && selected.length === 2 &&
    selected.every((value) => typeof value === "string"));
  const directory = await mkdtemp(join(tmpdir(), "dsh-semantic-test-"));
  const patch = join(directory, "overlay.json");
  const sessionRoot = join(directory, "sessions");
  await writeFile(patch, JSON.stringify([{
    id: "acp", config: { provider: selected[0], model: selected[1], sessionListPageSize: 1 },
  }, {
    id: "session-persistence-jsonl", config: { root: sessionRoot },
  }]));
  const connection = await createDshProvider().connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.command", "session.configure", "session.persistence",
      "session.list", "permission", "prompt.steer"],
    launch: {
      command, args: ["--profile", "acp", "--patch", patch],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      )), DSH_ACP_SESSION_ROOT: sessionRoot },
    },
  }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const wait = (predicate: (event: ProviderEvent) => boolean, timeout = 60000) =>
    new Promise<ProviderEvent>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("Official DSH test timed out")); }, timeout);
      const off = connection.onEvent((event) => {
        if (predicate(event)) {
          clearTimeout(timer);
          off();
          resolve(event);
        }
      });
    });
  const request = async (input: ProviderInput) => {
    if (!("requestId" in input)) throw new Error("Missing request ID");
    const pending = wait((event) => "requestId" in event && event.requestId === input.requestId &&
      ["request.completed", "request.failed", "session.ready", "catalog", "sessions"].includes(event.type));
    await connection.send(input);
    const response = await pending;
    await setImmediate();
    if (response.type === "request.failed") throw new Error(response.error.message);
    return response;
  };
  const baseConfig = { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true };
  try {
    assert.ok(!connection.capabilities.includes("prompt.steer"));
    assert.ok(!connection.capabilities.includes("prompt.command"));
    for (const id of ["seed-one", "seed-two"]) {
      await request({
        type: "session.open", requestId: `open:${id}`, sessionId: id,
        history: "skip", config: baseConfig,
      });
      await request({ type: "session.close", requestId: `close:${id}`, sessionId: id });
    }
    const listed = await request({ type: "sessions", requestId: "list" });
    assert.equal(listed.type, "sessions");
    if (listed.type !== "sessions") assert.fail();
    assert.equal(listed.sessions.length, 2);
    await request({
      type: "session.open", requestId: "open", sessionId: "real",
      history: "skip", config: baseConfig,
    });
    const opened = events.find((event) => event.type === "session.opened" && event.sessionId === "real");
    assert.ok(opened?.type === "session.opened" && opened.persistence);
    const persistence = opened.persistence;
    const state = events.filter((event) => event.type === "session.config").at(-1)?.config;
    assert.ok(state);
    for (const model of state.models) {
      await request({
        type: "session.configure", requestId: `model:${model.id}`, sessionId: "real",
        changes: { model: model.id },
      });
      assert.equal(events.filter((event) => event.type === "session.config").at(-1)?.config.model, model.id);
    }
    await request({
      type: "session.configure", requestId: "restore-model", sessionId: "real",
      changes: { model: process.env.DSH_TEST_MODEL },
    });
    const choices = events.filter((event) => event.type === "session.config").at(-1)?.config.thinkingOptions ?? [];
    for (const choice of choices) {
      await request({
        type: "session.configure", requestId: `effort:${choice.id}`, sessionId: "real",
        changes: { thinkingOption: choice.id },
      });
      assert.equal(events.filter((event) => event.type === "session.config").at(-1)?.config.thinkingOption, choice.id);
    }
    const failed = wait((event) => event.type === "request.failed" && event.requestId === "invalid-model");
    await connection.send({
      type: "session.configure", requestId: "invalid-model", sessionId: "real",
      changes: { model: '["not-a-route","not-a-model"]' },
    });
    await failed;
    const start = wait((event) => event.type === "session.turn" && event.turnId === "acp:cancel" && event.state === "started");
    await connection.send({
      type: "session.prompt", sessionId: "real", prompt: {
        clientMessageId: "cancel", delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Do not use tools. Count slowly from 1 to 10000." }] },
      },
    });
    await start;
    const canceled = wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:cancel" && event.state === "canceled");
    await request({ type: "session.interrupt", requestId: "cancel-turn", sessionId: "real" });
    await canceled;
    const completed = wait((event) => event.type === "session.turn" &&
      event.turnId === "acp:next" && event.state !== "started");
    await connection.send({
      type: "session.prompt", sessionId: "real", prompt: {
        clientMessageId: "next", delivery: "auto",
        input: { type: "message", content: [{
          type: "text", text: "Do not use tools or change files. Only reply DSH_SEMANTICS_OK.",
        }] },
      },
    });
    const terminal = await completed;
    assert.ok(terminal.type === "session.turn" && terminal.state === "completed");
    assert.ok(events.some((event) => event.type === "timeline.item" &&
      event.item.type === "assistant_message" && event.item.text.includes("DSH_SEMANTICS_OK")));
    await request({ type: "session.close", requestId: "close", sessionId: "real" });
    const offset = events.length;
    await request({
      type: "session.open", requestId: "resume", sessionId: "restored",
      config: baseConfig, history: "replay", persistence,
    });
    const replay = events.slice(offset);
    assert.ok(replay.some((event) => event.type === "session.opened" &&
      JSON.stringify(event.persistence) === JSON.stringify(persistence)));
    assert.ok(replay.some((event) => event.type === "timeline.item" &&
      event.item.type === "assistant_message" && event.item.text.includes("DSH_SEMANTICS_OK")));
    console.log(JSON.stringify({
      officialDsh: true, pagesTraversed: listed.sessions.length,
      modelsVerified: state.models.length, reasoningOptionsVerified: choices.length,
      cancellationAndNextPrompt: true, restoredSameSessionWithHistory: true,
    }));
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
