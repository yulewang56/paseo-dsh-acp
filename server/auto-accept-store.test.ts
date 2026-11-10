import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AutoAcceptStore } from "./auto-accept-store.ts";

test("Auto Accept is atomically saved per opaque native session and survives store recreation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-options-"));
  const env = { DSH_ACP_SESSION_ROOT: root };
  try {
    const store = new AutoAcceptStore(env);
    assert.equal(await store.read("../opaque/session"), undefined);
    await store.write("../opaque/session", true);
    assert.equal(await new AutoAcceptStore(env).read("../opaque/session"), true);
    assert.equal(await store.read("other"), undefined);
    await store.write("../opaque/session", false);
    assert.equal(await new AutoAcceptStore(env).read("../opaque/session"), false);
    const files = await readdir(join(root, "paseo-options"));
    assert.equal(files.length, 1);
    assert.equal((await stat(join(root, "paseo-options", files[0]))).mode & 0o777, 0o600);
    await writeFile(join(root, "paseo-options", files[0]), "corrupt state");
    await assert.rejects(() => store.read("../opaque/session"), /JSON/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("option storage errors fail explicitly instead of claiming the option was saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-options-"));
  try {
    const file = join(root, "not-a-directory");
    await writeFile(file, "");
    const store = new AutoAcceptStore({ DSH_ACP_SESSION_ROOT: file });
    await assert.rejects(() => store.write("session", true), /ENOTDIR/);
    await assert.rejects(() => store.read("session"), /ENOTDIR/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
