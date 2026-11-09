# DeepSeek Harness ACP for Paseo

把**官方 DSH ACP profile**接入 Paseo，加上随深浅主题变色的黑白 DeepSeek 图标。
provider ID 为 `dsh`。本插件只注册 Paseo 自带的 `runAcpProvider`，没有自定义
agent 循环、协议转换或模型代理，也不依赖 DSH Desktop。

```text
你的应用 / Paseo
  → Paseo daemon
  → 标准 ACP adapter
  → dsh --profile acp
  → DSH 配置的模型 API
```

## 在其他 host 安装

以下操作均在 **Paseo daemon 所在机器**执行，不是只在连接它的手机或电脑上执行。

要求：

- Paseo >= 0.15.3，且已启用插件。
- 官方 DSH CLI；已验证 DSH 0.2.2-alpha.2。
- 满足所选 DSH 版本要求的 Node。验证版本要求 Node >= 24.9.0。
- Git 私有仓库读取权限。当前仓库为私有，先配置 GitHub/Git 身份验证。

插件是受信任的非沙箱代码，会以 daemon 用户权限运行。安装前请检查源码。
本插件不会自动安装或更新 DSH，不会上传本机配置或凭据。

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

遵循官方 ACP profile 的能力，不补齐桌面功能。当前已验证版本没有
Standard/PTC/Minimal/Creator preset 选择、原生 Plan 审批卡片等桌面交互。
支持的模型、权限请求和会话能力由 DSH/Paseo 握手决定。

## 开发

```sh
npm ci
npm run typecheck
paseo plugin reload dsh-acp
```

黑白 SVG 来自官方 DSH Web frontend 的 favicon，仅将 fill 改为 `currentColor`。
保留了 DeepSeek 的 MIT 版权声明；商标归各自所有者所有。本项目不是 DeepSeek
或 Paseo 的官方插件。

参考：[官方 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、
[官方模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)、
[Paseo provider 插件](https://paseo.sh/docs/plugins/providers.md)。
