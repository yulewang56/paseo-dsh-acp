import { useEffect, useState } from "react";
import { Platform, Pressable, Switch, Text, TextInput, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { deepseekWhale } from "../shared/brand.ts";
import { defaultSettings, dshSettings, parseSettingsForm, type DshSettings } from "../shared/settings.ts";

const brand = { blue: "#4D6BFE", button: "#3D5CDB", onBlue: "#FFFFFF", tint: "rgba(77, 107, 254, 0.08)" };
const formFor = (values: DshSettings) => ({
  ...values, agentDirs: values.agentDirs.join("\n"), skillDirs: values.skillDirs.join("\n"),
  modelAliases: JSON.stringify(values.modelAliases, null, 2),
});

export function DiscoverySettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(dshSettings);
  const [form, setForm] = useState<ReturnType<typeof formFor>>();
  const [revision, setRevision] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [focused, setFocused] = useState<string>();
  useEffect(() => {
    if (settings.status === "ready" && !dirty) {
      setForm(formFor(settings.values));
      setRevision(settings.revision);
    }
  }, [settings.status === "ready" ? settings.revision : settings.status, dirty]);

  const colors = theme.colors;
  const muted = { color: colors.foregroundMuted, fontSize: 12, lineHeight: 19 };
  const title = { color: colors.foreground, fontSize: 15, fontWeight: "600" as const };
  const card = { backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 14, overflow: "hidden" as const };
  const inset = layout.compact ? 16 : 20;
  const update = (patch: Partial<ReturnType<typeof formFor>>) => {
    setForm((current) => current && ({ ...current, ...patch }));
    setDirty(true); setError(""); setMessage(""); setConfirmReset(false);
  };
  async function save() {
    if (!form) return;
    setError(""); setMessage("");
    try {
      if (await settings.save(parseSettingsForm(form), revision)) {
        setDirty(false);
        setMessage("已保存。新建或重新打开会话时生效；现有 Agent 请手动 Reload。");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function reload() {
    try {
      await settings.reload(); setDirty(false); setError(""); setMessage(""); setConfirmReset(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function reset() {
    try {
      if (await settings.reset()) {
        setForm(formFor(defaultSettings())); setDirty(false); setError(""); setConfirmReset(false);
        setMessage("已恢复默认设置。新建或重新打开会话时生效。");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const textButton = (label: string, onPress: () => void, disabled = false, danger = false) => (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 10, borderRadius: 8, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}>
      <Text style={{ color: danger ? colors.statusDanger : colors.foregroundMuted, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
  const field = (key: "agentDirs" | "skillDirs" | "modelAliases", label: string, hint: string, placeholder: string) => (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "500" }}>{label}</Text>
      <TextInput accessibilityLabel={label} multiline value={form?.[key] ?? ""}
        editable={!settings.saving} onChangeText={(text) => update({ [key]: text })}
        onFocus={() => setFocused(key)} onBlur={() => setFocused(undefined)}
        autoCapitalize="none" autoCorrect={false} placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted} selectionColor={brand.blue}
        style={{ color: colors.foreground, backgroundColor: colors.surface0,
          borderColor: focused === key ? brand.blue : colors.border, borderWidth: 1, borderRadius: 9,
          padding: 12, minHeight: key === "modelAliases" ? 172 : 104, width: "100%",
          fontSize: 12, lineHeight: 20, fontFamily: Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "monospace",
          textAlignVertical: "top" }} />
      <Text style={muted}>{hint}</Text>
    </View>
  );
  const source = (key: "claudeSkills" | "copilotSkills", label: string, path: string, last = false) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16, padding: inset,
      borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{label}</Text>
        <Text style={muted}>项目与用户目录 · {path}</Text>
      </View>
      <Switch accessibilityLabel={label} value={form?.[key] ?? false} disabled={settings.saving}
        {...(Platform.OS === "web" ? { activeThumbColor: brand.onBlue } : {})}
        hitSlop={12}
        thumbColor={brand.onBlue} trackColor={{ false: colors.border, true: brand.blue }} onValueChange={(value) => update({ [key]: value })} />
    </View>
  );
  const alert = (text: string, color: string) => (
    <View style={{ padding: 14, borderRadius: 10, borderWidth: 1, borderColor: color, backgroundColor: colors.surface1 }}>
      <Text selectable accessibilityRole="alert" style={{ color, fontSize: 13, lineHeight: 21 }}>{text}</Text>
    </View>
  );
  return (
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", gap: 24, backgroundColor: colors.surface0 }}>
      <View style={{ gap: 10, paddingVertical: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ backgroundColor: brand.tint, padding: 10, borderRadius: 13 }}>
            <Icon icon={deepseekWhale} size={34} color={brand.blue} />
          </View>
          <View style={{ gap: 6, flex: 1 }}>
            <Text style={{ color: brand.blue, fontSize: 11, letterSpacing: 1.8, fontWeight: "700" }}>DEEPSEEK HARNESS</Text>
            <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: layout.compact ? 24 : 28, fontWeight: "600", letterSpacing: -0.5 }}>发现与适配</Text>
          </View>
        </View>
        <Text style={{ ...muted, fontSize: 13 }}>连接你的 Skills、Agent 定义与模型。配置仅保存在当前主机。</Text>
      </View>

      {settings.status === "loading" && <Text style={muted}>正在读取设置…</Text>}
      {(settings.status === "error" || settings.status === "invalid") && alert(settings.error, colors.statusDanger)}
      {settings.status === "ready" && form && <>
        <View style={{ gap: 12 }}>
          <View style={{ gap: 5 }}>
            <Text accessibilityRole="header" style={title}>Skills 来源</Text>
            <Text style={muted}>自动发现兼容目录，保留 DSH 原生发现规则。</Text>
          </View>
          <View style={card}>
            {source("claudeSkills", "Claude", ".claude/skills")}
            {source("copilotSkills", "GitHub Copilot", ".copilot/skills", true)}
          </View>
        </View>

        <View style={{ gap: 12 }}>
          <View style={{ gap: 5 }}>
            <Text accessibilityRole="header" style={title}>额外目录</Text>
            <Text style={muted}>每行一个绝对主机路径或 ~/路径。留空即可使用默认发现规则。</Text>
          </View>
          <View style={{ ...card, padding: inset, gap: 20, flexDirection: "row", flexWrap: "wrap" }}>
            <View style={{ flexGrow: 1, flexBasis: 250, minWidth: 0 }}>{field("agentDirs", "Agent 定义", "与环境变量目录合并，环境变量在前。", "~/my-agents")}</View>
            <View style={{ flexGrow: 1, flexBasis: 250, minWidth: 0 }}>{field("skillDirs", "Skills", "追加到 DSH profile 的自定义目录之后。", "~/my-skills")}</View>
          </View>
        </View>

        <View style={card}>
          <Pressable accessibilityRole="button" accessibilityLabel="Agent 模型别名" accessibilityState={{ expanded: advanced }}
            onPress={() => setAdvanced(!advanced)} style={{ padding: inset, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ backgroundColor: brand.tint, padding: 9, borderRadius: 9 }}><Icon name="Waypoints" size={18} color={brand.blue} /></View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ ...title, fontSize: 14 }}>Agent 模型别名</Text>
              <Text style={muted}>将其他 Agent 的模型名称映射到 DSH 模型</Text>
            </View>
            <Icon name={advanced ? "ChevronUp" : "ChevronDown"} size={16} color={colors.foregroundMuted} />
          </Pressable>
          {advanced && <View style={{ padding: inset, paddingTop: 0, gap: 12 }}>
            {field("modelAliases", "模型映射 · JSON", "支持 sonnet / opus / haiku / fable / opusplan。必填 provider、model；可选 reasoningEffort。", '{\n  "sonnet": {\n    "provider": "deepseek-official",\n    "model": "deepseek/deepseek-v4-pro"\n  }\n}')}
            <Text style={muted}>DSH_ACP_MODEL_ALIASES 的同名项优先。别名仍需通过 DSH 模型目录校验。</Text>
          </View>}
        </View>
        {dirty && settings.revision !== revision && alert("其他客户端已更新设置，当前草稿已保留。请先复制草稿，再放弃修改并重读，避免覆盖他人的配置。", colors.statusWarning)}
      </>}

      {!!(error || settings.saveError) && alert(error || settings.saveError || "", colors.statusDanger)}
      {!!message && alert(message, colors.statusSuccess)}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 150, gap: 4 }}>
            <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "500" }}>{dirty ? "有未保存的修改" : settings.status === "ready" ? "配置已同步" : settings.status === "loading" ? "正在同步配置" : "配置暂不可用"}</Text>
            <Text style={muted}>保存后新建或重开会话生效</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="保存配置"
            accessibilityState={{ disabled: settings.status !== "ready" || !form || !dirty || settings.saving, busy: settings.saving }}
            disabled={settings.status !== "ready" || !form || !dirty || settings.saving} onPress={() => void save()}
            style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 22, justifyContent: "center", borderRadius: 9,
              backgroundColor: settings.status !== "ready" || !dirty || settings.saving ? colors.surface2 : brand.button,
              opacity: pressed ? 0.8 : 1 })}>
            <Text style={{ color: settings.status !== "ready" || !dirty || settings.saving ? colors.foregroundMuted : brand.onBlue, fontSize: 13, fontWeight: "600" }}>{settings.saving ? "保存中…" : "保存配置"}</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginHorizontal: -10 }}>
          {textButton(dirty ? "放弃修改并重读" : "重新读取", () => void reload(), settings.saving || settings.status === "loading")}
          {textButton("恢复默认…", () => setConfirmReset(!confirmReset), settings.saving || (settings.status !== "ready" && settings.status !== "invalid"))}
        </View>
        {confirmReset && <View style={{ ...card, padding: 16, gap: 8 }}>
          <Text style={{ ...title, fontSize: 13 }}>恢复默认配置？</Text>
          <Text style={muted}>清空额外目录与模型别名，开启两个 Skills 来源。不会修改环境变量、DSH profile 或用户文件。</Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            {textButton("取消", () => setConfirmReset(false), settings.saving)}
            {textButton("确认重置并保存", () => void reset(), settings.saving, true)}
          </View>
        </View>}
      </View>

      <View style={{ gap: 10, paddingBottom: 8 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showHelp }} onPress={() => setShowHelp(!showHelp)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 }}>
          <Icon name="Info" size={14} color={colors.foregroundMuted} />
          <Text style={muted}>生效规则与配置说明</Text>
          <Icon name={showHelp ? "ChevronUp" : "ChevronDown"} size={13} color={colors.foregroundMuted} />
        </Pressable>
        {showHelp && <View style={{ gap: 10, paddingLeft: 20 }}>
          <Text style={muted}>设置由当前主机的已授权客户端共享。现有 Agent 需手动 Reload；已有草稿如仍显示旧目录，请重开创建界面或 Reload 插件。保存不会中断当前会话。</Text>
          <Text style={muted}>DSH profile 的 includeDefaultRoots: false 仍禁用所有默认目录；显式自定义路径不受 Skills 来源开关影响。</Text>
          <Text style={muted}>凭据、DSH_HOME / DSH_AGENTS_HOME 与模型服务商仍在 DSH / Paseo 外部配置。自动批准仍按会话设置，不会自动重启 daemon 或改写用户文件。</Text>
        </View>}
      </View>
    </View>
  );
}
