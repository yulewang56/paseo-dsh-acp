# DeepSeek Harness ACP for Paseo

把**官方 DSH ACP profile**接入 Paseo，加上随深浅主题变色的黑白 DeepSeek 图标。
provider ID 为 `dsh`。本插件复用 Paseo 自带的 `runAcpProvider`，补充官方 DSH
ACP 的会话恢复与本地历史回放兼容层，没有自定义 agent 循环或模型代理，
也不依赖 DSH Desktop。

```text
你的应用 / Paseo
  → Paseo daemon
  → 标准 ACP adapter + DSH 会话恢复兼容层
  → dsh --profile acp
  → DSH 配置的模型 API
```

## 在其他 host 安装

以下操作均在 **Paseo daemon 所在机器**执行，不是只在连接它的手机或电脑上执行。

要求：

- Paseo >= 0.15.3，且已启用插件。
- daemon 的 Node >= 22.15，支持 Zstandard 解压；本机 Desktop 内置运行时已满足。
- 官方 DSH CLI；已验证 DSH 0.2.2-alpha.2。
- 满足所选 DSH 版本要求的 Node。验证版本要求 Node >= 24.9.0。
- Git 私有仓库读取权限。当前仓库为私有，先配置 GitHub/Git 身份验证。

插件是受信任的非沙箱代码，会以 daemon 用户权限运行。安装前请检查源码。
本插件不会自动安装或更新 DSH，不会上传本机配置或凭据。
历史回放会只读访问 daemon host 上的 DSH 会话文件，不读取模型密钥。

### 1. 准备 DSH

```sh
node --version
npm install -g @deepseek-ai/dsh
dsh --version
dsh --profile acp --help
```

npm 默认源或企业镜像的 `latest` 可能不同；需要复现时可使用
`npm install -g @deepseek-ai/dsh@0.2.2-alpha.2`。也可以使用官方 Desktop
注册的 `dsh` 命令，但要确认它支持 ACP。

### 2. 安装插件

先确认目标 daemon 的全局插件开关已开启（Settings → Plugins）。

```sh
gh auth setup-git
paseo plugin add git:yulewang56/paseo-dsh-acp
paseo plugin ls
paseo provider diagnostic dsh --json
```

如果 Git 安装不可用，也可使用目录源：

```sh
gh repo clone yulewang56/paseo-dsh-acp
paseo plugin install /absolute/path/to/paseo-dsh-acp
```

安装不需要执行 `npm install`，Paseo 提供运行时 SDK；没有 build/install 脚本。
要求插件为 `running`，provider 为 `Ready`。这些诊断不验证模型 API 调用成功。

### 3. 必要时覆盖 CLI 路径

默认启动 `dsh --profile acp`。如果 daemon 找不到 `dsh`，将下面的对象**合并**
进该 host 的 `~/.paseo/config.json`，不要覆盖其他配置：

```json
{
  "agents": {
    "providers": {
      "dsh": {
        "enabled": true,
        "command": ["/absolute/path/to/dsh", "--profile", "acp"]
      }
    }
  }
}
```

Windows 可填实际 `dsh.cmd` 路径；插件使用 Paseo 标准 ACP 启动器。
只在 macOS 上实测过，Windows/Linux 应执行同样的诊断。
如果默认 Node 太旧，也可将 `command` 改为：

```json
["/absolute/path/to/compatible/node", "/absolute/path/to/dsh/lib/bin.js", "--profile", "acp"]
```

若从旧的 config-only ACP 注册迁移，保留 `dsh` 下的 command/env 等覆盖项，
但移除 `"extends": "acp"`；现在由本插件注册同一个 provider ID。

```sh
paseo reload --json
paseo provider diagnostic dsh --json
```

不需要重启 daemon。插件更新/重载可能影响它所管理的 DSH 会话，请先让任务结束。

## 更新

Git 安装：

```sh
paseo plugin update dsh-acp
```

目录安装：

```sh
git -C /absolute/path/to/paseo-dsh-acp pull --ff-only
paseo plugin reload dsh-acp
```

DSH 与插件分别更新。更新 npm 安装的 DSH 使用
`npm install -g @deepseek-ai/dsh`，之后再次运行 provider diagnostic。
此操作不会修改第三方模型配置。

## 使用第三方 DeepSeek 模型

**支持。模型请求由 DSH 发出，不由 Paseo 插件发出。** 网关必须提供 DSH
支持的 API、工具调用与流式响应；仅有网页聊天服务不够。真实模型 ID、思考参数、
上下文上限、图片能力及费用由第三方决定。

