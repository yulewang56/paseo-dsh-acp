import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const nonempty = z.string().trim().min(1);
export const discoveryPath = nonempty.refine(
  (path) => !/[\0\r\n]/.test(path) && /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(path),
  "Use an absolute host path or ~/path (not a relative path or ~other-user).",
);
const paths = z.array(discoveryPath).transform((entries) => [...new Set(entries)]);
export const aliasesSchema = z.partialRecord(
  z.enum(["sonnet", "opus", "haiku", "fable", "opusplan"]),
  z.object({
    provider: nonempty.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    model: nonempty,
    reasoningEffort: nonempty.optional(),
  }).strict(),
);
export const settingsSchema = z.object({
  agentDirs: paths.default([]),
  skillDirs: paths.default([]),
  claudeSkills: z.boolean().default(true),
  copilotSkills: z.boolean().default(true),
  modelAliases: aliasesSchema.default({}),
}).strict();
export type DshSettings = z.output<typeof settingsSchema>;
export const defaultSettings = (): DshSettings => settingsSchema.parse({});
export const dshSettings = defineSettings({
  id: "discovery", scope: "host", version: 1, schema: settingsSchema,
});

export function parseSettingsForm(form: {
  agentDirs: string; skillDirs: string; modelAliases: string;
  claudeSkills: boolean; copilotSkills: boolean;
}): DshSettings {
  const lines = (text: string) => text.trim() === "" ? [] : text.trim().split(/\r?\n/);
  return settingsSchema.parse({
    ...form, agentDirs: lines(form.agentDirs), skillDirs: lines(form.skillDirs),
    modelAliases: JSON.parse(form.modelAliases),
  });
}
