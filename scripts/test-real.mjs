// Guarded runner for the real DSH integration test.
//
// `npm test` skips server/real.test.ts when DSH_TEST_COMMAND / DSH_TEST_MODEL are
// unset, which can look like a pass. This runner fails loudly before skipping.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const forwarded = process.argv.slice(2);
const all = forwarded.includes("--all");
const passthrough = forwarded.filter((argument) => argument !== "--all");

const command = process.env.DSH_TEST_COMMAND;
const model = process.env.DSH_TEST_MODEL;
const problems = [];

if (!command) {
  problems.push("DSH_TEST_COMMAND is not set (absolute path to the dsh CLI)");
} else {
  try {
    accessSync(command, constants.X_OK);
  } catch {
    problems.push(`DSH_TEST_COMMAND is not executable: ${command}`);
  }
}

if (!model) {
  problems.push('DSH_TEST_MODEL is not set (a JSON array such as \'["provider","model"]\')');
} else {
  try {
    const parsed = JSON.parse(model);
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        parsed.some((value) => typeof value !== "string" || value.length === 0)) {
      problems.push(`DSH_TEST_MODEL must be a JSON array of two non-empty strings, got: ${model}`);
    }
  } catch {
    problems.push(`DSH_TEST_MODEL is not valid JSON: ${model}`);
  }
}

if (problems.length > 0) {
  console.error("The real DSH integration test is not configured:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`
Find the values on the daemon host:

  command -v dsh                    # -> DSH_TEST_COMMAND
  sed -n '/agent-default-model/,+3p' ~/.dsh/profiles/acp/cordis.patch.yml

Then run:

  DSH_TEST_COMMAND=/absolute/path/to/dsh \\
  DSH_TEST_MODEL='["provider","model"]' npm run test:real

The real test boots dsh, which writes its profile under ~/.dsh. Run it where dsh
may write there; otherwise dsh exits and the provider reports
"DSH ACP process closed (EOF)".
`);
  process.exit(1);
}

console.log([
  "Real DSH integration test",
  `  command: ${command}`,
  `  model:   ${model}`,
  `  scope:   ${all ? "full suite" : "server/real.test.ts"}`,
  "",
].join("\n"));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [bin, args] = all
  ? [npm, ["test", ...(passthrough.length > 0 ? ["--", ...passthrough] : [])]]
  : [process.execPath, [
    "--experimental-strip-types", "--test",
    ...passthrough, join(root, "server/real.test.ts"),
  ]];

const child = spawn(bin, args, { cwd: root, env: process.env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Cannot start the test runner: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
