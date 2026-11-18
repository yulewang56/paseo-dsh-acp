import type * as YAML from "yaml";

export interface AgentToolRestriction {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly none?: boolean;
}

export interface AgentDiagnostic {
  readonly field: string;
  readonly reason: string;
}

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: AgentToolRestriction;
  readonly provider?: string;
  readonly model?: string;
  readonly modelAlias?: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly color?: string;
  readonly argumentHint?: string;
  readonly target?: string;
  readonly rawFrontmatter: string;
  readonly rawData: Record<string, unknown>;
  readonly unsupportedFields: readonly AgentDiagnostic[];
  readonly warnings: readonly string[];
  readonly toolIssues: readonly string[];
  readonly modelIssues: readonly string[];
  readonly availableForRoot: boolean;
  readonly availableForChild: boolean;
  readonly unavailableForRoot?: string;
  readonly unavailableForChild?: string;
  readonly source: "native" | "claude" | "copilot";
  readonly path: string;
  readonly rank: number;
  readonly projectRoot: string;
  readonly contentHash: string;
  readonly presetId: string;
}

export interface AgentDiscoveryOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly signal?: AbortSignal;
  readonly customDirs?: readonly string[];
  readonly yaml: typeof YAML;
  readonly modelAliases?: Readonly<Record<string, unknown>>;
}

export interface AgentDiscovery {
  readonly agents: readonly AgentDefinition[];
  readonly warnings: readonly string[];
}

export interface ResolvedAgentModel {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export const DEFAULT_PRESET_ID: string;
export function parseFrontmatter(text: string, yaml: typeof YAML): {
  data: Record<string, unknown>;
  body: string;
  raw: string;
};
export function parseAgentDocument(text: string, options: {
  readonly source: "native" | "claude" | "copilot";
  readonly path: string;
  readonly nameHint: string;
  readonly rank: number;
  readonly projectRoot: string;
  readonly yaml: typeof YAML;
  readonly modelAliases?: Readonly<Record<string, unknown>>;
}): AgentDefinition;
export function presetIdForDefinition(definition: AgentDefinition): string;
export function discoverAgentDefinitions(options: AgentDiscoveryOptions): Promise<AgentDiscovery>;
export function agentControlChoices(definitions: readonly AgentDefinition[]): ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly description: string;
}>;
export function agentConfigOption(definitions: readonly AgentDefinition[], current?: string): {
  readonly id: "agent";
  readonly name: string;
  readonly description: string;
  readonly type: "select";
  readonly currentValue: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly name: string; readonly description?: string }>;
};
export function agentCatalogText(definitions: readonly AgentDefinition[]): string;
export function findAgentDefinition(definitions: readonly AgentDefinition[], value: string): AgentDefinition | undefined;
export function agentOptionsForDefinition(definition: AgentDefinition): {
  readonly provider?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
} | undefined;
export function resolveAgentModel(
  definition: AgentDefinition,
  llm: {
    listProviders(): Promise<ReadonlyArray<{ readonly id: string }>>;
    listModels(provider: string): Promise<ReadonlyArray<{ readonly id: string }>>;
    resolveModelInfo(provider: string, model: string): Promise<unknown>;
  },
): Promise<ResolvedAgentModel | undefined>;
export function childAgentOptions(
  definition: AgentDefinition,
  selection: ResolvedAgentModel | undefined,
): {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens?: number;
} | undefined;
