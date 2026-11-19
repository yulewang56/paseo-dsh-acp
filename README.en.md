# DeepSeek Harness ACP for Paseo

English | [中文](README.md)

Connects the official `dsh --profile acp` to Paseo as provider `deepseek`.
Adds session resume and history replay, task lists, Auto Accept, Skills menus,
and named agents. DSH handles model requests, tools, and sandboxing; DSH Desktop is not required.

## Install

On the **Paseo daemon host**, prepare:

- Paseo daemon and app >= 0.16.1, with Settings → Plugins enabled.
- Daemon Node >= 22.15; verified DSH `0.2.2-alpha.2` requires Node >= 24.9.0.
- The official DSH CLI with model routes and credentials configured.

```sh
npm install -g @deepseek-ai/dsh@0.2.2-alpha.2
dsh --profile acp --help
paseo plugin add git:yulewang56/paseo-dsh-acp
paseo plugin ls
paseo provider diagnostic deepseek --json
```

Git installs use the committed lockfile to install runtime dependencies and require npm.
Expect plugin `running` and provider `Ready`; send a first message to verify model authentication.
Plugins are trusted, unsandboxed code running as the daemon user. Review the source before installing.

For local development, use a directory source:

```sh
git clone https://github.com/yulewang56/paseo-dsh-acp.git
cd paseo-dsh-acp
npm ci
paseo plugin install /absolute/path/to/paseo-dsh-acp
```

If the daemon cannot find `dsh`, merge its actual path into `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "deepseek": {
        "enabled": true,
        "command": ["/absolute/path/to/dsh", "--profile", "acp"]
      }
    }
  }
}
```

On Windows, use the actual `dsh.cmd` path. If the default Node is too old, use
`["/path/to/node", "/path/to/dsh/lib/bin.js", "--profile", "acp"]` instead.
Apply configuration changes with `paseo reload --json`; no daemon restart is needed.

## Use and configure

Select a DeepSeek model, type `/` for Skills, and choose an Agent beside the model/effort
controls. Paseo may hide provider controls in narrow layouts. Choose an Agent before the
first turn; existing sessions retain their selection.

Open **Settings → Plugins → DeepSeek Harness ACP** to configure:

- Extra Agent / Skills directories: one absolute host path or `~/path` per line.
- Claude / Copilot Skills discovery switches, both enabled by default. The separate read-only Agent sources section lists directories scanned independently of these switches.
- Agent model alias JSON, for example:

```json
{
  "sonnet": {
    "provider": "deepseek-official",
    "model": "deepseek/deepseek-v4-pro"
  }
}
```

Save explicitly. Changes apply to new/reopened sessions; manually Reload existing agents.
Settings are host-scoped. Credentials and DSH profiles remain external; Auto Accept remains
per-session. `DSH_ACP_AGENT_DIRS` paths precede page paths, `DSH_ACP_MODEL_ALIASES`
overrides matching page aliases, and extra Skills paths append to profile `customSkillDirs`.
Invalid environment/page mappings produce explicit errors.

### Skills discovery

Earlier roots take precedence. Roots and files deduplicate by real path, including symlinks.
`<project>` is the nearest Git root, or cwd when no Git root exists.

| Order | Directories |
|---|---|
| 1 | `<project>/.dsh/skills`, `<project>/.agents/skills` |
| 2 | DSH profile `customSkillDirs` and extra plugin directories |
| 3 | `~/.dsh/skills`, `~/.agents/skills`, DSH bundled Skills |
| 4 | `<project>/.claude/skills`, `<project>/.copilot/skills`, `<project>/.github/skills` |
| 5 | `~/.claude/skills`, `~/.copilot/skills` |

Supports `<name>/SKILL.md` and `<name>.md`. Native user roots honor `DSH_HOME` /
`DSH_AGENTS_HOME`. Profile `includeDefaultRoots: false` also disables compatibility defaults,
not explicitly configured paths. Parsing, loading, resource paths, and watching stay native
to DSH; the menu shows only user-invocable Skills.

