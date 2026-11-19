Registers the `deepseek` provider through Paseo's standard ACP adapter.

Uses `dsh --profile acp` on the daemon host. DSH handles the agent,
tools, permissions and model requests. A compatibility layer translates
session loading to official DSH resume and reconstructs the timeline from
local DSH v4 session logs. It preserves the native session ID and reports
resume or history failures instead of replacing the conversation. DSH todo
lists are projected to Paseo's composer task list, including after resume.

Requires Paseo 0.16.1 or later (daemon and app) and an installed official DSH CLI with a compatible
Node runtime, plus Node 22.15 or later in the daemon for Zstandard history.
Override `agents.providers.deepseek.command` when the CLI is not on
the daemon's PATH. Model endpoints and credentials are configured in DSH, not
in this plugin. Prompts and tool results are sent to the model endpoint selected
in DSH. The plugin reads local DSH session files for history but does not
install software or access credentials itself. Historical non-text attachments
have type placeholders rather than restored previews. Non-JSONL storage
backends are not supported for history replay.

The cog on this plugin's Settings → Plugins row opens host-scoped discovery
settings: extra agent/skill directories, Claude/Copilot Skills compatibility
switches (both on by default), and explicit model alias mappings. Save applies to
new or reopened sessions; manually Reload existing agents. Cached drafts may need
reopening. Reset requires confirmation. Environment agent paths merge before page
paths; environment aliases override matching page aliases. Skill directories append
to native profile custom directories. Native profile root settings still apply.
Credentials and DSH home paths remain external, and Auto Accept remains per-session.

There is no legacy `dsh` provider alias. Back up the daemon configuration and move
the complete provider override to `agents.providers.deepseek` when upgrading.
Old `dsh` agents cannot resume with this provider;
their DSH session files remain untouched. Reloading stops existing provider
processes, so finish running tasks first. The plugin ID remains `dsh-acp`.
If Paseo adds a built-in `deepseek` provider, the ID may conflict and require
another migration to a more specific ID such as `deepseek-harness`.

Unsupported Paseo launch settings and permission mutations are rejected explicitly.
Only one-shot approval decisions are supported. Non-skill native commands and
non-interrupting steering are not advertised. Session listing follows all cursor
pages, and output limits produce a visible warning instead of implying task success.

Auto Accept approves individual DSH requests without disabling the sandbox.
The choice is saved locally per DSH session. A temporary ACP wrapper exposes DSH's
user-invocable Skills in Paseo's slash menu after a session opens, including Paseo
skills in `~/.agents/skills`. Project and user `.claude/skills` and `.copilot/skills`,
plus project `.github/skills`, are included after native roots, with real-path deduplication. Parsing,
resource loading, and change watching use the native filesystem provider and
scoped registry, preserving profile settings. Foreign hooks, model overrides,
and tool restrictions in skill frontmatter are not enforced. Additional DSH skill
packages are not installed.

The plugin also discovers named agent definitions from project and user
`.dsh/agents`, `.agents/agents`, `.claude/agents`, and `.copilot/agents`
directories and the project's `.github/agents` directory (including symlinked files). Frontmatter is parsed as full YAML; all
sources share one schema and tool/model normalization, with explicit capability
diagnostics for unsupported hooks, permissions, MCP servers, background/memory,
tool filters, and unresolved models. Unknown fields are retained and shown as
unavailable rather than treated as supported.

It adds a native Agent picker beside the model, effort, and permission controls.
Selecting a definition before the first turn applies its supported persona,
tool visibility, model, and reasoning effort, and synchronizes the Paseo
model/effort controls; Default restores the captured baseline. Resume remounts
the persona/tools without overwriting a persisted model. Unsupported definitions
remain visible with a reason but cannot be selected or delegated.

A `delegate_to_agent` tool starts a real child session with the definition's
persona, tool restrictions, and child-only model options such as `maxTokens`.
Children share the parent process, cwd, and sandbox; this is not OS-level
isolation. Uncontrolled execution fields are not supported.
