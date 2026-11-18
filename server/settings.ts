import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { aliasesSchema, defaultSettings, settingsSchema, type DshSettings } from "../shared/settings.ts";

export type ReadSettings = () => Promise<DshSettings>;
export const readDefaultSettings: ReadSettings = async () => defaultSettings();

export function effectiveSettings(values: DshSettings, env: Readonly<Record<string, string>>) {
  const settings = settingsSchema.parse(values);
  const expand = (path: string) => resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  const unique = (entries: string[]) => [...new Set(entries.map(expand))];
  let aliases = settings.modelAliases;
  if (env.DSH_ACP_MODEL_ALIASES?.trim()) {
    try {
      aliases = { ...aliases, ...aliasesSchema.parse(JSON.parse(env.DSH_ACP_MODEL_ALIASES)) };
    } catch (error) {
      throw new Error(`Invalid DSH_ACP_MODEL_ALIASES: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const agentDirs = unique([
    ...(env.DSH_ACP_AGENT_DIRS?.split(delimiter).map((path) => path.trim()).filter(Boolean) ?? []),
    ...settings.agentDirs,
  ]);
  const effectiveEnv: Record<string, string> = {
    ...env, DSH_ACP_AGENT_DIRS: agentDirs.join(delimiter), DSH_ACP_MODEL_ALIASES: JSON.stringify(aliases),
  };
  return {
    env: effectiveEnv,
    skills: {
      claudeSkills: settings.claudeSkills, copilotSkills: settings.copilotSkills,
      customSkillDirs: unique(settings.skillDirs),
    },
  };
}
