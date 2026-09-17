# pi-devcontainer-manager

[![CI](https://github.com/ahaeureka/pi-devcontainer-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ahaeureka/pi-devcontainer-manager/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-devcontainer-manager.svg)](https://www.npmjs.com/package/pi-devcontainer-manager)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](package.json)
[![pi-package](https://img.shields.io/badge/pi-package-blueviolet.svg)](https://pi.dev/packages)

**在宿主机（host）运行 Pi，把多个 DevContainer 作为受管控的命令执行目标来发现、选择与执行。**

Pi 始终运行在宿主机上。DevContainer 是**显式选择、经过策略校验**的命令执行目标——
Pi 的会话（session）、扩展、配置、模型凭据和 API key 永远不会被安装、复制、挂载或持久化到任何容器里。

> 本文是 [README.md](README.md) 的中文说明。详细文档（installation / configuration /
> security / compatibility / troubleshooting）目前只有英文版。

## 目录

- [为什么要这样做](#为什么要这样做)
- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用](#使用)
- [配置](#配置)
- [安全模型](#安全模型)
- [工作原理](#工作原理)
- [兼容性](#兼容性)
- [排错](#排错)
- [开发](#开发)
- [文档](#文档)
- [许可证](#许可证)

## 为什么要这样做

DevContainer 里装的是某个项目的工具链，而 Pi（以及它的配置、技能、模型凭据）属于宿主机。
所以真正有意义的问题不是"能不能把 Pi 跑进容器"，而是**"这条命令应该在哪个环境里执行，这个判断是否可审计"**。

本扩展用显式路由代替按命令名猜测：

- **`bash`、`!`/`!!` 和 `devcontainer_exec` 永远进容器。**
- **`devcontainer_host_exec` 和 `/devcontainer host-exec` 是唯一通用的宿主机 argv 入口**，
  需要策略授权且会被审计。`/devcontainer setup` 是另一个宿主机侧操作，只执行一条固定命令。
- **Pi 的文件工具永远在宿主机上执行。** DevContainer 的工作区是 bind mount，
  宿主机和容器看到的是同一批文件——把文件工具路由进容器只会白白多一次往返。
- **不会静默回退到宿主机。** 没有可用目标时，`container-required` 路由返回类型化错误，而不是偷偷在宿主机上执行。

扩展刻意**不**通过分析 shell 文本来判断该用哪个环境：shell 操作符、命令替换、复合命令会击穿任何
基于名称或前缀的规则。取而代之的是：在每一轮对话前把当前目标、宿主机↔容器路径映射和执行入口规则
写进 system prompt，让 agent 基于事实做选择。

## 功能

- **发现**：在配置的工作区根目录下扫描 `devcontainer.json`、`.devcontainer/devcontainer.json`
  和 `.devcontainer.json`，并与 Docker label 候选合并成一个工作区注册表。
  只有配置、从未启动过的项目也是一等公民。
- **选择**：同一时刻只选一个目标（`/devcontainer list`、`use`、`status`），
  选择会持久化到会话并在 `/reload` 后恢复。尚未选择时，如果 Pi 启动时所在的工作区自带
  DevContainer 配置，会被作为默认目标自动选中（显式 `/devcontainer use` 始终优先）。
- **执行**：所有命令入口共用同一个受管控服务——`devcontainer_exec` 工具、被接管的 Pi `bash`
  以及 `!`/`!!` 共享同一套目标校验、策略、环境过滤、审计、输出计量、取消和超时逻辑。
- **用事实引导 agent**：每轮对话前注入当前目标、`workspaceFolder`/`workspaceMount`
  的宿主机↔容器映射和执行入口规则；同时拒绝在宿主机上执行指向"仅容器内存在"路径的 argv，
  并在已选中容器时屏蔽内置 `powershell` 工具。
- **文件工具留在宿主机**：`read`/`write`/`edit`/`grep`/`find`/`ls` 始终操作宿主机文件系统。
- **生命周期管理**：`up`、`build`、`stop`、`remove`（stop/remove 需要策略授权**加上**一次性的
  交互确认）、以及有界 `logs`（同样受策略校验并被审计）。成功的 `up` 会重新解析当前选择，
  因此仅有配置的目标无需再手动 `use` 一次即可使用。
- **安装自己的前置依赖**：`/devcontainer setup` 在交互确认后于宿主机执行
  `npm install -g @devcontainers/cli`（见 [Security](docs/security.md#devcontainer-setup)）。
- **审计**：每个操作都会写入宿主机本地的 JSONL 文件，默认只记录 argv 的 SHA-256 指纹，
  保留窗口 90 天，`audit.enabled` 与 `audit.directory` 都会被真正生效。
- **绝不静默回退**：`container-required` 路由会返回类型化错误
  （`no-candidate` / `ambiguous-candidate` / `target-stopped` / `policy-denied`）。

只存在于容器内的路径（额外挂载、命名卷、容器内 clone）无法被 `read`/`ls`/`grep` 直接读取；
请通过 `devcontainer_exec` 在容器内执行 `cat`/`find` 来访问。

## 环境要求

| 要求 | 版本 / 说明 |
|---|---|
| Node.js | `>= 22.19.0`（由 package 的 `engines` 字段强制） |
| Pi | 宿主机上的编码 agent；本包会向它注册工具、命令和替换版的 `bash` 工具 |
| Docker | 仅支持 **Linux 或 macOS** 上的 Docker Engine / Docker Desktop |
| Dev Containers CLI | 固定并测试于 `@devcontainers/cli@0.88.0`；可在 `PATH` 上解析、通过 `devcontainerPath` 指定，或用 `/devcontainer setup` 安装 |

Windows、WSL2、Podman 和 rootless Docker 在 v1 中**不支持**，详见
[docs/compatibility.md](docs/compatibility.md)。

## 安装

Pi 扩展必须**注册到 Pi**。`npm install -g <package>` 只是把文件放到磁盘上，
并不会注册扩展，因此 Pi 不会加载它。

```bash
# 从 npm 安装
pi install npm:pi-devcontainer-manager

# 从 git 安装
pi install git:github.com/ahaeureka/pi-devcontainer-manager

# 从发布产物 tarball 安装
pi install ./pi-devcontainer-manager-1.0.0.tgz
```

`pi install` 会把包写入 `~/.pi/agent/settings.json`；加 `-l` 则写入项目级的
`.pi/settings.json`。后续可用 `pi list`、`pi update npm:pi-devcontainer-manager`、
`pi remove npm:pi-devcontainer-manager` 管理。

可选的全局配置位于 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json`，
详见[配置](#配置)与 [docs/configuration.md](docs/configuration.md)。

**在本仓库本地开发扩展？** 把本目录软链到 Pi 的自动发现扩展目录
（`${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions`）并执行 `npm run build`，
无需修改 `settings.json`，且在每个项目中都会加载。详见
[docs/installation.md](docs/installation.md#local-development-install-auto-discovery-symlink)。

## 快速开始

```bash
# 1. 在目标项目（或附近）启动 Pi
cd ~/code/project-a
pi

# 2. 在 Pi 中：
/devcontainer list     # 发现项目并显示注册表
/devcontainer use      # 交互选择目标，或直接指定：/devcontainer use ~/code/project-b
/devcontainer up       # 启动仅有配置的目标（成功后自动重新解析选择）

# 3. 在容器中执行——以下入口都走同一个受管控服务：
devcontainer_exec { "argv": ["npm", "test"] }
bash "pytest -q"
! cargo build          # `!` / `!!` 同样被路由
```

如果缺少 Dev Containers CLI，先执行一次 `/devcontainer setup`。

## 使用

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/devcontainer` | 交互式动词选择器（无 UI 时输出用法提示） |
| `/devcontainer list` | 发现并渲染注册表；同时修复失效的选择 |
| `/devcontainer status` | 同一个状态块（目标、注册表、路由、上限），并额外显示 `host runs:`——本会话宿主命令的**尝试次数**与**程序名** |
| `/devcontainer up [path]` | `devcontainer up --workspace-folder`；成功后重新解析选择 |
| `/devcontainer build [path]` | `devcontainer build` |
| `/devcontainer stop` | Docker stop——策略授权 + 一次性确认 |
| `/devcontainer remove` | Docker `rm -f`——策略授权 + 一次性确认 |
| `/devcontainer logs [--tail N]` | 有界 `docker logs`（默认 100 行）；受策略校验并被审计 |
| `/devcontainer use [workspace\|container-id]` | 选择目标并持久化到会话；同一工作区有多个运行中容器时会**弹出容器选择器**（显示 id/状态/镜像），也可直接用显式容器 id |
| 反向守卫 | 当配置把工作区挂到别处时，`devcontainer_exec` 会**拒绝** argv 中的**宿主**工作区路径，并在拒绝信息里给出应使用的容器路径 |
| `/devcontainer host-exec --argv <value> [...]` | 被审计的宿主机逃生口（**默认开启**；可用 `hostExecution.allow: false` 收紧）。每个 `--argv` 恰好一个参数、无 shell 与引号处理；值的终点是下一个 `--argv`，`--argv=<value>` 可传空参数 |
| `/devcontainer setup` | 全局安装/升级 Dev Containers CLI（需确认、被审计） |
| `/devcontainer off` | 清除目标并把本会话交还宿主机（休眠）；**该 opt-out 会被持久化**，因此 `/reload` 不会恢复目标，直到你重新选择 |

### 工具

| 工具 | 执行位置 | 参数 |
|---|---|---|
| `devcontainer_exec` | 容器 | `argv`（必填）、`cwd`、`timeoutSeconds`（必须为正数；省略则不设工具超时） |
| `devcontainer_status` | 只读 | — |
| `devcontainer_host_exec` | 宿主机（受策略管控、被审计） | `argv`（必填）、`timeoutSeconds`（必须为正数；省略则不设工具超时） |

内置 `bash` 工具会被**替换**为容器路由版本，注册时使用
`exposeSessionEnvironment: false`；`!`/`!!` 共用同一个 operations 实例，
因此两条入口不会产生行为漂移。

### 各入口的执行位置

| 入口 | 执行位置 |
|---|---|
| `devcontainer_exec`、被路由的 `bash`（`bash` 工具、`!`、`!!`） | 选中的容器 |
| `devcontainer_host_exec`、`/devcontainer host-exec` | 宿主机（显式、受策略管控） |
| `/devcontainer setup` | 宿主机（确认后执行一条固定的 `npm install -g`） |
| `/devcontainer stop` / `remove` / `logs`、`up` / `build` | 宿主机上的 Docker / Dev Containers CLI，作用于该容器 |
| `read` / `write` / `edit` / `grep` / `find` / `ls` | **始终为宿主机** |

### 发现与选择

- 识别 `devcontainer.json`、`.devcontainer/devcontainer.json`、`.devcontainer.json`；
  将配置发现结果与 Docker label 候选（`devcontainer.local_folder`）合并为
  以规范化工作区路径为键的注册表。
- 扫描有界：最大深度为 `discovery.maxDepth`（默认 `3`），不进入被排除目录或隐藏目录
  （`.devcontainer` 例外），并拒绝真实路径逃出允许根目录的目录。
- 已停止的容器同样可被发现和选择；对已停止目标执行命令会以 `target-stopped` 失败，
  直到你运行 `/devcontainer up`。
- 同一工作区存在**两个及以上运行中的容器**时标记为 `ambiguous`，
  绝不按 Docker 返回顺序猜测；请用 `/devcontainer use <container-id>` 明确指定。

## 配置

两个 JSON 文件会被合并成一份*生效配置*。所有键都是可选的，且**默认值偏保守**。

| 作用域 | 路径 | 是否可信 |
|---|---|---|
| 全局 | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-devcontainer-manager.json` | 始终应用 |
| 项目 | `<session-cwd>/.pi/pi-devcontainer-manager.json` | 仅当 Pi 认为该项目可信时应用 |

涉及策略的值是**单调合并**的：`allowedWorkspaceRoots` 与 `environmentAllowlist` 取交集，
各类上限取最小值，`audit.commandCapture` 取两者中更保守的一档，
`destructive.*` 必须**两个文件都为 `true`**；`hostExecution.allow` 是唯一**默认开启**的授权，
两个文件都可以用 `false` 收紧（全局的 `false` 不会被项目的 `true` 放宽）——
不可信的项目配置永远无法放大全局授权。

最小示例：

```json
{
  "allowedWorkspaceRoots": ["/home/me/code"],
  "environmentAllowlist": ["HOME", "LANG"],
  "audit": { "commandCapture": "fingerprint-only" },
  "destructive": { "allowStop": false, "allowRemove": false },
  "hostExecution": { "allow": true }
}
```

展示全部默认值的完整示例见
[examples/pi-devcontainer-manager.settings.json](examples/pi-devcontainer-manager.settings.json)。
每个键、默认值和合并规则都在 [docs/configuration.md](docs/configuration.md) 中记录。

## 安全模型

- **Pi 永不运行在容器内。** 会话、扩展、技能、配置、凭据和 API key 都不会被安装、复制、挂载或持久化到目标容器。
- **默认拒绝。** 工作区根目录、转发的环境变量名、破坏性操作和宿主机执行默认全部被拒，除非显式授权。
- **每次操作前重新校验。** 选择意图以稳定的工作区键 + 候选判别信息持久化；
  每个操作在执行前都会重新解析目标并冻结一份不可变的策略快照，
  因此并发的选择切换无法改变已在执行中的命令。
- **最小子进程环境。** 子进程使用构造出来的环境，而不是继承 Pi 的环境；
  `PI_*` 前缀和疑似密钥的环境变量名（`api_key`、`token`、`secret`、`password`、
  `credential`、`auth`、`bearer`）即使写进 `environmentAllowlist` 也会被排除。
- **固定 argv、`shell: false`、按进程组终止。** 两个输出流都受 `maxOutputBytes` 限制；
  超时/取消会杀掉整个进程组。
- **全程审计。** 每个操作都会向平台审计目录写入一条 JSONL 记录
  （目录权限 `0700`、文件 `0600`），默认只存 argv 的 SHA-256 指纹。被拒绝的尝试同样会被记录。

完整威胁模型、各类门禁与运维清单见 [docs/security.md](docs/security.md)。
如需上报漏洞，见 [SECURITY.md](SECURITY.md)。

## 工作原理

```text
session_start ─▶ 加载配置（全局 + 可信项目，单调合并）
              ─▶ 组装运行时（进程执行器、适配器、目标存储、审计）
              ─▶ 探测主机能力（结果仅作参考，不阻塞启动）
              ─▶ 注册工具 + 替换版 bash；恢复持久化的选择

每轮对话      ─▶ 把执行上下文追加到 system prompt
                 （当前目标、宿主机↔容器映射、各入口规则）

每个操作      ─▶ 冻结策略快照 ─▶ 绑定不可变上下文（重新解析目标）
              ─▶ 构造子进程环境 ─▶ 启动（固定 argv、shell:false、输出有界）
              ─▶ 写入一条审计记录 ─▶ 返回结构化结果
```

工作区注册表按需发现（首次 `/devcontainer` 命令或工具调用时），运行时在 `/reload` 时重新组装。
注册表、目标存储和执行服务位于 `src/`；`extensions/index.ts` 是唯一接触 Pi API 的文件。

## 兼容性

支持：**Linux 与 macOS 上的 Docker Engine / Docker Desktop**，使用固定版本的
`@devcontainers/cli@0.88.0`。v1 不支持：Windows 宿主机、WSL2 路径转换、Podman、
rootless Docker、非 Docker 后端以及 Compose 清理。

失败是类型化的而非静默的：会得到 `daemon-unavailable`、`authorization-denied`、
`devcontainer-cli-failure` 等明确错误，而不是降级行为。完整矩阵见
[docs/compatibility.md](docs/compatibility.md)。

## 排错

错误以 `[<kind>] <message>` 形式呈现，kind 取自 13 种类型，并尽可能附带修复建议。
常见场景——`target-stopped`、`no-candidate`、`ambiguous-candidate`、
`hostExecution` 被拒、审计文件缺失、仅容器内存在的路径——见
[docs/troubleshooting.md](docs/troubleshooting.md)。

## 开发

```bash
npm ci                 # 同时安装固定版本的 @devcontainers/cli@0.88.0
npm run typecheck      # 严格 NodeNext，仅类型检查
npm run test:unit      # 确定性的单元测试（依赖能力的套件会跳过）
npm test               # 单元 + 依赖能力的集成/e2e + 打包冒烟
npm run build          # 输出 dist/（含声明文件与 source map）
npm run pack:check     # 校验 tarball 白名单与 manifest 契约

node scripts/verify-package.mjs        # 整包质量门（typecheck、测试、构建、打包）
node scripts/smoke-pi-package.mjs      # 通过真实 Pi 运行时对打包产物做冒烟
```

集成与 e2e 套件会通过固定版本的 CLI 启动**真实** DevContainer；
Docker 或 CLI 不可用时它们会自行跳过。CI 在每次推送时运行确定性的单元与打包门禁，
并把需要真实 Docker 的套件放在单独的工作流中。

完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)：`src/` 保持不依赖 Pi，
因此单元测试无需安装 Pi；只有 `extensions/index.ts` 负责把 `src/` 接入 Pi。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/installation.md](docs/installation.md) | 安装、加载、验证、卸载 |
| [docs/configuration.md](docs/configuration.md) | 全部配置键、默认值与合并规则 |
| [docs/security.md](docs/security.md) | 威胁模型、门禁、审计、`/devcontainer setup` |
| [docs/compatibility.md](docs/compatibility.md) | v1 支持矩阵与失败模式 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 类型化错误与对应处理 |
| [docs/README.md](docs/README.md) | 文档索引 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 构建、测试与 PR 流程 |
| [SECURITY.md](SECURITY.md) | 漏洞上报方式 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 许可证

MIT，见 [LICENSE](LICENSE)。© pi-devcontainer-manager contributors。
变更记录见 [CHANGELOG.md](CHANGELOG.md)。
