import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
  active_form: z.string().optional(),
});
const todoInputSchema = z.object({ todos: z.array(todoItemSchema) });

/** DSH names the tool `todo_write`; accept separator and case variants. */
export function isTodoWriteTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return name.trim().toLowerCase().replace(/[\s./-]+/g, "_") === "todo_write";
}

/**
 * Validate a tool call's raw input. Returns undefined for anything that is not
 * a well-formed todo list so callers can leave the original call untouched.
 */
export function parseTodoWriteInput(rawInput: unknown): TodoItem[] | undefined {
  let value = rawInput;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const parsed = todoInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return parsed.data.todos.map((item) => {
    const activeForm = item.activeForm ?? item.active_form;
    return {
      content: item.content,
      status: item.status,
      ...(activeForm === undefined ? {} : { activeForm }),
    };
  });
}

/**
 * Project a DSH task list onto a standard ACP plan update. Paseo turns this
 * into a `todo` timeline item, which drives both the message list and the
 * composer task list.
 */
export function todoPlanUpdate(sessionId: string, todos: readonly TodoItem[]): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries: todos.map(({ content, status }) => ({ content, status, priority: "medium" })),
      },
    },
  };
}
