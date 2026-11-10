# DeepSeek Harness ACP for Paseo

[English](README.en.md) | 中文

把**官方 DSH ACP profile**接入 Paseo，附带跟随深浅主题的黑白 DeepSeek 图标。
provider ID 为 `deepseek`。插件复用 Paseo 的 `runAcpProvider`，只补充会话恢复与
本地历史回放；没有自定义 agent 循环，不代理模型请求，不依赖 DSH Desktop。

```text
Paseo → 标准 ACP adapter + DSH 恢复兼容层 → dsh --profile acp → DSH 配置的模型 API
```

## 要求

以下操作在 **Paseo daemon 所在机器**执行。

- Paseo >= 0.15.3，已启用插件。
- daemon Node >= 22.15（Zstandard 解压）。
- 官方 DSH CLI，已验证 0.2.2-alpha.2（该版本要求 Node >= 24.9.0）。
- 私有仓库读取权限，先配置 GitHub/Git 凭据。

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
gh auth setup-git
paseo plugin add git:yulewang56/paseo-dsh-acp
paseo plugin ls
paseo provider diagnostic deepseek --json
```

Git 安装不可用时使用目录源：

```sh
gh repo clone yulewang56/paseo-dsh-acp
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

Windows 用实际 `dsh.cmd` 路径；目前仅在 macOS 实测，其他平台同样跑诊断。默认 Node
太旧时，把 `command` 改为
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
失败时明确报错，不新建空会话。

日志位于 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`），支持
`session.v4.jsonl.zstd` 和 `.jsonl`，只读。自定义存储 root 用 provider 环境变量
`DSH_ACP_SESSION_ROOT` 指向。非文本附件只显示类型占位，`history: skip` 不回放。

### 交互语义

| 方面 | 行为 |
|---|---|
| 配置 | 拒绝非空 `systemPrompt`、`providerOptions`、通用 `settings`、`toolPolicy.preapproved`、`persist=false`；MCP 仅 stdio/Streamable HTTP。 |
| 取消/并发 | 不声明 `prompt.steer`；并发 `auto` 先中断旧回合，显式 `steer` 拒绝；取消只结束当前回合一次。 |
| 权限 | 仅单次允许/拒绝；补齐 DSH 缺失的工具上下文，不编造参数；拒绝持久授权、改写输入、拒绝说明和拒绝并中断。 |
| 模型档位 | 保留不透明 ID；无效选择不提交，不污染当前配置。 |
| 会话列表 | 跟随全部 `nextCursor` 并去重；重复 cursor 或后续页失败报错；`query`/`limit` 取齐后应用。 |
| 回合结束 | `max_tokens`、`max_turn_requests`、`refusal` 给出警告；API 错误和进程退出算失败。 |
| 历史/附件 | 未完成工具不再永久 running；无详情失败显式说明；工具结果映射为实时 `output`；非文本只显示类型占位。 |

`title` 只是 Paseo 本地元数据。插件不声明原生 steering、持久权限、结构化输出、
fork/rewind 或桌面模式；ACP 输出是已提交消息，不是 token 级流。图片能力取决于 DSH
路由，插件不提升声明。

### 其他

已验证版本没有 Standard/PTC/Minimal/Creator preset、原生 Plan 审批卡片等桌面功能；
模型、权限与会话能力由 DSH/Paseo 握手决定。

## 开发与测试

```sh
npm ci
npm run typecheck
npm test        # fixture，不调用模型
```

真实 DSH 集成测试（读取 `~/.dsh`，需允许 `dsh` 写 profile；会发两次最小模型请求）：

```sh
DSH_TEST_COMMAND=/absolute/path/to/dsh \
DSH_TEST_MODEL='["your-route","your-model"]' \
npm run test:real
```

`test:real` 在变量缺失、路径不可执行或 JSON 错误时直接失败，不会静默 skip；`--all`
连 fixture 一起跑。确定性分支由 fixture 覆盖。

仓库自带 `dsh-acp-testing` skill：真实文件在 `.agents/skills/`（DSH/Copilot 读取），
`.claude/skills/` 为其符号链接（Claude Code 读取）。

图标来自官方 DSH Web frontend 的 `favicon.svg`（MIT），fill 改为 `currentColor`。
商标归各自所有者所有；本项目不是 DeepSeek 或 Paseo 的官方插件。

参考：[官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、
[官方模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)、
[Paseo provider 插件](https://paseo.sh/docs/plugins/providers.md)。
