# DeepSeek Harness ACP for Paseo

[English](README.en.md) | 中文

把**官方 DSH ACP profile**接入 Paseo。provider ID 为 `deepseek`。插件复用 Paseo
的 `runAcpProvider`，补充会话恢复、本地历史回放、自动批准和 Skills 菜单；没有自定义 agent 循环，不代理
模型请求，不依赖 DSH Desktop。

```text
Paseo → 标准 ACP adapter + DSH 恢复兼容层 → dsh --profile acp → DSH 配置的模型 API
```

## 要求

以下操作在 **Paseo daemon 所在机器**执行。

- Paseo >= 0.15.3，已启用插件。
- daemon Node >= 22.15（Zstandard 解压）。
- 官方 DSH CLI，已验证 0.2.2-alpha.2（该版本要求 Node >= 24.9.0）。

插件是受信任的非沙箱代码，以 daemon 用户权限运行，安装前请检查源码。插件不安装
DSH、不上传配置或凭据，历史回放只读访问 DSH 会话文件。

## 安装

### 1. 准备 DSH

```sh
npm install -g @deepseek-ai/dsh
dsh --version
dsh --profile acp --help
```

需要复现时固定版本：`@deepseek-ai/dsh@0.2.2-alpha.2`。也可使用官方 Desktop 注册的
`dsh`，但需确认支持 ACP。

### 2. 安装插件

先开启 daemon 的全局插件开关（Settings → Plugins）。

```sh
paseo plugin add git:yulewang56/paseo-dsh-acp
paseo plugin ls
paseo provider diagnostic deepseek --json
```

Git 安装不可用时使用目录源：

```sh
git clone https://github.com/yulewang56/paseo-dsh-acp.git
paseo plugin install /absolute/path/to/paseo-dsh-acp
```

不需要 `npm install`：插件没有 build/install 脚本。插件应为 `running`，provider 应为
`Ready`；诊断不验证模型调用。

### 3. CLI 路径（可选）

默认执行 `dsh --profile acp`。daemon 找不到 `dsh` 时，把下面对象**合并**进
`~/.paseo/config.json`：

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

Windows 用实际 `dsh.cmd` 路径；目前仅在 macOS 实测，其他平台同样跑诊断。Windows
冷启动可能耗时 7–14 秒；插件把 ACP 初始化超时设为 30 秒，不需要先启动 `dsh web`
预热。默认 Node 太旧时，把 `command` 改为
`["/path/to/node", "/path/to/dsh/lib/bin.js", "--profile", "acp"]`。

```sh
paseo reload --json
paseo provider diagnostic deepseek --json
```

无需重启 daemon，但重载会终止旧 provider 进程，请先结束任务。

## 从旧 `dsh` provider 升级（1.3.0）

provider ID 已从 `dsh` 改为 `deepseek`；插件 ID 仍是 `dsh-acp`，CLI 仍是
`dsh --profile acp`，没有旧别名。

备份 `~/.paseo/config.json`，把 `agents.providers.dsh` 的完整对象（含 command/env）
复制到 `agents.providers.deepseek` 后删除旧项；已有 `deepseek` 配置时先核对合并。
然后：

```sh
paseo reload --json
paseo plugin reload dsh-acp
paseo provider diagnostic deepseek --json
```

旧 agent 的 provider/persistence 仍为 `dsh`，**无法恢复**；插件不改写旧记录，也不
删除 DSH 会话文件。升级后请新建 agent；需要恢复旧 agent 时，先回退插件源和配置备份。

若 Paseo 未来内置 `deepseek` provider，本插件会因同名冲突注册失败，届时改用
`deepseek-harness` 等更具体的 ID 并再次迁移。

## 更新

```sh
paseo plugin update dsh-acp                                    # Git 安装
git -C <repo> pull --ff-only && paseo plugin reload dsh-acp    # 目录安装
```

DSH 单独更新：`npm install -g @deepseek-ai/dsh`，之后重跑诊断。两者都不会修改第三方
模型配置。

