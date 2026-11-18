import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createDshProvider } from "./provider.ts";
import { defaultSettings } from "../shared/settings.ts";
import { effectiveSettings } from "./settings.ts";
import { discoverAgentDefinitions } from "./agents.mjs";
import * as yaml from "yaml";

const command = process.env.DSH_TEST_COMMAND ?? (process.env.PATH ?? "").split(delimiter)
  .map((path) => join(path, process.platform === "win32" ? "dsh.cmd" : "dsh"))
  .find((path) => existsSync(path));

test("real DSH loads Claude/Copilot slash bodies through the native registry with a loopback model", {
  skip: !command,
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-compat-skills-real-"));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "local-completion", object: "chat.completion.chunk", created: 1,
      model: "compat-test", choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    response.end(chunk({ role: "assistant", content: "SKILLS_OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connection: Awaited<ReturnType<ReturnType<typeof createDshProvider>["connect"]>> | undefined;
  try {
    const project = join(directory, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    for (const [relative, name, marker] of [
      [".claude/skills/compat-claude/SKILL.md", "compat-claude", "CLAUDE_BODY_NATIVE_OK"],
      [".copilot/skills/compat-copilot.md", "compat-copilot", "COPILOT_BODY_NATIVE_OK"],
    ]) {
      const path = join(project, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `---\nname: ${name}\ndescription: Local integration fixture\n---\n${marker}`);
    }
    for (const [folder, name] of [["extra-skills", "plugin-extra"], ["profile-skills", "profile-extra"]]) {
      await mkdir(join(directory, folder));
      await writeFile(join(directory, folder, `${name}.md`), `---\nname: ${name}\ndescription: Custom directory\n---\nCustom skill body.`);
    }
    const agentDir = join(directory, "extra-agents");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings-agent.md"), "---\nname: settings-agent\ndescription: Plugin configured agent\nmodel: sonnet\n---\nSETTINGS_AGENT_BODY_OK. Follow user instructions.");
    let values = { ...defaultSettings(), agentDirs: [agentDir], skillDirs: [join(directory, "extra-skills")],
      modelAliases: { sonnet: { provider: "compat-local", model: "compat-test" } } };
    const patch = join(directory, "profile.json");
    await writeFile(patch, JSON.stringify([
      { id: "llm-pi-ai", config: { providers: { "compat-local": {
        api: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: "DSH_COMPAT_TEST_KEY", models: [{ id: "compat-test", contextWindow: 32768, maxTokens: 512, reasoningEfforts: false }],
      } } } },
      { id: "agent-default-model", config: { provider: "compat-local", model: "compat-test" } },
      { id: "acp", config: { provider: "compat-local", model: "compat-test" } },
      { id: "session-persistence-jsonl", config: { root: join(directory, "sessions") } },
      { id: "skill-filesystem", config: { customSkillDirs: [join(directory, "profile-skills")] } },
    ]));
    connection = await createDshProvider(async () => values).connect({
      versions: [1], capabilities: ["prompt.message", "prompt.command", "session.persistence", "session.configure"],
      launch: { command: command!, args: ["--profile", "acp", "--patch", patch], env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        DSH_HOME: join(directory, "home"), DSH_AGENTS_HOME: join(directory, "agents-home"), DSH_COMPAT_TEST_KEY: "local-fixture",
      } },
    });
    const events: ProviderEvent[] = [];
    const off = connection.onEvent((event) => events.push(event));
    const sendUntil = async (input: ProviderInput, done: (event: ProviderEvent) => boolean) => {
      const start = events.length;
      await connection!.send(input);
      for (let attempt = 0; attempt < 1500; attempt++) {
        const received = events.slice(start);
        const failure = received.find((event) => event.type === "request.failed" ||
          (event.type === "session.turn" && event.state === "failed") || event.type === "session.runtime_failed");
        if (failure) assert.fail(JSON.stringify(failure));
        const result = received.find(done);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`Timed out: ${JSON.stringify(events.slice(start))}`);
    };
    const discovered = await discoverAgentDefinitions({ cwd: project, yaml,
      env: effectiveSettings(values, {}).env });
    const selected = discovered.agents.find((entry) => entry.name === "settings-agent");
    assert.ok(selected?.availableForRoot);
    const config = { cwd: project, env: {}, mcpServers: {}, settings: {}, persist: true,
      providerOptions: { agent: selected.presetId },
      model: '["compat-local","compat-test"]' };
    const opened = await sendUntil({ type: "session.open", requestId: "open", sessionId: "compat", history: "skip", config },
      (event) => event.type === "session.ready");
    assert.ok(opened);
    const commands = events.find((event) => event.type === "session.commands");
    assert.ok(commands?.type === "session.commands");
    assert.ok(commands.commands.some((entry) => entry.name === "compat-claude"));
    assert.ok(commands.commands.some((entry) => entry.name === "compat-copilot"));
    assert.ok(commands.commands.some((entry) => entry.name === "plugin-extra"));
    assert.ok(commands.commands.some((entry) => entry.name === "profile-extra"));
    const controls = events.findLast((event) => event.type === "session.config");
    assert.ok(controls?.type === "session.config" && controls.config.providerOptions?.agent === selected.presetId);
    for (const [name, marker] of [["compat-claude", "CLAUDE_BODY_NATIVE_OK"], ["compat-copilot", "COPILOT_BODY_NATIVE_OK"]]) {
      const before = requests.length;
      await sendUntil({ type: "session.prompt", sessionId: "compat", prompt: {
        clientMessageId: name, delivery: "auto", input: { type: "command", name, arguments: "Reply SKILLS_OK. Do not use tools." },
      } }, (event) => event.type === "session.turn" && event.state === "completed");
      assert.ok(requests.length > before);
      assert.match(requests.at(-1)!, new RegExp(marker));
      assert.match(requests.at(-1)!, /skill_content/);
      assert.match(requests.at(-1)!, /SETTINGS_AGENT_BODY_OK/);
    }
    const persisted = events.find((event) => event.type === "session.opened");
    assert.ok(persisted?.type === "session.opened" && persisted.persistence);
    await sendUntil({ type: "session.close", requestId: "close", sessionId: "compat" },
      (event) => event.type === "request.completed");
    values = { ...values, claudeSkills: false, copilotSkills: false };
    await sendUntil({ type: "session.open", requestId: "resume", sessionId: "resumed", history: "skip", config, persistence: persisted.persistence },
      (event) => event.type === "session.ready");
    const resumed = events.findLast((event) => event.type === "session.commands" && event.sessionId === "resumed");
    assert.ok(resumed?.type === "session.commands");
    assert.ok(!resumed.commands.some((entry) => entry.name === "compat-copilot" || entry.name === "compat-claude"));
    assert.ok(resumed.commands.some((entry) => entry.name === "plugin-extra"));
    assert.ok(resumed.commands.some((entry) => entry.name === "profile-extra"));
    off();
  } finally {
    await connection?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
