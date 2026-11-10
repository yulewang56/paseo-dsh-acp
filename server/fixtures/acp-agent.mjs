import { createInterface } from "node:readline";

const sessionId = "11111111-2222-4333-8444-555555555555";
let model = '["fixture","alpha"]';
let effort = "high";
let prompt;
let permission;
let sequence = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: [{ group: "fixture", name: "Fixture", options: ["alpha", "beta"].map(
      (id) => ({ value: JSON.stringify(["fixture", id]), name: id }),
    ) }] },
  { id: "reasoning_effort", name: "Reasoning", category: "thought_level", type: "select",
    currentValue: effort, options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] },
];
const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
const complete = (text, stopReason = "end_turn") => {
  update({ sessionUpdate: "agent_message_chunk", messageId: `reply-${++sequence}`,
    content: { type: "text", text } });
  reply(prompt.id, { stopReason });
  prompt = undefined;
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!("method" in message)) {
    if (permission && message.id === permission) {
      permission = undefined;
      if (message.error) {
        complete(`permission-error: ${JSON.stringify(message.error)}`);
      } else {
        complete(message.result.outcome.optionId ?? message.result.outcome.outcome);
      }
    }
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: 1, agentInfo: { name: "dsh-test", version: "1" },
        agentCapabilities: { sessionCapabilities: { resume: {}, list: {}, close: {} },
          promptCapabilities: { image: true } }, authMethods: [] });
      break;
    case "session/new":
      reply(id, { sessionId, configOptions: options() });
      break;
    case "session/close":
      reply(id, {});
      break;
    case "session/list":
      reply(id, params.cursor
        ? { sessions: [{ sessionId: "old", cwd: "/project", title: "needle" }], nextCursor: null }
        : { sessions: [{ sessionId: "new", cwd: "/project", title: "recent" }], nextCursor: "page2" });
      break;
    case "session/set_config_option":
      if (params.configId === "model" && ['["fixture","alpha"]', '["fixture","beta"]'].includes(params.value)) {
        model = params.value;
      } else if (params.configId === "reasoning_effort" && ["off", "high"].includes(params.value)) {
        effort = params.value;
      } else {
        send({ id, error: { code: -32602, message: "unknown model or effort" } });
        break;
      }
      reply(id, { configOptions: options() });
      break;
    case "session/prompt": {
      prompt = message;
      const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("");
      if (text === "wait") {
        send({ method: "session/update", params: { sessionId, update: {
          sessionUpdate: "tool_call", toolCallId: `pending-${id}`,
          title: "Pending fixture tool", status: "in_progress", rawInput: {},
        } } });
        break;
      }
      if (text === "permission") {
        permission = `permission-${++sequence}`;
        send({ id: permission, method: "session/request_permission", params: {
          sessionId, toolCall: { toolCallId: permission, title: "Fixture tool" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        } });
        break;
      }
      if (text === "tool-error") {
        update({ sessionUpdate: "tool_call", toolCallId: "empty-error",
          title: "Failed fixture tool", status: "failed", rawInput: {}, rawOutput: null });
      }
      if (text === "error") {
        send({ id, error: { code: -32603, message: "turn failed: fixture API failure" } });
        prompt = undefined;
        break;
      }
      if (text === "crash") { process.exit(12); }
      complete(text, text === "limit" ? "max_tokens" : "end_turn");
      break;
    }
    case "session/cancel":
      if (prompt) {
        reply(prompt.id, { stopReason: "cancelled" });
        prompt = undefined;
        permission = undefined;
      }
      break;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Unsupported: ${method}` } });
  }
});
lines.on("close", () => process.exit(0));
