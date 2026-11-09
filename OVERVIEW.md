Registers the existing `dsh` provider through Paseo's standard ACP adapter and
adds a monochrome DeepSeek icon that follows the client's theme.

Uses `dsh --profile acp` on the daemon host. DSH handles the agent,
tools, permissions and model requests. This plugin adds no protocol
transformers or agent behavior.

Requires Paseo 0.15.3 or later and an installed official DSH CLI with a compatible
Node runtime. Override `agents.providers.dsh.command` when the CLI is not on
the daemon's PATH. Model endpoints and credentials are configured in DSH, not
in this plugin. Prompts and tool results are sent to the model endpoint selected
in DSH. The plugin does not install software or access credentials itself.

The icon is adapted
from the installed official DSH Web frontend's `favicon.svg` (DeepSeek Harness,
MIT license), changing only its fill to `currentColor`.
