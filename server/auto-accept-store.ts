import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoAcceptPersistence } from "../shared/auto-accept.ts";

export class AutoAcceptStore {
  private readonly directory: string;

  constructor(env: NodeJS.ProcessEnv) {
    this.directory = env.DSH_ACP_SESSION_ROOT
      ? join(env.DSH_ACP_SESSION_ROOT, "paseo-options")
      : join(env.DSH_HOME || join(homedir(), ".dsh"), "paseo-acp-options");
  }

  private path(sessionId: string): string {
    return join(this.directory, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
  }

  async read(sessionId: string): Promise<boolean | undefined> {
    let text: string;
    try {
      text = await readFile(this.path(sessionId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const stored = autoAcceptPersistence.parse(JSON.parse(text));
    if (stored.data.sessionId !== sessionId) throw new Error("Auto Accept state belongs to another DSH session");
    if (stored.data.auto_accept === undefined) throw new Error("Auto Accept state has no saved value");
    return stored.data.auto_accept;
  }

  async write(sessionId: string, value: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({
        version: 1, data: { sessionId, auto_accept: value },
      }), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path(sessionId));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
