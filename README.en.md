# DeepSeek Harness ACP for Paseo

English | [中文](README.md)

Brings the **official DSH ACP profile** into Paseo. The provider ID is `deepseek`. The
plugin reuses Paseo's `runAcpProvider` and adds session resume, local history replay,
Auto Accept, and a Skills menu: no custom agent loop, model proxy, or DSH Desktop dependency.

```text
Paseo → standard ACP adapter + DSH resume layer → dsh --profile acp → model API from DSH
```

## Requirements

Everything below runs on the **machine hosting the Paseo daemon**.

- Paseo >= 0.15.3 with plugins enabled.
- Node >= 22.15 on the daemon (Zstandard decompression).
- The official DSH CLI; verified against 0.2.2-alpha.2 (which requires Node >= 24.9.0).

Plugins are trusted, unsandboxed code and run with the daemon user's privileges. Review
the source before installing. The plugin does not install DSH or upload configuration or
credentials, and only reads DSH session files for history replay.

## Install

### 1. Prepare DSH

```sh
npm install -g @deepseek-ai/dsh
dsh --version
dsh --profile acp --help
```

Pin `@deepseek-ai/dsh@0.2.2-alpha.2` when you need reproducibility. The `dsh` command
registered by official Desktop also works if it supports ACP.

### 2. Install the plugin

Enable the daemon's global plugin switch first (Settings → Plugins).

```sh
paseo plugin add git:yulewang56/paseo-dsh-acp
paseo plugin ls
paseo provider diagnostic deepseek --json
```

If Git installation is unavailable, use a directory source:

```sh
git clone https://github.com/yulewang56/paseo-dsh-acp.git
paseo plugin install /absolute/path/to/paseo-dsh-acp
```

No `npm install` is needed: the plugin has no build/install scripts. The plugin should
be `running` and the provider `Ready`; diagnostics do not prove that model calls work.

### 3. CLI path (optional)

The default launch is `dsh --profile acp`. If the daemon cannot find `dsh`, **merge**
this object into `~/.paseo/config.json`:

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

On Windows use the actual `dsh.cmd` path. Only macOS has been tested directly; run the
same diagnostics elsewhere. Windows cold start can take 7–14 seconds; the plugin allows
30 seconds for ACP initialization, and starting `dsh web` first is not required. If the
default Node is too old, set `command` to
`["/path/to/node", "/path/to/dsh/lib/bin.js", "--profile", "acp"]`.

```sh
paseo reload --json
paseo provider diagnostic deepseek --json
```

No daemon restart is needed, but reloading terminates old provider processes, so finish
running tasks first.

## Upgrading from the old `dsh` provider (1.3.0)

The provider ID changed from `dsh` to `deepseek`; the plugin ID is still `dsh-acp`, the
CLI is still `dsh --profile acp`, and no legacy alias exists.

Back up `~/.paseo/config.json`, copy the complete `agents.providers.dsh` object
(including command/env) to `agents.providers.deepseek`, then remove the old entry;
reconcile instead of overwriting if a `deepseek` entry already exists. Then:

```sh
paseo reload --json
paseo plugin reload dsh-acp
paseo provider diagnostic deepseek --json
```

Old agents keep provider/persistence `dsh` and **cannot be resumed**; the plugin does
not rewrite old records or delete DSH session files. Create new agents after upgrading.
To restore old agents, roll back the plugin source and configuration backup first.

If Paseo ever ships a built-in `deepseek` provider, this plugin will fail to register
because of the name conflict; switch to a more specific ID such as `deepseek-harness`
and migrate again.

## Update

```sh
paseo plugin update dsh-acp                                    # Git install
git -C <repo> pull --ff-only && paseo plugin reload dsh-acp    # directory install
```

Update DSH separately with `npm install -g @deepseek-ai/dsh`, then run diagnostics
again. Neither changes third-party model configuration.

## Third-party DeepSeek models

Supported. Model requests are sent by DSH; the gateway must provide the APIs, tool
calls, and streaming responses that DSH needs — a web-only chat service is not enough.
Model IDs, reasoning parameters, context limits, image support, and costs are up to the
third party.

1. Run `dsh --profile acp --help` once to initialize the ACP profile.
2. Merge the [example](examples/third-party.cordis.patch.yml) into
   `~/.dsh/profiles/acp/cordis.patch.yml` (same under `DSH_HOME`), replacing the
   endpoint and model ID.
3. Store the credential under `refs` in `~/.dsh/.credentials.yaml`:

```yaml
version: 1
refs:
  DSH_GATEWAY_API_KEY: REPLACE_WITH_YOUR_SECRET
```

Keep existing refs, do not overwrite the whole file or commit secrets, and prefer
`chmod 600`. You can also pass an environment variable with the same name explicitly to
the daemon or provider.

Notes:

- ACP and `web` are different profiles; a route saved in `dsh web` does not apply.
- DSH's Cordis `config` override **replaces the entire entry**; keep the other routes
  in `llm-pi-ai` and do not add duplicate entries with the same id.
- Existing sessions may keep their previous model choice; select the new model
  explicitly in Paseo.
- Then run `paseo provider diagnostic deepseek --json` and send a minimal request to
  verify authentication, tool calls, and connectivity; `Ready` does not prove inference.

## Capabilities and limitations

### Session resume and history

DSH 0.2.2-alpha.2 only has `session/resume`, not `session/load` or history replay;
Paseo 0.15.3 exposes `session.persistence` only for agents declaring `loadSession`. The
plugin translates `session/load` into `session/resume`, restores the same session ID,
and replays history from local v4 logs (all Zstd frames), failing explicitly instead of
creating an empty session. The replay also restores the last context-window usage, so
the context meter is populated after a restart instead of waiting for the next turn.
DSH `todo_write` task lists are projected to Paseo's composer task list (the `N/M tasks`
pill above the input), including after a resume, without a duplicate raw tool card in
the message list.

