import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { compatibilityProviderClass, mergeFilesystemConfig } from "./skill-filesystem.mjs";

const binary = process.env.DSH_TEST_COMMAND ?? (process.env.PATH ?? "").split(delimiter)
  .map((path) => join(path, process.platform === "win32" ? "dsh.cmd" : "dsh"))
  .find((path) => existsSync(path));
const native = binary ? await import(pathToFileURL(createRequire(realpathSync(binary))
  .resolve("@deepseek-ai/dsh-skill-filesystem")).href) : undefined;

async function fixture(t, watch = false) {
  if (!native) { t.skip("DSH filesystem skills package is not installed"); return; }
  const root = await mkdtemp(join(tmpdir(), "paseo-compat-skills-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  const controller = new AbortController();
  let invalidations = 0;
  const warnings = [];
  const Provider = compatibilityProviderClass(native.FileSystemSkillProvider, home);
  const config = {
    dshHome: join(home, ".dsh"), agentsHome: join(home, ".agents"),
    watch, watchPollIntervalMs: 20, watchStabilityThresholdMs: 25,
  };
  const provider = new Provider({ get() {}, logger: { warn: (message) => warnings.push(message) } },
    { signal: controller.signal, invalidate() { invalidations++; } }, config);
  t.after(async () => { controller.abort(); await provider.dispose(); await rm(root, { recursive: true, force: true }); });
  const write = async (relative, text) => {
    const path = resolve(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
    return path;
  };
  return { root, home, project, provider, write, warnings, config, Provider,
    invalidations: () => invalidations };
}

const skill = (name, body = "Skill instructions.") => `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`;
const candidates = (result) => Array.isArray(result) ? result : result.candidates;

test("settings disable compatibility registry roots while adding to native profile custom dirs", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const [path, name] of [
    ["project/.claude/skills/claude.md", "claude"], ["home/.copilot/skills/copilot.md", "copilot"],
    ["profile-skills/native.md", "native"], ["extra-skills/extra.md", "extra"],
  ]) await f.write(path, skill(name));
  const profileDir = join(f.root, "profile-skills");
  const config = mergeFilesystemConfig({ ...f.config, customSkillDirs: [profileDir] }, {
    claudeSkills: false, copilotSkills: false, customSkillDirs: [profileDir, join(f.root, "extra-skills")],
  });
  assert.deepEqual(config.customSkillDirs, [profileDir, join(f.root, "extra-skills")]);
  assert.equal(config.watch, f.config.watch);
  const controller = new AbortController();
  const provider = new f.Provider({ get() {}, logger: { warn() {} } },
    { signal: controller.signal, invalidate() {} }, config);
  try {
    assert.deepEqual(candidates(await provider.list({ cwd: f.project })).map((entry) => entry.name).sort(), ["extra", "native"]);
    assert.ok(!(await provider.roots(f.project)).some((root) => /claude|copilot/.test(root.source)));
  } finally { controller.abort(); await provider.dispose(); }
});

test("extends native roots while keeping profile options and cwd isolation", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await f.write("project/.claude/skills/claude-project/SKILL.md", skill("claude-project", "Claude body."));
  await f.write("project/.copilot/skills/copilot-project.md", skill("copilot-project", "Copilot body."));
  await f.write("home/.claude/skills/claude-user.md", skill("claude-user"));
  await f.write("home/.copilot/skills/copilot-user/SKILL.md", skill("copilot-user"));
  const list = candidates(await f.provider.list({ cwd: f.project }));
  assert.deepEqual(list.map((candidate) => candidate.name).sort(), ["claude-project", "claude-user", "copilot-project", "copilot-user"]);
  const bundle = await f.provider.get(list.find((candidate) => candidate.name === "claude-project"), {});
  assert.equal(bundle.content, "Claude body.");
  assert.equal(bundle.resourceBase.path, join(f.project, ".claude/skills/claude-project"));
  const flat = await f.provider.get(list.find((candidate) => candidate.name === "copilot-project"), {});
  assert.equal(flat.content, "Copilot body.");
  assert.equal(flat.resourceBase.path, join(f.project, ".copilot/skills"));
  const other = join(f.root, "other");
  await mkdir(other);
  assert.deepEqual(candidates(await f.provider.list({ cwd: other })).map((candidate) => candidate.name).sort(), ["claude-user", "copilot-user"]);
  const controller = new AbortController();
  const explicit = new f.Provider({ get() {}, logger: { warn() {} } },
    { signal: controller.signal, invalidate() {} }, { ...f.config, includeDefaultRoots: false, customSkillDirs: [join(f.project, ".copilot/skills")] });
  try {
    assert.deepEqual(candidates(await explicit.list({ cwd: f.project })).map((candidate) => candidate.name), ["copilot-project"]);
  } finally { controller.abort(); await explicit.dispose(); }
});