**Discovery compatibility is not runtime compatibility:** foreign `allowed-tools`, model,
context/fork, and hooks fields are not enforced or executed and must not be used as DSH permission boundaries.

### Agent definitions

Discovery order: project `.dsh/agents`, project `.agents/agents`, custom directories,
`~/.dsh/agents`, `~/.agents/agents`, project/user `.claude/agents`, project `.copilot/agents`,
project `.github/agents`, then user `.copilot/agents`. Set custom directories through settings or `DSH_ACP_AGENT_DIRS`.

Supports `<name>/AGENT.md`, `<name>.md`, and Copilot `.agent.md` files.
`AGENTS.md` / `CLAUDE.md` are instructions, not agent definitions.
Roots and files deduplicate by `realpath`; symlinks keep their actual source's semantics.
Distinct same-name files use priority order and produce a shadowing warning.

```markdown
---
name: reviewer
description: Review code without modifying files
tools: [read, grep, glob]
---
Review correctness and explain actionable findings.
```

All sources share full YAML parsing and a common schema. Supported fields include persona,
tool allow/deny, `provider` / `model` / `reasoningEffort`, invocation policy, and display metadata.
Known Claude/Copilot tool names map to DSH equivalents. `tools: []` means no tools.
Models must exist in the DSH catalog; aliases such as `sonnet` / `opus` require explicit mappings.

Selecting an Agent applies its root persona, tools, model, and effort. Default restores the
baseline; resume does not overwrite persisted model choices. `maxTokens` is child-only.
The model can call `delegate_to_agent` to start real child sessions and receive completion
notices. Children share cwd, process, and sandbox; there is no OS/worktree isolation.

Unsupported executable fields such as hooks, permissions, MCP servers, plugins, background,
memory, skills, and handoffs, unknown fields, and tools without equivalent mappings are retained
with explicit diagnostics. Unavailable definitions show a reason in the picker and reject
selection/delegation rather than weakening restrictions. Definitions are scanned on new/resumed
sessions; live picker refresh is not guaranteed.

## Sessions and permissions

Resume keeps the DSH session ID and reads v4 JSONL / Zstd logs, context usage, and task lists
under `$DSH_HOME/sessions` (default `~/.dsh/sessions`). Set `DSH_ACP_SESSION_ROOT` for custom
storage. Resume failures are explicit, not replaced with empty sessions; non-text history
attachments retain only type placeholders.

Auto Accept approves individual DSH requests without disabling the sandbox and persists per
session. Set `DSH_PERMISSION_MODE` in the provider launch environment to `read-only`,
`workspace-write` (default), or `danger-full-access`; reload after changing it. Persistent
permissions, native steering, fork/rewind, and non-Skills native commands are not supported.

Configure third-party models in DSH's ACP profile using the
[route example](examples/third-party.cordis.patch.yml). ACP and `web` profiles are separate.
Preserve existing routes and credentials; never overwrite whole configurations or commit
secrets. Prompts and tool results go to the model endpoint selected in DSH.

## Update and migrate

```sh
paseo plugin update dsh-acp                     # Git install
# Directory install: run in the repository
git pull --ff-only
npm ci
paseo plugin reload dsh-acp
```

Reload stops this plugin's provider processes; finish running tasks first. Update the DSH CLI
separately. When upgrading from provider `dsh`, migrate the complete provider configuration
to `deepseek`, then run `paseo reload --json`. Old `dsh` agents cannot resume directly; DSH
session files are not deleted. See [ADR 0001](docs/adr/0001-permissions-and-options.md) for permissions.

## Develop

```sh
npm ci
npm run embed       # Regenerate after editing DSH overlay modules
npm run typecheck
DSH_TEST_COMMAND=/absolute/path/to/dsh npm test
```

Tests use fixtures / a loopback model. To exercise a real model:

```sh
DSH_TEST_COMMAND=/absolute/path/to/dsh \
DSH_TEST_MODEL='["your-route","your-model"]' npm run test:real
```

License: MIT. See [NOTICE](NOTICE) for icon attribution and trademarks.
