import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "dsh",
      label: "DeepSeek Harness",
      description: "Official DeepSeek Harness ACP profile",
      icon: "icon.svg",
      command: ["dsh", "--profile", "acp"],
    }),
  );
  return () => {};
}
