import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";
import { historyItemMethod, readDshHistory } from "./history.ts";

const initializeSchema = z.object({
  agentCapabilities: z.object({
    loadSession: z.boolean().optional(),
    sessionCapabilities: z.object({ resume: z.unknown().optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const loadSchema = z.object({ sessionId: z.string(), cwd: z.string() });
const listSchema = z.object({
  sessions: z.array(z.object({
    sessionId: z.string(), cwd: z.string(),
    title: z.string().nullable().optional(), updatedAt: z.string().nullable().optional(),
  }).passthrough()),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

type RequestId = string | number | null;
type HistoryReader = typeof readDshHistory;

/** Per-session auto-accept state shared with the provider wrapper. */
export interface ApprovalState {
  /** Value applied to the next session this connection opens. */
  pending: boolean | undefined;
  /** Effective value keyed by native DSH session ID. */
  bySession: Map<string, boolean>;
}

function toolOutputText(update: Record<string, unknown>): string | undefined {
  if (!Array.isArray(update.content)) return undefined;
  const parts: string[] = [];
  for (const entry of update.content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.type !== "content") continue;
    const block = entry.content;
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
    } else if (typeof block.type === "string") {
      parts.push(`[${block.type} attachment retained in DSH session]`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export class DshAcpCompatibility {
  private readonly initializations = new Set<RequestId>();
  private readonly newSessions = new Set<RequestId>();
  private readonly loads = new Map<RequestId, z.infer<typeof loadSchema>>();
  private readonly prompts = new Map<RequestId, string>();
  private readonly toolCalls = new Map<string, Record<string, unknown>>();
  private readonly lists = new Map<RequestId, {
    params: Record<string, unknown>;
    sessions: z.infer<typeof listSchema>["sessions"];
    cursors: Set<string>;
    sessionIds: Set<string>;
  }>();
  private resumeOnly = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly replay: boolean;
  private readonly readHistory: HistoryReader;
  private readonly sendToAgent?: (message: AcpStreamMessage) => Promise<void>;
  private readonly approval: ApprovalState;

  constructor(
    env: NodeJS.ProcessEnv,
    replay: boolean,
    readHistory: HistoryReader = readDshHistory,
    sendToAgent?: (message: AcpStreamMessage) => Promise<void>,
    approval: ApprovalState = { pending: undefined, bySession: new Map() },
  ) {
    this.env = env;
    this.replay = replay;
    this.readHistory = readHistory;
    this.sendToAgent = sendToAgent;
    this.approval = approval;
  }

  toAgent(message: AcpStreamMessage): AcpStreamMessage {
    if (!("method" in message) || !("id" in message)) return message;
    if (message.method === "initialize") this.initializations.add(message.id);
    if (message.method === "session/list") {
      const params = z.record(z.string(), z.unknown()).parse(message.params ?? {});
      this.lists.set(message.id, {
        params, sessions: [], cursors: new Set(), sessionIds: new Set(),
      });
    }
    if (message.method === "session/prompt") {
      this.prompts.set(message.id, z.object({ sessionId: z.string() }).parse(message.params).sessionId);
    }
    if (message.method === "session/new") this.newSessions.add(message.id);
    if (message.method === "session/load" || message.method === "session/resume") {
      const identity = z.object({ sessionId: z.string() }).passthrough().parse(message.params);
      if (this.approval.pending !== undefined) {
        this.approval.bySession.set(identity.sessionId, this.approval.pending);
        this.approval.pending = undefined;
      }
    }
    if (message.method === "session/load" && this.resumeOnly) {
      this.loads.set(message.id, loadSchema.parse(message.params));
      return { ...message, method: "session/resume" };
    }
    return message;
  }

  async fromAgent(message: AcpStreamMessage): Promise<AcpStreamMessage[]> {
    if ("method" in message && message.method === "session/update") {
      const params = z.object({
        update: z.object({ sessionUpdate: z.string() }).passthrough(),
      }).passthrough().parse(message.params);
      const { update } = params;
      if (update.sessionUpdate === "tool_call") {
        this.toolCalls.set(z.string().parse(update.toolCallId), update);
      } else if (update.sessionUpdate === "tool_call_update") {
        if (["completed", "failed"].includes(String(update.status))) {
          this.toolCalls.delete(z.string().parse(update.toolCallId));
        }
        // DSH reports results through standard ACP display content. Paseo's
        // adapter only surfaces rawOutput, so mirror the history projection.
        const output = toolOutputText(update);
        if (output !== undefined && (update.rawOutput === undefined || update.rawOutput === null)) {
          message = { ...message, params: { ...params, update: { ...update, rawOutput: output } } };
        }
      }
    }
    if ("method" in message && message.method === "session/request_permission") {
      const params = z.object({
        sessionId: z.string(),
        toolCall: z.object({ toolCallId: z.string() }).passthrough(),
        options: z.array(z.object({ optionId: z.string(), kind: z.string() }).passthrough()).default([]),
      }).passthrough().parse(message.params);
      if (this.approval.bySession.get(params.sessionId) === true && this.sendToAgent) {
        const allow = params.options.find((option) => option.kind === "allow_once") ??
          params.options.find((option) => option.kind.startsWith("allow"));
        if (allow) {
          const requestId = z.union([z.string(), z.number()]).parse(
            (message as { id?: unknown }).id,
          );
          await this.sendToAgent({
            jsonrpc: "2.0", id: requestId,
            result: { outcome: { outcome: "selected", optionId: allow.optionId } },
          });
          return [{
            jsonrpc: "2.0", method: historyItemMethod,
            params: {
              type: "notification", id: `dsh-auto-approve:${params.sessionId}:${requestId}`,
              level: "info", message: "Auto Accept approved a DSH permission request.",
            },
          }];
        }
      }
      const current = this.toolCalls.get(params.toolCall.toolCallId);
      // DSH sends only the call ID here; the shim rejects undefined rawInput.
      return [{ ...message, params: {
        ...params,
        toolCall: {
          ...params.toolCall,
          title: params.toolCall.title ?? current?.title,
          rawInput: params.toolCall.rawInput ?? current?.rawInput ?? null,
        },
      } }];
    }
    if ("id" in message && this.newSessions.delete(message.id) && "result" in message) {
      const created = z.object({ sessionId: z.string() }).passthrough().parse(message.result);
      if (this.approval.pending !== undefined) {
        this.approval.bySession.set(created.sessionId, this.approval.pending);
        this.approval.pending = undefined;
      }
    }
    if (!("id" in message) || "method" in message) return [message];
    if (this.initializations.delete(message.id) && "result" in message) {
      const result = initializeSchema.parse(message.result);
      this.resumeOnly = !result.agentCapabilities.loadSession &&
        result.agentCapabilities.sessionCapabilities?.resume !== undefined;
      if (this.resumeOnly) {
        return [{
          ...message,
          result: { ...result, agentCapabilities: { ...result.agentCapabilities, loadSession: true } },
        }];
      }
    }
    const list = this.lists.get(message.id);
    if (list) {
      if ("error" in message) {
        this.lists.delete(message.id);
        return [message];
      }
      if ("result" in message) {
        try {
          const page = listSchema.parse(message.result);
          for (const session of page.sessions) {
            if (list.sessionIds.has(session.sessionId)) continue;
            list.sessionIds.add(session.sessionId);
            list.sessions.push(session);
          }
          if (page.nextCursor) {
            if (list.cursors.has(page.nextCursor)) throw new Error("DSH session list repeated a pagination cursor");
            if (!this.sendToAgent) throw new Error("DSH session pagination transport is unavailable");
            list.cursors.add(page.nextCursor);
            await this.sendToAgent({
              jsonrpc: "2.0", id: message.id, method: "session/list",
              params: { ...list.params, cursor: page.nextCursor },
            });
            return [];
          }
          this.lists.delete(message.id);
          return [{ ...message, result: { ...page, sessions: list.sessions, nextCursor: null } }];
        } catch (error) {
          this.lists.delete(message.id);
          return [{
            jsonrpc: "2.0", id: message.id,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          }];
        }
      }
    }
    const promptSession = this.prompts.get(message.id);
    this.prompts.delete(message.id);
    if (promptSession && "result" in message) {
      const response = z.object({ stopReason: z.string() }).parse(message.result);
      if (["max_tokens", "max_turn_requests", "refusal"].includes(response.stopReason)) {
        return [{
          jsonrpc: "2.0", method: historyItemMethod,
          params: {
            type: "notification", id: `dsh-stop:${promptSession}:${message.id}`,
            level: "warning", message: `DSH stopped with ${response.stopReason}; this does not establish that the task is complete.`,
          },
        }, message];
      }
    }
    const identity = this.loads.get(message.id);
    this.loads.delete(message.id);
    if (!identity || !("result" in message) || !this.replay) return [message];
    try {
      return [...await this.readHistory(identity, this.env), message];
    } catch (error) {
      return [{
        jsonrpc: "2.0", id: message.id,
        error: {
          code: -32603,
          message: `Cannot replay DSH history: ${error instanceof Error ? error.message : String(error)}`,
        },
      }];
    }
  }
}
