import { z } from "zod";

export const autoAcceptPresentation = {
  label: "Auto Accept",
  description: "Auto accept permission prompts",
  icon: "ShieldCheck",
} as const;

export const autoAcceptPersistence = z.object({
  version: z.literal(1),
  data: z.object({ sessionId: z.string(), auto_accept: z.boolean().optional() }),
});
