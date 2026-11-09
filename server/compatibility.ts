import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";
import { readDshHistory } from "./history.ts";

const initializeSchema = z.object({
  agentCapabilities: z.object({
    loadSession: z.boolean().optional(),
    sessionCapabilities: z.object({ resume: z.unknown().optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const loadSchema = z.object({ sessionId: z.string(), cwd: z.string() });

type RequestId = string | number | null;
type HistoryReader = typeof readDshHistory;

export class DshAcpCompatibility {
  private readonly initializations = new Set<RequestId>();
  private readonly loads = new Map<RequestId, z.infer<typeof loadSchema>>();
  private resumeOnly = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly replay: boolean;
  private readonly readHistory: HistoryReader;

  constructor(
    env: NodeJS.ProcessEnv,
    replay: boolean,
    readHistory: HistoryReader = readDshHistory,
  ) {
    this.env = env;
    this.replay = replay;
    this.readHistory = readHistory;
  }

  toAgent(message: AcpStreamMessage): AcpStreamMessage {
    if (!("method" in message) || !("id" in message)) return message;
    if (message.method === "initialize") this.initializations.add(message.id);
    if (message.method === "session/load" && this.resumeOnly) {
      this.loads.set(message.id, loadSchema.parse(message.params));
      return { ...message, method: "session/resume" };
    }
    return message;
  }

  async fromAgent(message: AcpStreamMessage): Promise<AcpStreamMessage[]> {
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