Logs live under `$DSH_HOME/sessions` (default `~/.dsh/sessions`); `session.v4.jsonl.zstd`
and `.jsonl` are supported and read-only. Point the provider environment variable
`DSH_ACP_SESSION_ROOT` at a custom storage root. Non-text attachments appear as type
placeholders and `history: skip` replays nothing.

### Interaction semantics

| Area | Behavior |
|---|---|
| Configuration | Accepts only the `auto_accept` option; rejects non-empty `systemPrompt`, unknown options, `toolPolicy.preapproved`, and `persist=false`; MCP supports stdio/Streamable HTTP only. |
| Cancel/concurrency | `prompt.steer` is not advertised; concurrent `auto` interrupts the previous turn, explicit `steer` is rejected, and cancellation ends the turn exactly once. |
| Permissions | Single-use allow/deny only; fills DSH's missing tool context without inventing arguments; rejects persistent grants, input rewriting, rejection messages, and deny-and-interrupt. |
| Models | Opaque IDs are preserved; invalid choices are not committed and do not corrupt the current configuration. |
| Session list | Follows every `nextCursor` and deduplicates; repeated cursors or later page failures error out; `query`/`limit` apply after collection. |
| Turn end | `max_tokens`, `max_turn_requests`, and `refusal` warn; API errors and process exits count as failures. |
| History/attachments | Unfinished tools no longer stay running; failures without details are explained; tool results map to live `output`; non-text results use type placeholders. |

`title` is local Paseo metadata only. The plugin does not advertise native steering,
persistent permissions, structured output, fork/rewind, or desktop-only modes; ACP
output is committed messages, not token-level streaming. Image support depends on DSH
routing; the plugin does not upgrade capability declarations.

### Permissions and Auto Accept

DSH approvals are one-shot allow/reject; there is no "always allow". The plugin
adds an `Auto Accept` toggle in the composer: when enabled it answers
`session/request_permission` with `allow-once` and leaves an info item in the
timeline. The sandbox still applies, so an out-of-workspace write is denied first
and then escalated.

The value is saved per DSH session under `$DSH_HOME/paseo-acp-options`
(`~/.dsh` by default), or `DSH_ACP_SESSION_ROOT/paseo-options` when that override
is set. Storage errors are reported explicitly. The toggle is available after
a session opens, not in a draft before a session exists.

The DSH sandbox mode is fixed at launch (default `workspace-write`):

```json
{
  "agents": {
    "providers": {
      "deepseek": { "env": { "DSH_PERMISSION_MODE": "danger-full-access" } }
    }
  }
}
```

| Value | Sandbox | Approval |
|---|---|---|
| `read-only` | read-only | ask |
| `workspace-write` | workspace writable | ask |
| `danger-full-access` | unrestricted | never (no prompts) |

The mode is per process, so changing it requires a provider reload. Paseo has no
per-session selector, and ACP does not expose DSH's `/permission`. See
[ADR 0001](docs/adr/0001-permissions-and-options.md) for the design and migration
plan.

### Other

The verified version lacks Standard/PTC/Minimal/Creator presets, native Plan approval
cards, and similar desktop features; models, permissions, and session capabilities come
from the DSH/Paseo handshake.

### Skills

DSH ACP includes native skill discovery and the `skill` tool; the plugin does not
copy or inject skill instructions. Default roots are the project's `.dsh/skills`
and `.agents/skills`, plus `~/.dsh/skills` and `~/.agents/skills`.
The shared directory is **`.agents` (plural)**, not `.agent`. Paseo installs its
orchestration skills there. Skills installed only under `~/.claude/skills` are
not scanned by DSH. `DSH_AGENTS_HOME` and `DSH_HOME` override the user roots;
DSH's `skill-filesystem.customSkillDirs` adds custom roots.

**After opening a DeepSeek session, type `/` in the composer to select discovered
Skills**, including `/paseo`. You can also ask the model to use a skill, or send
`/paseo ...` as ordinary text. Selected commands pass their name and arguments to
DSH's own invocation parser; the plugin does not copy skill bodies into prompts.

The menu lists only user-invocable Skills and updates as discovery results change.
Incomplete or failed discovery is reported explicitly. Drafts have no Skills menu
before a session exists.

The plugin does not install additional DSH skill packages such as Office. The
default ACP profile enables filesystem skills and their native loader; other
skills depend on the packages enabled in that profile and local skill roots,
not the DSH Desktop menu.

## Development and testing

```sh
npm ci
npm run typecheck
npm test        # fixtures only, no model calls
```

Real DSH integration test (reads `~/.dsh` and requires `dsh` to write its profile; makes
model requests for cancellation, a short reply and two temporary skill loads):

```sh
DSH_TEST_COMMAND=/absolute/path/to/dsh \
DSH_TEST_MODEL='["your-route","your-model"]' \
npm run test:real
```

`test:real` fails on missing variables, a non-executable command, or malformed JSON
instead of silently skipping; `--all` also runs the fixture suites. Deterministic
branches are covered by fixtures.

The repository ships a `dsh-acp-testing` skill: the real file lives in `.agents/skills/`
(read by DSH and Copilot), and `.claude/skills/` is a symlink to it for Claude Code.

License: MIT. Icon attribution and trademark notices are in [NOTICE](NOTICE).

References: [official ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md),
[official model configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md),
[Paseo provider plugins](https://paseo.sh/docs/plugins/providers.md).