## 第三方 DeepSeek 模型

支持。模型请求由 DSH 发出；网关必须提供 DSH 需要的 API、工具调用和流式响应，网页
聊天服务不够。模型 ID、思考参数、上下文、图片能力和费用由第三方决定。

1. 运行一次 `dsh --profile acp --help` 初始化 ACP profile。
2. 把[示例](examples/third-party.cordis.patch.yml)合并到
   `~/.dsh/profiles/acp/cordis.patch.yml`（`DSH_HOME` 下同理），替换 endpoint 和
   model ID。
3. 凭据写入 `~/.dsh/.credentials.yaml` 的 `refs`：

```yaml
version: 1
refs:
  DSH_GATEWAY_API_KEY: REPLACE_WITH_YOUR_SECRET
```

保留已有 refs，不要覆盖整个文件或提交密钥，建议 `chmod 600`。也可显式向
daemon/provider 传同名环境变量。

注意：

- ACP 与 `web` 是不同 profile，`dsh web` 里保存的路由不会自动生效。
- Cordis `config` 覆盖是**整项替换**，保留 `llm-pi-ai` 的其他路由，不要重复同 id。
- 旧会话可能保留旧模型选择，请在 Paseo 中显式选择。
- 完成后运行 `paseo provider diagnostic deepseek --json`，再发一条最小请求验证鉴权、
  工具调用和网络；`Ready` 不代表推理成功。

## 能力与限制

### 会话恢复与历史

DSH 0.2.2-alpha.2 只有 `session/resume`，没有 `session/load` 和历史回放；Paseo
0.15.3 仅凭 `loadSession` 声明 `session.persistence`。插件把 `session/load` 转成
`session/resume` 恢复同一 session ID，并从本地 v4 日志回放历史（读取全部 Zstd 帧）；
失败时明确报错，不新建空会话。回放同时恢复最后一次上下文用量，重启后 context
meter 不会空白等待下一轮。

