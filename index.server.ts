import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createDshProvider } from "./server/provider.ts";
import { dshSettings } from "./shared/settings.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(dshSettings);
  server.registerProvider(createDshProvider(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`DSH plugin settings are invalid: ${state.error}`);
    return state.values;
  }));
  return () => {};
}