在 daemon host 上：

1. 运行一次 `dsh --profile acp --help`，让官方 CLI 初始化 ACP profile。
2. 将 [示例](examples/third-party.cordis.patch.yml) 的配置合并到
   `~/.dsh/profiles/acp/cordis.patch.yml`，替换 endpoint 和 model ID。
   如果设置了 `DSH_HOME`，路径改为 `$DSH_HOME/profiles/acp/cordis.patch.yml`。
3. 把凭据存到 `~/.dsh/.credentials.yaml` 的 `refs` 中：

```yaml
version: 1
refs:
  DSH_GATEWAY_API_KEY: REPLACE_WITH_YOUR_SECRET
```

**保留已有 refs/其他凭据，不要直接覆盖文件，不要提交真实密钥。**
建议 `chmod 600 ~/.dsh/.credentials.yaml`。也可向 daemon/该 provider 显式提供同名
环境变量；仅在交互终端 `export` 不保证桌面版 daemon 能继承。

ACP 与 `web` 是不同 profile：只在 `dsh web` 的模型设置里保存路由，不代表
ACP 也配置好了。示例同时覆盖 `acp` 行的默认 provider/model；只添加网关路由
不会自动取代官方 ACP 的起始模型。

DSH 的 Cordis `config` 覆盖是**整项替换，不是深合并**。修改已有
`llm-pi-ai` 配置时必须保留其他路由及设置；不要重复添加同 id 的覆盖行。
ACP profile 默认关闭 HMR，修改后应在空闲时重新打开/重新加载 DSH agent 会话。
旧会话可能保留历史模型选择，在 Paseo 模型选择器中显式选择网关模型。

完成后：

```sh
paseo provider diagnostic dsh --json
```

再在 Paseo 中选择 `dsh` 和网关模型，发送一个最小请求验证实际鉴权、工具调用
及网络连通性。诊断 Ready/模型列表可见不代表推理请求已经验证。

### 可选的网关兼容参数

只在网关明确需要时，放到示例路由的 `compat` 中：

```yaml
compat:
  supportsDeveloperRole: false
```

如果网关支持 DeepSeek 格式的 `thinking` 开关，可在对应 model 中配置：

```yaml
compat:
  thinkingFormat: deepseek
reasoningEfforts:
  off:
  high: high
```

不要照抄不受支持的思考档位。第三方推理输出格式、图片支持和 DeepSeek 官方
API 扩展不一定相同。

## 能力边界

### 会话恢复与历史刷新

DSH 0.2.2-alpha.2 的官方 ACP 提供 `session/resume`，但没有
`session/load` 和历史回放。Paseo 0.15.3 的标准 ACP adapter 仅凭
`loadSession` 声明 `session.persistence`；直接注册会导致新会话能启动，
历史刷新或重新打开会话却报 `Provider does not support session.persistence`。

插件 1.1.0 同时处理这两个问题：

- 将 adapter 的 `session/load` 转成官方 `session/resume`，恢复**同一个 DSH
  session ID**；失败时直接报错，不偷偷新建空会话。
- 恢复成功后，从 DSH 本地 v4 日志回放用户消息、回复、思考、工具及结果、
  失败记录，再通知 Paseo 会话就绪。会读取全部 Zstandard 追加帧，不只读取首帧。
  `history: skip` 不回放。日志缺失、损坏或不支持的格式会明确报错，不返回空历史。
- 如果未来 DSH 原生支持 `session/load`，直接使用原生实现。

默认读取 `$DSH_HOME/sessions`，未设置 `DSH_HOME` 时读取 `~/.dsh/sessions`。
若在 DSH 配置了自定义 JSONL 存储 root，可通过该 provider 的环境变量
`DSH_ACP_SESSION_ROOT` 指向同一个目录。支持 `session.v4.jsonl.zstd` 和
`session.v4.jsonl`，不改写或删除这些文件。其他存储后端尚不支持历史回放。
历史非文本附件显示类型占位，原附件仍由 DSH 保存，不声称已恢复图片预览。

升级只需在 DSH 任务空闲时更新/重载插件，然后重新打开原会话，不需重启 daemon，
不需删除原会话，也不需更换模型配置。

### 语义检查清单（1.2.1）

以下按 DSH 0.2.2-alpha.2、Paseo 0.15.3 检查。修复留在插件中，不修改
Paseo/DSH 安装包或用户模型配置。