日志位于 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`），支持
`session.v4.jsonl.zstd` 和 `.jsonl`，只读。自定义存储 root 用 provider 环境变量
`DSH_ACP_SESSION_ROOT` 指向。非文本附件只显示类型占位，`history: skip` 不回放。

### 交互语义

| 方面 | 行为 |
|---|---|
| 配置 | 仅接受插件选项 `auto_accept`；拒绝非空 `systemPrompt`、未知选项、`toolPolicy.preapproved`、`persist=false`；MCP 仅 stdio/Streamable HTTP。 |
| 取消/并发 | 不声明 `prompt.steer`；并发 `auto` 先中断旧回合，显式 `steer` 拒绝；取消只结束当前回合一次。 |
| 权限 | 仅单次允许/拒绝；补齐 DSH 缺失的工具上下文，不编造参数；拒绝持久授权、改写输入、拒绝说明和拒绝并中断。 |
| 模型档位 | 保留不透明 ID；无效选择不提交，不污染当前配置。 |
| 会话列表 | 跟随全部 `nextCursor` 并去重；重复 cursor 或后续页失败报错；`query`/`limit` 取齐后应用。 |
| 回合结束 | `max_tokens`、`max_turn_requests`、`refusal` 给出警告；API 错误和进程退出算失败。 |
| 历史/附件 | 未完成工具不再永久 running；无详情失败显式说明；工具结果映射为实时 `output`；非文本只显示类型占位。 |

`title` 只是 Paseo 本地元数据。插件不声明原生 steering、持久权限、结构化输出、
fork/rewind 或桌面模式；ACP 输出是已提交消息，不是 token 级流。图片能力取决于 DSH
路由，插件不提升声明。

### 权限与自动批准

DSH 的审批只有单次允许/拒绝，没有“始终允许”。插件在 composer 中提供一个
`Auto Accept` 开关：开启后插件直接以 `allow-once` 应答
`session/request_permission` 并在时间线留下 info 记录；沙箱仍然生效，越界写仍会
先被拒绝再升级。

设置按 DSH 会话保存到 `$DSH_HOME/paseo-acp-options`（默认 `~/.dsh` 下）；
配置 `DSH_ACP_SESSION_ROOT` 时保存到该目录下的 `paseo-options`，保存失败会报错。
开关在建立会话后可用，尚未建立会话的草稿不显示。

DSH 的沙箱档位由启动环境决定（默认 `workspace-write`）：

```json
{
  "agents": {
    "providers": {
      "deepseek": { "env": { "DSH_PERMISSION_MODE": "danger-full-access" } }
    }
  }
}
```

| 值 | 沙箱 | 审批 |
|---|---|---|
| `read-only` | 只读 | ask |
| `workspace-write` | 工作区可写 | ask |
| `danger-full-access` | 不限制 | never（无弹窗） |

该模式是进程级的，修改后需重载 provider；Paseo 里没有 per-session 选择器，ACP
也不暴露 DSH 的 `/permission`。设计与迁移计划见
[ADR 0001](docs/adr/0001-permissions-and-options.md)。

### Skills

DSH ACP 自带原生 `skill` 工具和 Skills 发现，不需要插件复制或注入指令。
默认扫描项目的 `.dsh/skills`、`.agents/skills`，以及用户的
`~/.dsh/skills`、`~/.agents/skills`。注意是 **`.agents`（复数）**，
不是 `.agent`。Paseo 安装的编排 Skills 就在 `~/.agents/skills`；
只安装在 `~/.claude/skills` 的其他 Skills 不在 DSH 默认扫描范围内。
`DSH_AGENTS_HOME` 可覆盖共享用户目录，`DSH_HOME` 可覆盖 DSH 目录；
自定义路径还可以通过 DSH 的 `skill-filesystem.customSkillDirs` 配置。

**建立 DeepSeek 会话后，在输入框键入 `/` 即可选择已发现的 Skills**，例如 `/paseo`。
也可以在聊天中要求“使用 paseo skill”，或直接发送 `/paseo ...` 文本。
选择菜单条目会把名称和参数交给 DSH 的原生 Skills 调用解析器，不会自行拼接技能正文。

菜单只列出允许用户调用的 Skills，随发现结果更新；发现不完整或失败会明确提示。
尚未建立会话的草稿不显示 Skills 菜单。

插件不额外安装 DSH 的 Office 等 Skills 包。ACP 默认启用的是文件系统 Skills
和原生加载工具；其他 DSH Skills 是否存在，取决于 ACP profile 启用的包以及本地
Skills 目录，不能从 DSH Desktop 的菜单推断。

### 其他

已验证版本没有 Standard/PTC/Minimal/Creator preset、原生 Plan 审批卡片等桌面功能；
模型、权限与会话能力由 DSH/Paseo 握手决定。

## 开发与测试

```sh
npm ci
npm run typecheck
npm test        # fixture，不调用模型
```

真实 DSH 集成测试（读取 `~/.dsh`，需允许 `dsh` 写 profile；会调用模型验证取消、
最小回复及两个临时 Skills 的发现和加载）：

```sh
DSH_TEST_COMMAND=/absolute/path/to/dsh \
DSH_TEST_MODEL='["your-route","your-model"]' \
npm run test:real
```

`test:real` 在变量缺失、路径不可执行或 JSON 错误时直接失败，不会静默 skip；`--all`
连 fixture 一起跑。确定性分支由 fixture 覆盖。

仓库自带 `dsh-acp-testing` skill：真实文件在 `.agents/skills/`（DSH/Copilot 读取），
`.claude/skills/` 为其符号链接（Claude Code 读取）。

许可证：MIT。图标来源与商标声明见 [NOTICE](NOTICE)。

参考：[官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、
[官方模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)、
[Paseo provider 插件](https://paseo.sh/docs/plugins/providers.md)。
