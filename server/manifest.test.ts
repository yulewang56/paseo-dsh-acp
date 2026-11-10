import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the plugin entry registers the deepseek provider once", () => {
  const registered: Array<{ id: string; label: string; icon: string }> = [];
  const cleanup = contribute({
    registerProvider: (provider: { id: string; label: string; icon: string }) => {
      registered.push(provider);
    },
  } as unknown as PluginServerContext);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, "deepseek");
  assert.equal(registered[0].label, "DeepSeek Harness");
  assert.equal(registered[0].icon, "icon.svg");
  assert.equal(typeof cleanup, "function");
});

test("the manifest, icon and published file list stay consistent", async () => {
  const manifest = JSON.parse(await readFile(join(root, "paseo-plugin.json"), "utf8"));
  assert.equal(manifest.id, "dsh-acp");
  assert.equal(manifest.requirements.paseo, ">=0.15.3");
  assert.ok((await stat(join(root, "icon.svg"))).size > 0);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const entry of [
    "paseo-plugin.json", "OVERVIEW.md", "LICENSE", "README.md", "README.en.md",
    "examples/", "icon.svg", "index.server.ts", "server/",
  ]) {
    assert.ok(pkg.files.includes(entry), `package.json files must include ${entry}`);
  }
});
