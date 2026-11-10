import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { autoAcceptPresentation } from "../shared/auto-accept.ts";

// The current upstream contract exposes these fields; published SDKs still omit them.
type ProviderOptionControl =
  | {
      type: "toggle"; key: string; label: string; description?: string;
      icon?: string; defaultValue?: boolean;
    }
  | {
      type: "select"; key: string; label: string; description?: string;
      icon?: string; defaultValue?: string;
      choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
    };

declare module "@getpaseo/plugin/server/provider" {
  interface ProviderConfigState {
    controls?: readonly ProviderOptionControl[];
    providerOptions?: ProviderSessionConfig["settings"];
  }
  interface ProviderConfigChanges {
    providerOptions?: ProviderSessionConfig["settings"];
  }
}

export const autoAcceptControl = {
  type: "toggle", key: "auto_accept", ...autoAcceptPresentation,
  defaultValue: false,
} satisfies ProviderOptionControl;
