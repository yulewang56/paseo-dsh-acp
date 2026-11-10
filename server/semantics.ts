import { isAbsolute } from "node:path";
import type { ProviderInput } from "@getpaseo/plugin/server/provider";

function unsupported(field: string): never {
  throw new Error(`DSH ACP does not support ${field}; the request was not applied`);
}

export function validateDshInput(input: ProviderInput): void {
  if (input.type === "session.open") {
    const config = input.config;
    if (config.systemPrompt?.trim()) unsupported("Paseo systemPrompt; configure DSH instructions instead");
    if (!config.persist) unsupported("persist=false; the official ACP profile always persists sessions");
    if (config.toolPolicy?.preapproved.length) unsupported("toolPolicy.preapproved");
    if (config.mode) unsupported("agent modes");
    if (Object.keys(config.providerOptions ?? {}).length) unsupported("providerOptions");
    if (Object.keys(config.settings).length) unsupported("generic settings; use model and thinkingOption");
    if (input.persistence) {
      const value = input.persistence;
      if (value.version !== 1 || typeof value.data !== "object" || value.data === null ||
          Array.isArray(value.data) || typeof value.data.sessionId !== "string" || !value.data.sessionId) {
        throw new Error("Invalid DSH persistence handle; refusing to create a replacement session");
      }
    }
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.type === "sse") unsupported(`SSE MCP server '${name}'; use stdio or Streamable HTTP`);
      if (server.type === "stdio" && !isAbsolute(server.command)) {
        throw new Error(`DSH MCP server '${name}' requires an absolute executable path`);
      }
    }
  } else if (input.type === "session.configure") {
    if (input.changes.mode !== undefined) unsupported("agent modes");
    if (Object.keys(input.changes.settings ?? {}).length) unsupported("generic settings");
    // Newer daemons send providerOptions in addition to legacy settings.
    if ("providerOptions" in input.changes && input.changes.providerOptions &&
        Object.keys(input.changes.providerOptions).length) unsupported("providerOptions");
  } else if (input.type === "session.prompt") {
    if (input.prompt.delivery === "steer") unsupported("non-interrupting steering");
    if (input.prompt.input.type === "command") unsupported("native slash commands");
    if (input.prompt.outputSchema !== undefined) unsupported("structured output schemas");
    if (input.prompt.clearPendingPermissions) unsupported("clearPendingPermissions");
  } else if (input.type === "session.permission") {
    const response = input.response;
    if (response.selectedActionId !== undefined &&
        response.selectedActionId !== (response.behavior === "allow" ? "allow-once" : "reject-once")) {
      throw new Error("DSH permission action does not match the requested single-use allow/deny behavior");
    }
    if (response.behavior === "allow") {
      if (Object.keys(response.updatedInput ?? {}).length) unsupported("permission input rewriting");
      if (response.updatedPermissions?.length) unsupported("persistent permission grants");
    } else {
      if (response.interrupt) unsupported("deny-and-interrupt; reject once, then stop the agent separately");
      if (response.message?.trim()) unsupported("permission rejection messages");
    }
  }
}