| 检查项 | 处理与验证 |
|---|---|
| 配置不能静默失效 | 非空 `systemPrompt`、`providerOptions`、通用 `settings`、预授权 `toolPolicy.preapproved`、`persist=false` 明确拒绝。系统指令请在 DSH 中配置，不降级成用户消息。MCP 支持 stdio/Streamable HTTP，拒绝 SSE 和相对可执行路径。 |
| 取消与并发输入 | 不声明 `prompt.steer`。并发 `auto` 输入由标准 adapter 先中断旧回合再提交新输入；显式 `steer` 拒绝，不冒充无中断插话。真实 DSH 已验证取消后继续发送；协议测试覆盖并发替换及每回合只结束一次。 |
| 权限审批 | 修复 DSH 审批只带调用 ID、adapter 却拒绝缺失 `rawInput` 的不匹配。使用已有调用信息补齐显示上下文；未知参数保留为空，不编造参数。单次允许/拒绝有协议测试；永久授权、改写工具输入、附加拒绝说明或一键拒绝并中断均明确拒绝。需要中断时另行停止 agent。未做桌面审批框的人工点击验证。 |
| 模型与思考档位 | 保留不透明的 provider/model 组合 ID。真实 DSH 已遍历模型与思考选项、拒绝无效模型，并验证恢复。协议测试同时检查失败后不提交无效配置。配置切换不能改写已准备好的模型步骤。 |
| 会话列表 | 遍历全部 `nextCursor`，保留 cwd、去重，循环 cursor 或后续页失败时报错，不返回伪装完整的部分列表；查询与 limit 在取齐后应用。真实 DSH 用每页 1 条的隔离存储验证跨页。 |
| 回合结束与错误 | `max_tokens`、`max_turn_requests`、`refusal` 添加可见警告，不能把 completed 视作“业务任务成功”。API 错误、进程退出有失败路径测试。DSH 将部分内部结束原因折叠成 `end_turn` 时，插件无法从 ACP 响应猜回原始原因。 |
| 历史、附件及能力声明 | 恢复后的未完成工具不再永久显示 running；保留失败/取消或未知结果。另修复 adapter 将没有错误详情的工具失败发成 `failed + error:null`、客户端无法解析的问题；显式说明详情缺失，不伪造错误原因。DSH 将工具结果放在 ACP `content`，Paseo adapter 只读取 `rawOutput`；1.2.1 将结果内容映射为实时 `output`，与恢复历史一致，失败详情同样可见，非文本结果只显示类型占位。附件类型占位已测试，不声称恢复媒体预览。撤销 `prompt.command` 声明，原生 slash command 请求明确拒绝，不再偷偷转成普通文本。 |

`title` 仍可作为 Paseo 本地元数据保存，不代表设置了 DSH 原生会话标题。
不声明原生 steering、持久权限策略、结构化输出、fork/rewind 或桌面专有模式。
官方 ACP 输出是已提交消息，不是 token 级实时流；插件不伪造缺失的增量。
模型是否可见图片取决于初始化时的路由能力和 DSH 对当前模型的再次检查；
插件不提升图片能力声明，也不承诺换模型后图片入口即时更新。

### 官方 ACP 的其他限制

遵循官方 ACP profile 的能力，不补齐桌面功能。当前已验证版本没有
Standard/PTC/Minimal/Creator preset 选择、原生 Plan 审批卡片等桌面交互。
支持的模型、权限请求和会话能力由 DSH/Paseo 握手决定。

## 开发

```sh
npm ci
npm run typecheck
npm test
paseo plugin reload dsh-acp
```

默认测试使用本地 ACP 协议 fixture，不调用模型。启用真实 DSH 集成测试：

```sh
DSH_TEST_COMMAND=/absolute/path/to/dsh \
DSH_TEST_MODEL='["your-route","your-model"]' npm test
```

使用满足 DSH 要求的 Node 运行测试。真实测试复用 ACP profile 的模型凭据，
以临时 overlay 将会话 root 隔离到测试目录；不修改用户 profile 或会话。
会发出最小模型请求（取消验证和一个短回复），可能产生少量费用；临时目录
在关闭进程后清理。权限、输出上限、进程故障等确定性分支由协议 fixture 覆盖。

黑白 SVG 来自官方 DSH Web frontend 的 favicon，仅将 fill 改为 `currentColor`。
保留了 DeepSeek 的 MIT 版权声明；商标归各自所有者所有。本项目不是 DeepSeek
或 Paseo 的官方插件。

参考：[官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、
[官方模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)、
[Paseo provider 插件](https://paseo.sh/docs/plugins/providers.md)。
