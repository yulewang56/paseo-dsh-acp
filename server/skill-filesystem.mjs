import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "paseo-skill-filesystem";
export const inject = ["skills", "loader"];

function absent(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function projectRootFor(cwd) {
  let current = resolve(cwd);
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** Extend native filesystem discovery without reimplementing parsing or watching. */
export function compatibilityProviderClass(NativeProvider, home = homedir()) {
  if (typeof NativeProvider?.prototype.roots !== "function") {
    throw new Error("This DSH filesystem provider does not expose the supported roots hook");
  }
  return class extends NativeProvider {
    constructor(ctx, control, config = {}) {
      super(ctx, control, config);
      this.compatibilityRoots = config.includeDefaultRoots !== false;
      this.claudeSkills = config.paseoCompatibility?.claudeSkills !== false;
      this.copilotSkills = config.paseoCompatibility?.copilotSkills !== false;
    }

    async roots(cwd) {
      const roots = await super.roots(cwd);
      if (this.compatibilityRoots && cwd !== undefined) {
        const projectRoot = await projectRootFor(cwd);
        if (this.claudeSkills) roots.push({ path: join(projectRoot, ".claude/skills"), source: "project-claude", rank: 700, projectRoot });
        if (this.copilotSkills) roots.push(
          { path: join(projectRoot, ".copilot/skills"), source: "project-copilot", rank: 710, projectRoot },
          { path: join(projectRoot, ".github/skills"), source: "project-github", rank: 720, projectRoot },
        );
      }
      if (this.compatibilityRoots) {
        if (this.claudeSkills) roots.push({ path: join(home, ".claude/skills"), source: "user-claude", rank: 800 });
        if (this.copilotSkills) roots.push({ path: join(home, ".copilot/skills"), source: "user-copilot", rank: 810 });
      }
      roots.sort((a, b) => a.rank - b.rank);
      const seen = new Set();
      const unique = [];
      for (const root of roots) {
        let canonical;
        try {
          canonical = await realpath(root.path);
        } catch (error) {
          if (!absent(error)) throw error;
          // Keep missing roots: the native ancestor watcher discovers creation.
          canonical = resolve(root.path);
        }
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        unique.push(root);
      }
      return unique;
    }

    async list(options) {
      const result = await super.list(options);
      const candidates = Array.isArray(result) ? result : result.candidates;
      const seen = new Set();
      const unique = [];
      for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
        options.signal?.throwIfAborted();
        // Native candidates already expose canonical instruction file paths.
        if (seen.has(candidate.path)) continue;
        seen.add(candidate.path);
        unique.push(candidate);
      }
      return Array.isArray(result) ? unique : { ...result, candidates: unique };
    }
  };
}

export function mergeFilesystemConfig(profile, settings = {}) {
  return {
    ...profile,
    customSkillDirs: [...new Set([...(profile.customSkillDirs ?? []), ...(settings.customSkillDirs ?? [])])],
    paseoCompatibility: { claudeSkills: settings.claudeSkills !== false, copilotSkills: settings.copilotSkills !== false },
  };
}

export async function apply(ctx, settings = {}) {
  const requireDsh = createRequire(realpathSync(process.argv[1]));
  const native = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/dsh-skill-filesystem")).href);
  const loader = await import(pathToFileURL(requireDsh.resolve("@deepseek-ai/cordis-plugin-loader")).href);
  const entry = [...ctx.loader.entries()].find((item) => item.options.id === "skill-filesystem");
  if (!entry || entry.options.name !== "@deepseek-ai/dsh-skill-filesystem") {
    throw new Error("Cannot locate the native DSH filesystem skills configuration");
  }
  const config = mergeFilesystemConfig(native.Config(loader.interpolate(entry.ctx, entry.options.config ?? {})), settings);
  const Provider = compatibilityProviderClass(native.FileSystemSkillProvider);
  let provider;
  ctx.skills.registerProvider((control) => {
    provider = new Provider(ctx, control, config);
    return provider;
  });
  ctx.effect(() => async () => { await provider.dispose(); }, "paseo-skill-filesystem watchers");
  ctx.on("fs/observed", (target, observation, actor) => {
    if (actor?.name === "edit" || actor?.name === "write") provider.observeHostMutation(target.displayPath);
  });
}
