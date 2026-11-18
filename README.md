# DeepSeek Harness ACP for Paseo

[English](README.en.md) | 中文

将官方 `dsh --profile acp` 接入 Paseo，provider ID 为 `deepseek`。
支持会话恢复与历史回放、任务列表、Auto Accept、Skills 菜单和命名 Agent。
模型请求、工具执行与沙箱由 DSH 处理；不依赖 DSH Desktop。

## 安装

在 **Paseo daemon 所在机器**准备：

- Paseo daemon 和客户端 >= 0.16.1，并已开启 Settings → Plugins。
- daemon Node >= 22.15；DSH 已验证 `0.2.2-alpha.2`，要求 Node >= 24.9.0。
- 已配置模型与凭据的官方 DSH CLI。

```sh
npm install -g @deepseek-ai/dsh@0.2.2-alpha.2
dsh --profile acp --help
paseo plugin add git:yulewang56/paseo-dsh-acp
paseo plugin ls
paseo provider diagnostic deepseek --json
```

Git 安装会通过锁定的依赖文件安装运行时依赖，需要 npm。插件应为 `running`，
provider 应为 `Ready`；首次使用仍需发送一条消息验证模型鉴权。
插件是受信任的非沙箱代码，以 daemon 用户权限运行，安装前请检查源码。

本地开发使用目录源：

```sh
git clone https://github.com/yulewang56/paseo-dsh-acp.git
cd paseo-dsh-acp
npm ci
paseo plugin install /absolute/path/to/paseo-dsh-acp
```

daemon 找不到 `dsh` 时，将实际路径合并到 `~/.paseo/config.json`：

```json
{
  "agents": {
    "providers": {
      "deepseek": {
        "enabled": true,
        "command": ["/absolute/path/to/dsh", "--profile", "acp"]
      }
    }
  }
}
```

Windows 使用实际 `dsh.cmd` 路径；若默认 Node 过旧，可将 command 改为
`["/path/to/node", "/path/to/dsh/lib/bin.js", "--profile", "acp"]`。
配置修改后执行 `paseo reload --json`，无需重启 daemon。

## 使用与设置

选择 DeepSeek 模型后，输入 `/` 选择 Skills，在模型/effort 控件旁选择 Agent。
Paseo 窄布局可能隐藏 provider 控件。Agent 必须在首轮之前选择；已有会话保留选择。

在 **Settings → Plugins → DeepSeek Harness ACP** 打开设置，可配置：

- 额外 Agent / Skills 目录：每行一个绝对主机路径或 `~/路径`。
- Claude / Copilot Skills 发现开关，默认开启。
- Agent 模型别名 JSON，例如：

```json
{
  "sonnet": {
    "provider": "deepseek-official",
    "model": "deepseek/deepseek-v4-pro"
  }
}
```

显式保存后对新建或重新打开的会话生效；现有 Agent 请手动 Reload。
设置按主机共享，凭据和 DSH profile 不在这里修改，Auto Accept 仍按会话保存。
环境变量 `DSH_ACP_AGENT_DIRS` 的目录排在页面目录之前；
`DSH_ACP_MODEL_ALIASES` 覆盖页面同名别名；额外 Skills 目录追加到 profile 的
`customSkillDirs` 后。环境变量或页面映射无效时明确报错，不静默忽略。

### Skills 发现

按以下顺序发现，靠前者优先；目录和文件按真实路径去重，支持符号链接。
`<project>` 为最近的 Git 根目录，无 Git 时使用 cwd。

| 顺序 | 目录 |
|---|---|
| 1 | `<project>/.dsh/skills`、`<project>/.agents/skills` |
| 2 | DSH profile 的 `customSkillDirs` 与插件额外目录 |
| 3 | `~/.dsh/skills`、`~/.agents/skills`、DSH bundled Skills |
| 4 | `<project>/.claude/skills`、`<project>/.copilot/skills` |
| 5 | `~/.claude/skills`、`~/.copilot/skills` |

支持 `<name>/SKILL.md` 或 `<name>.md`。原生用户目录遵循 `DSH_HOME` / `DSH_AGENTS_HOME`。
profile 的 `includeDefaultRoots: false` 也会关闭兼容默认目录，不影响显式自定义路径。
解析、加载、资源路径与变更监听复用 DSH 原生实现；菜单仅列出用户可调用的 Skills。

