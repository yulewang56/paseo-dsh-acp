Registers the `deepseek` provider through Paseo's standard ACP adapter.

Uses `dsh --profile acp` on the daemon host. DSH handles the agent,
tools, permissions and model requests. A compatibility layer translates
session loading to official DSH resume and reconstructs the timeline from
local DSH v4 session logs. It preserves the native session ID and reports
resume or history failures instead of replacing the conversation.

Requires Paseo 0.15.3 or later and an installed official DSH CLI with a compatible
Node runtime, plus Node 22.15 or later in the daemon for Zstandard history.
Override `agents.providers.deepseek.command` when the CLI is not on
the daemon's PATH. Model endpoints and credentials are configured in DSH, not
in this plugin. Prompts and tool results are sent to the model endpoint selected
in DSH. The plugin reads local DSH session files for history but does not
install software or access credentials itself. Historical non-text attachments
have type placeholders rather than restored previews. Non-JSONL storage
backends are not supported for history replay.

There is no legacy `dsh` provider alias. Back up the daemon configuration and move
the complete provider override to `agents.providers.deepseek` when upgrading.
Old `dsh` agents cannot resume with this provider;
their DSH session files remain untouched. Reloading stops existing provider
processes, so finish running tasks first. The plugin ID remains `dsh-acp`.
If Paseo adds a built-in `deepseek` provider, the ID may conflict and require
another migration to a more specific ID such as `deepseek-harness`.

Unsupported Paseo launch settings and permission mutations are rejected explicitly.
Only one-shot approval decisions are supported. Native slash commands and
non-interrupting steering are not advertised. Session listing follows all cursor
pages, and output limits produce a visible warning instead of implying task success.
