// Fixture for the termination-escalation test: answers `initialize`, then keeps
// running and ignores both stdin EOF and SIGTERM so only SIGKILL can stop it.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.DSH_HUNG_PID_FILE) {
  writeFileSync(process.env.DSH_HUNG_PID_FILE, String(process.pid));
}
process.on("SIGTERM", () => {});

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        authMethods: [],
      },
    });
  }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "hung-session", configOptions: [] } });
  }
});

// A live handle keeps the event loop busy after stdin closes.
setInterval(() => {}, 1000);
