Registers the existing `dsh` provider through Paseo's standard ACP adapter and
adds a monochrome DeepSeek icon that follows the client's theme.

Uses `dsh --profile acp` on the daemon host. DSH handles the agent,
tools, permissions and model requests. A compatibility layer translates
session loading to official DSH resume and reconstructs the timeline from
local DSH v4 session logs. It preserves the native session ID and reports
resume or history failures instead of replacing the conversation.

Requires Paseo 0.15.3 or later and an installed official DSH CLI with a compatible
Node runtime, plus Node 22.15 or later in the daemon for Zstandard history.
Override `agents.providers.dsh.command` when the CLI is not on
the daemon's PATH. Model endpoints and credentials are configured in DSH, not
in this plugin. Prompts and tool results are sent to the model endpoint selected
in DSH. The plugin reads local DSH session files for history but does not
install software or access credentials itself. Historical non-text attachments
have type placeholders rather than restored previews. Non-JSONL storage
backends are not supported for history replay.

The icon is adapted
from the installed official DSH Web frontend's `favicon.svg` (DeepSeek Harness,
MIT license), changing only its fill to `currentColor`.