test("deduplicates linked native/compatibility roots and canonical skill files", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const original = await f.write("project/.github/skills/original/SKILL.md", skill("original"));
  await mkdir(join(f.project, ".agents"));
  await symlink(join(f.project, ".github/skills"), join(f.project, ".agents/skills"), "dir");
  await mkdir(join(f.project, ".claude/skills"), { recursive: true });
  await symlink(original, join(f.project, ".claude/skills/alias.md"));
  const roots = await f.provider.roots(f.project);
  assert.ok(roots.some((root) => root.source === "project-agents"));
  assert.ok(!roots.some((root) => root.source === "project-github"));
  const list = candidates(await f.provider.list({ cwd: f.project }));
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "project-agents");
  assert.equal((await f.provider.get(list[0], {})).content, "Skill instructions.");
});

test("retains distinct same-name candidates with native precedence", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await f.write("project/.agents/skills/reviewer.md", skill("reviewer", "Native."));
  await f.write("project/.claude/skills/reviewer.md", skill("reviewer", "Claude."));
  await f.write("project/.copilot/skills/reviewer.md", skill("reviewer", "Copilot."));
  await f.write("project/.github/skills/reviewer/SKILL.md", skill("reviewer", "GitHub."));
  const list = candidates(await f.provider.list({ cwd: f.project }));
  assert.deepEqual(list.map((candidate) => candidate.rank), [200, 700, 710, 720]);
  assert.equal((await f.provider.get(list[0], {})).content, "Native.");
});

test("native watchers invalidate on creation and removal and dispose cleanly", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, true);
  if (!f) return;
  await f.provider.list({ cwd: f.project });
  const wait = async (predicate) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("native compatibility skill watcher did not invalidate");
  };
  await f.write("project/.claude/skills/new-skill/SKILL.md", skill("new-skill"));
  await wait(() => f.invalidations() > 0);
  assert.ok(candidates(await f.provider.list({ cwd: f.project })).some((candidate) => candidate.name === "new-skill"));
  const count = f.invalidations();
  await rm(join(f.project, ".claude/skills/new-skill/SKILL.md"));
  await wait(() => f.invalidations() > count);
  assert.ok(!candidates(await f.provider.list({ cwd: f.project })).some((candidate) => candidate.name === "new-skill"));
  await f.provider.dispose();
  const stopped = f.invalidations();
  await f.write("project/.claude/skills/new-skill/SKILL.md", skill("new-skill"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.invalidations(), stopped);
});

test("native malformed file and root errors are explicit, not successful empty discovery", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await f.write("project/.claude/skills/invalid.md", "---\nname: invalid\ndescription: [\n---\nBody");
  await f.provider.list({ cwd: f.project });
  assert.match(f.warnings.join("\n"), /invalid YAML/);
  const failure = new Error("permission denied");
  failure.code = "EACCES";
  const ctx = { get: () => ({ resolve: async () => { throw failure; } }), logger: { warn: (message) => f.warnings.push(message) } };
  const controller = new AbortController();
  const provider = new f.Provider(ctx, { signal: controller.signal, invalidate() {} }, f.config);
  try {
    let result;
    try { result = await provider.list({ cwd: f.project }); }
    catch (error) { assert.match(error.message, /permission denied/); return; }
    assert.ok(!Array.isArray(result));
    assert.equal(result.complete, false);
    assert.match(f.warnings.join("\n"), /permission denied/);
  } finally { controller.abort(); await provider.dispose(); }
});
