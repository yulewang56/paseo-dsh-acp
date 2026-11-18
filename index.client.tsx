import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DiscoverySettings } from "./client/settings.tsx";
import { deepseekWhale } from "./shared/brand.ts";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "discovery", title: "Discovery", icon: deepseekWhale, Component: DiscoverySettings,
  });
}
