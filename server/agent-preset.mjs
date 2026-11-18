/**
 * Agent-scoped plugin that applies one DSH agent definition.
 *
 * It reads only data from the parsed definition. It never imports or executes
 * user-authored code, hooks, MCP servers, or permission changes.
 */
export const name = "paseo-agent-definition";
export const inject = ["systemPrompt", "tools"];

export function apply(ctx, config) {
  const prompt = typeof config?.prompt === "string" ? config.prompt : "";
  if (prompt.trim() !== "") {
    ctx.effect(() => ctx.systemPrompt.section({
      name: "deployment:persona-prefix",
      order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
      text: prompt,
      interpolate: false,
    }), "paseo-agent-definition.persona");
  }

  const tools = config?.tools;
  if (tools?.none === true) {
    const names = ctx.tools.definitions()
      .map((definition) => definition.name)
      .filter((name) => name !== "run_code");
    if (names.length > 0) {
      ctx.effect(() => ctx.tools.restrict({ deny: names }), "paseo-agent-definition.tools.none");
    }
    return;
  }
  const allow = Array.isArray(tools?.allow) ? tools.allow : [];
  const deny = Array.isArray(tools?.deny) ? tools.deny : [];
  if (allow.length === 0 && deny.length === 0) return;
  const filter = {};
  if (allow.length > 0) filter.allow = [...allow];
  if (deny.length > 0) filter.deny = [...deny];
  ctx.effect(() => ctx.tools.restrict(filter), "paseo-agent-definition.tools");
}
