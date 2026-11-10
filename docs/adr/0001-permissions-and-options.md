# ADR 0001: Permission model and plugin options

- Status: Accepted
- Date: 2026-11-10
- Scope: `dsh-acp` provider, DSH ACP permission requests, Paseo plugin options

## Context

**DSH approval.** `@deepseek-ai/dsh-user-approval` exposes two policies: `ask`
(ask per request, the default) and `never` (reject without asking). Every decision
applies to one request only; there is no "always allow" or persistent grant.
Tools such as bash and fs route `ask` decisions through this service, so a normal
write inside the workspace does not prompt, while sandbox escalation does.

**Official DSH ACP.** `@deepseek-ai/dsh-acp` turns each `approval/request` into
`session/request_permission` with exactly two options: `allow-once` and
`reject-once`. It sends only a call ID, not a tool name. Modes, slash commands,
plans, terminals and elicitation are not exposed.

**DSH sandbox presets.** `@deepseek-ai/dsh-permission-presets` bundles a sandbox
mode with an approval policy: `read-only`, `workspace-write`, and
`danger-full-access`. At boot, `dsh-base` derives both knobs from
`DSH_PERMISSION_MODE` (default `workspace-write`); `danger-full-access` also sets
approval to `never`. The desktop/web UI can switch presets through `/permission`,
but that surface is not part of ACP.

**Paseo plugin providers.** Permission requests surface as `session.permission`;
the client answers with a single-use allow/deny. Paseo's built-in Auto Accept
toggle belongs to `ACPAgentClient` (and OpenCode/Cursor), not to plugin providers.
On Paseo 0.15.3, plugin options are reported through `ProviderConfigState.settings`
and patches arrive under `changes.settings`. Paseo 0.15.4 adds
`controls` + `providerOptions` and deprecates `settings`; the matching plugin SDK
is not published on npm yet.

## Decision

1. **Stay single-use.** The plugin rejects persistent grants,
   `toolPolicy.preapproved`, agent modes, input rewriting, rejection messages and
   deny-and-interrupt. Advertising them would silently exceed what DSH ACP can do.
2. **One plugin option: `auto_accept`.** The provider reports it as a toggle in
   the session config and accepts exactly that key in `session.open` /
   `session.configure`. Unknown option keys are rejected. When enabled, the
   compatibility layer answers each `session/request_permission` with the
   `allow-once` option and emits an info timeline item. The flag is never sent to
   DSH as a config option.
3. **Sandbox mode is launch configuration.** `DSH_PERMISSION_MODE` is passed
   through the provider environment (`agents.providers.deepseek.env`), so the mode
   is fixed per provider process. It is not switchable per session from Paseo.
4. **No dual option paths.** During the Paseo 0.15.3 era the plugin implements the
   `settings` channel only. It will migrate wholesale to
   `controls`/`providerOptions` once the 0.15.4 SDK is available, without keeping
   both branches.

## Consequences

- `auto_accept` suppresses approval prompts but keeps the sandbox. An
  out-of-workspace write still fails first, is retried with escalation, and is
  then approved automatically.
- `DSH_PERMISSION_MODE=danger-full-access` disables the sandbox and sets approval
  to `never`, so no permission request is generated at all. This is broader than
  `auto_accept`: it removes confinement instead of consenting to it.
- A per-session permission selector in Paseo is not possible until DSH ACP
  exposes presets (as ACP modes or another negotiated surface). Multiple provider
  entries with different environments are the only workaround.
- `settings` is deprecated from Paseo 0.15.4 onward; the migration is tracked in
  [issue #1](https://github.com/yulewang56/paseo-dsh-acp/issues/1).

## Follow-up (must revisit when upgrading Paseo)

1. Wait for `@getpaseo/plugin` 0.15.4+ on npm (or vendor its types).
2. Replace the `settings` report with `controls` + `providerOptions`; handle
   `changes.providerOptions.auto_accept` and drop `changes.settings`.
3. Keep the `auto_accept` key and label so saved feature values keep working.
4. Remove the settings compatibility notes from the README and this ADR.
5. Re-run `npm run typecheck`, `npm test`, and `npm run test:real`.