**发现兼容不等于执行兼容**：其他生态 Skills 的 `allowed-tools`、model、context/fork、
hooks 等字段不会因此被执行或强制，不能作为 DSH 权限边界。

### Agent 定义

发现顺序：项目 `.dsh/agents`、项目 `.agents/agents`、自定义目录、
`~/.dsh/agents`、`~/.agents/agents`、项目/用户 `.claude/agents`、
项目/用户 `.copilot/agents`。自定义目录可通过设置页或 `DSH_ACP_AGENT_DIRS` 指定。

支持 `<name>/AGENT.md`、`<name>.md`，以及 Copilot 的 `.agent.md`。
`.github/agents` 不扫描；`AGENTS.md` / `CLAUDE.md` 是指令文件，不是 Agent 定义。
目录与文件按 `realpath` 去重，符号链接使用真实来源的适配语义；不同文件同名按优先级覆盖并警告。

```markdown
---
name: reviewer
description: Review code without modifying files
tools: [read, grep, glob]
---
Review correctness and explain actionable findings.
```

所有来源使用完整 YAML 解析与统一 schema，支持 persona、工具 allow/deny、
`provider` / `model` / `reasoningEffort`、调用控制和展示字段；已知 Claude/Copilot
工具名会适配到 DSH。`tools: []` 表示无工具。模型需在 DSH catalog 中存在；
`sonnet` / `opus` 等别名必须显式映射，不会猜测。

选择 Agent 会应用根会话的 persona、工具、模型与 effort；Default 恢复 baseline，
恢复会话不会覆盖已持久化的模型。`maxTokens` 仅用于子代理。
模型可调用 `delegate_to_agent` 创建真实子会话并接收完成通知；子会话共享 cwd、
进程和沙箱，不提供 OS/worktree 隔离。

hooks、permissions、MCP servers、plugins、background、memory、skills、handoffs
等未实现的执行字段，以及未知字段、无法等价映射的工具，会保留并明确诊断。
不可执行的定义在 picker 中显示原因，选择或委派会拒绝，不会静默放宽限制。
定义在新建/恢复会话时扫描，当前 picker 不保证实时刷新。

## 会话与权限

恢复同一 DSH session ID，并只读回放 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）
的 v4 JSONL / Zstd 日志、上下文用量与任务列表。自定义存储可设置
`DSH_ACP_SESSION_ROOT`。恢复失败明确报错，不以空会话代替；非文本附件仅保留类型占位。

Auto Accept 自动批准单次 DSH 请求，但不关闭沙箱；选择按会话持久化。
DSH 的 `DSH_PERMISSION_MODE` 可设为 `read-only`、`workspace-write`（默认）或
`danger-full-access`，由 provider 启动环境决定，变更后需重载。
不支持持久权限、原生 steering、fork/rewind 或非 Skills 的原生命令。

第三方模型在 DSH 的 ACP profile 中配置，参考
[路由示例](examples/third-party.cordis.patch.yml)。ACP 与 `web` profile 独立；
保留已有路由与凭据，不要覆盖整个配置或提交密钥。提示词与工具结果会发送到 DSH 选定的模型端点。

## 更新与迁移

```sh
paseo plugin update dsh-acp                     # Git 安装
# 目录安装：在仓库中执行
git pull --ff-only
npm ci
paseo plugin reload dsh-acp
```

重载会停止该插件的 provider 进程，请先结束正在运行的任务。DSH CLI 单独更新。
从旧 `dsh` provider 升级时，将配置中的完整 provider 对象迁移到 `deepseek`，
再运行 `paseo reload --json`。旧 `dsh` agent 无法直接恢复；DSH 会话文件不会被删除。
权限设计见 [ADR 0001](docs/adr/0001-permissions-and-options.md)。

## 开发

```sh
npm ci
npm run embed       # 修改 DSH overlay 模块后重新生成
npm run typecheck
DSH_TEST_COMMAND=/absolute/path/to/dsh npm test
```

测试使用 fixture / loopback 模型。需要真实模型时：

```sh
DSH_TEST_COMMAND=/absolute/path/to/dsh \
DSH_TEST_MODEL='["your-route","your-model"]' npm run test:real
```

许可证：MIT。图标与商标声明见 [NOTICE](NOTICE)。
