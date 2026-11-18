import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { deepseekWhale } from "../shared/brand.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the plugin entry registers the deepseek provider once", () => {
  const registered: Array<{ id: string; label: string; icon: string }> = [];
  const cleanup = contribute({
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "test", values: {} }) }),
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
  assert.equal(manifest.requirements.paseo, ">=0.16.1");
  assert.deepEqual(manifest.build, [["npm", "ci", "--omit=dev", "--ignore-scripts"]]);
  assert.ok((await stat(join(root, "icon.svg"))).size > 0);
  assert.equal(deepseekWhale.svg, (await readFile(join(root, "icon.svg"), "utf8")).trim());
  assert.equal(manifest.icon, "icon.png");
  const icon = await readFile(join(root, manifest.icon));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const entry of [
    "paseo-plugin.json", "OVERVIEW.md", "LICENSE", "NOTICE", "README.md", "README.en.md",
    "examples/", "icon.svg", "icon.png", "index.server.ts", "index.client.tsx", "client/", "server/", "shared/",
  ]) {
    assert.ok(pkg.files.includes(entry), `package.json files must include ${entry}`);
  }
  await assert.rejects(() => stat(join(root, "index.client.ts")), { code: "ENOENT" });
});
