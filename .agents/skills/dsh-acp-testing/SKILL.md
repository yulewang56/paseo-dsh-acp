---
name: dsh-acp-testing
description: Test the dsh-acp Paseo plugin (official DeepSeek Harness ACP provider). Use when asked to test the plugin, run or configure the real DSH integration test, add fixture coverage, investigate a failing test/typecheck, or verify provider behavior before a release.
---

# dsh-acp testing

Repository: `/Users/yulewang/Proj/paseo-dsh-acp`.
Provider ID: `deepseek`. Plugin ID: `dsh-acp`. CLI: `dsh --profile acp`.

## Commands

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | fixture suites only; no DSH, no model calls |
| `npm run test:real` | guarded real DSH integration test (`server/real.test.ts`) |
| `npm run test:real -- --all` | full suite with the real test enabled |
| `npm run test:real -- --test-name-pattern "history"` | filtered real run |

`npm test` skips the real test when `DSH_TEST_COMMAND` / `DSH_TEST_MODEL` are unset.
`npm run test:real` validates them first and exits non-zero when they are missing or
malformed, so it never reports a silent skip as success.

## Real DSH configuration

```sh
command -v dsh
sed -n '/agent-default-model/,+3p' ~/.dsh/profiles/acp/cordis.patch.yml
```

Use the `provider` and `model` values from that patch:

```sh
DSH_TEST_COMMAND=/Users/yulewang/.local/bin/dsh \
DSH_TEST_MODEL='["deepseek-official","deepseek/deepseek-flash"]' \
npm run test:real
```

Important:

- The real test boots `dsh`, which writes `~/.dsh/profiles/acp/*`. Under a
  workspace-write sandbox this fails with `EPERM`, and the provider only reports
  `DSH ACP process closed (EOF)`. Run it with full access or outside the sandbox.
- It makes two real model requests (one canceled turn, one short reply) and takes
  about 10 seconds. Small cost.
- It reads the ACP profile credentials; the session root is isolated to a temp
  overlay and user sessions/profiles are not modified.

## Test map

| File | Covers |
|---|---|
| `server/compatibility.test.ts` | resume-only `session/load` rewrite, history replay ordering, pagination, ID-only permission requests, live tool output mapping |
| `server/history.test.ts` | zstd frame decoding/validation, event projection, session discovery, cwd checks |
| `server/provider.test.ts` | end-to-end through the fixture: capabilities, cancel/concurrent prompts, permissions, model config, queries, process lifecycle |
| `server/semantics.test.ts` | rejected config/prompt/permission inputs |
| `server/manifest.test.ts` | `index.server.ts` registration, manifest/icon/published files |
| `server/real.test.ts` | real DSH: pagination, model/reasoning enumeration, cancel, resume with history |
| `server/fixtures/acp-agent.mjs` | scripted ACP agent; behavior selected by prompt text |
| `server/fixtures/hung-agent.mjs` | ignores stdin EOF and SIGTERM so the SIGKILL escalation path can be tested |

## Adding coverage

- Prefer the narrowest layer: pure behavior in `compatibility`/`history`/`semantics`,
  wiring and lifecycle in `provider.test.ts`.
- New fixture scenario: add an `if (text === "scenario-name")` branch in
  `acp-agent.mjs`, emit `session/update` events, then `complete(text)` or send a
  permission request. Add the matching test through `harness()` in
  `provider.test.ts`.
- Keep tests deterministic: no real model, no network, temp dirs under `tmpdir()`
  cleaned up in `finally`.
- Do not weaken production validation or change expected semantics just to make a
  test pass; confirm the intended behavior first.

## Triage

- `ℹ skipped 1` from `npm test` means the real test was skipped; use `npm run test:real`.
- `DSH ACP process closed (EOF)` immediately after connect usually means `dsh` could
  not boot: sandbox denied the profile write, wrong `DSH_TEST_COMMAND`, or an unknown
  provider/model pair.
- `Official DSH test timed out` (120s) points at gateway/model latency or credentials.
  Verify with `paseo provider diagnostic deepseek --json` and a manual prompt.
- Permission/model failures: check single-use allow/deny mapping and opaque ID
  preservation; do not relax the semantics layer.

## Before reporting done

```sh
npm run typecheck
npm test
```

Run `npm run test:real` as well when touching resume/history/model/permission
semantics, and report exact pass/fail/skip counts.
