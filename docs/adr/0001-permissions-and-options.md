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
`controls` + `providerOptions` and deprecates `settings`. The published 0.15.0 SDK
still lacks the new types, so `server/provider-options.ts` supplies a narrow module
augmentation matching the host contract, without vendoring the SDK.
The installed Paseo 0.15.4 desktop distribution also bundles the old provider
schema: it strips `controls` and `providerOptions` from config events. A real
daemon snapshot, not the version string or upstream source, determines whether
the composer received the option.
The legacy schema also strips icon metadata. Its feature adapter copies
`description`, while the composer reads `tooltip` or falls back to `label`.
Adding more legacy fields cannot correct those presentation details.

## Decision

1. **Stay single-use.** The plugin rejects persistent grants,
   `toolPolicy.preapproved`, agent modes, input rewriting, rejection messages and
   deny-and-interrupt. Advertising them would silently exceed what DSH ACP can do.
2. **One plugin option: `auto_accept`.** The provider reports it as a toggle in
   session's `controls` and publishes its committed boolean in `providerOptions`.
   It accepts exactly that key in `session.open` / `session.configure`;
   `null` resets it to false. Unknown option keys are rejected. When enabled, the
   compatibility layer answers each `session/request_permission` with the
   `allow-once` option and emits an info timeline item. The flag is never sent to
   DSH as a config option.
3. **Sandbox mode is launch configuration.** `DSH_PERMISSION_MODE` is passed
   through the provider environment (`agents.providers.deepseek.env`), so the mode
   is fixed per provider process. It is not switchable per session from Paseo.
4. **Native toolbar placement takes priority.** Publish `controls` /
   `providerOptions` and the equivalent legacy `settings` toggle. Do not contribute
   a composer pill: it appears above the input instead of in the bottom toolbar.
   The `auto_accept` ID retains the host's state-dependent coloring. Legacy hosts
   still lose icon and tooltip metadata; restoring toolbar placement does not
   claim to fix those host limitations or make draft controls available.
   Accept patches through either settings path, preferring `providerOptions`.
   Strip both before forwarding to DSH. Changes combined with a model selection
   commit only after DSH accepts the request.
5. **Persist committed options separately.** Old hosts do not immediately persist
   unsolicited provider persistence updates. Save the boolean atomically per native
   DSH session under `$DSH_HOME/paseo-acp-options`, or under
   `DSH_ACP_SESSION_ROOT/paseo-options` for an isolated session root. Read it again on
   resume. Reject failed writes before changing effective approval state; never
   modify DSH's own session logs or credentials.

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
- A separate directory installation does not track checkout edits. Install the
  updated source into the intended runtime ID, then verify the live control.

## Follow-up (must revisit when upgrading Paseo)

1. Once the published SDK includes the 0.15.4 contracts, upgrade it and remove
   the local module augmentation. Remove the legacy mirror only when the minimum
   supported installed host actually retains and renders the new option fields.
2. Keep the `auto_accept` key and label so saved feature values keep working.
3. Re-run `npm run typecheck`, `npm test`, and `npm run test:real`.
