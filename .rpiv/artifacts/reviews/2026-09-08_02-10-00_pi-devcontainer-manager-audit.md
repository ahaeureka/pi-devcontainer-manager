# DevContainer Manager — 全面审计报告

日期: 2026-09-08 · 基线: 工作树 (HEAD `43b2fb4` + 未提交 commandRouting 改动)
方法: 4 路并行 read-only codebase-analyzer(执行架构 / 配置生命周期 / 测试覆盖 / 对抗性安全)+ 直接源码核验
范围: 未修改任何文件。每条发现带 `file:line` 证据。

> ⚠️ **最重大前提**: 发布包执行 `dist/`,而当前 `dist/` 比 `src/` 旧 —— 源码的 `commandRouting`/`classifyCommand` 在已安装产物中**不存在**。所有"当前行为"结论需区分 `src`(未发布)vs `dist`(已发布)。

---

## 严重性汇总

| 严重性 | 数量 | 代表 |
|---|---|---|
| 🔴 High | 6 | 命令路由 shell 逃逸 / 符号链接越界 / stderr 无界 / 目标-工作区解绑 / up 不刷新 / dist 漂移 |
| 🟡 Medium | 9 | 重复容器静默折叠 / 环境只传 1 个 / 审计缺口 / 恢复无效 / 超时未封顶 / 配置校验不全 / 日志绕过 / 重定向不彻底 |
| 🔵 Low | 3 | 路由表非 allowlist / JSONC 解析 / audit.enabled 未执行 |
| 💭 设计风险 | 2 | 进程组未终止 / routeMode 未消费 |

---

## 🔴 HIGH

### H1 — 双路由"命令头分类 + 整串宿主执行"可被 shell 语法绕过
- **分类只看白名单派生出的命令头**: `src/command-router.ts:36-45,83-88`
- **执行把整条原串交给宿主 `/bin/sh -lc`**: `src/bash-router.ts:221-225`, `src/execution-service.ts:329-331`
- **场景**: `commandRouting.host` 含 `git` 且 `hostExecution.allow:true` 时,`git status; curl …|sh` 以 `git` 头判为 host,整条在宿主执行。前缀跳过(`sudo`/`env`/`cd x &&`)进一步放宽。
- **影响**: 绕过"哪些命令可走宿主"的意图;尽管未新增超出 `hostExecution.allow` 的权限级,但使 `host` 表失去命令级限制意义。
- **修复**: 宿主隐式路由只允许"单一、无 shell 操作符/替换/复合/管道"的简单命令;含 shell 语法的一律走容器或要求显式 `devcontainer_host_exec`。将 `commandRouting.host` 文档从"allowlist"改为"分支选择器",或彻底移除命令级宿主路由。

### H2 — 词法 workspace-root 校验可被符号链接越界
- 策略只做 `resolve()/relative()` 词法比较,不做 `realpath`: `src/policy.ts:43-49`;而发现层正确用 realpath 防止 symlink 越界: `src/runtime/host-discovery.ts:190-196`
- `resolveRealPath` 存在但策略未用: `src/workspace-path.ts:20-25`
- **场景**: 允许根 `/allowed` 下 `/allowed/link -> /outside/project`,`/devcontainer up /allowed/link` 通过词法校验,CLI 跟随链接读取外部配置。
- **修复**: 策略比较前对候选与根都做 realpath;spawn 前再验一次(防 symlink swap)。对不存在路径 fail closed。

### H3 — stderr 无输出上限 → 内存无界 + truncated 谎报
- Runner 只给 stdout 记账/截断: `src/runtime/process-runner.ts:56,83-97`;stderr 全量转发不计数不置 truncated: `:99`
- 调用方全量留存 stderr: devcontainer-adapter `:145-163`、host runner `extensions/index.ts:211-224,245-252`
- **影响**: `yes >&2`/大日志可耗尽扩展进程内存;`truncated:false` 误导审计与展示。违反 `docs/configuration.md:164-168` 与 `docs/security.md:46-56` 的输出有界承诺。
- **修复**: stdout+stderr 共享/分账统一字节预算,超限后继续 drain 但不保留、置 truncated;补 stderr-only 与混合溢出测试。

### H4 — 选中目标未与策略授权的工作区绑定(目标完整性)
- `ExecutionService.exec` 先授权 `request.workspace`,后 `bind()` 取选中容器 ID,但从不比对二者: `src/execution-service.ts:129-159`;immutable 绑定上下文含 workspaceKey: `src/target-store.ts:153-158`
- 路由 bash 的工作区取自调用方 cwd: `src/bash-router.ts:183-185`
- **场景**: 选中容器 A 后以另一允许工作区 B 作 cwd 调 `devcontainer_exec`,`devcontainer exec --workspace-folder B --container-id A` —— 授权的是 B,执行的是 A。
- **修复**: bind 后要求 canonical/realpath 的请求工作区 === `ctx.workspaceKey`,否则拒绝;或忽略 per-call cwd,始终用绑定目标工作区。

### H5 — 成功的 `/devcontainer up` 不刷新/不更新选中态
- `up` handler 只渲染返回 ID: `src/commands.ts:204-214`;`ExecutionService.up` 也不改 TargetStore: `src/execution-service.ts:201-220`
- auto-select 仅当状态恰为 `none`: `:141-143`;config-only 选择是 `selected-stopped`,`bind()` 拒绝之: `target-store.ts:136-143`
- **场景**: use config-only 项目 → up → exec 仍 `target-stopped`,须再手动 `/devcontainer use`。主生命周期流程断链。
- **修复**: up 成功后 refresh 注册表,以返回的容器 ID 匹配工作区并原子置 `selected-valid` + 持久化。

### H6 — 已发布 `dist/` 与 `src/` 行为漂移(发布完整性)
- 源码有 commandRouting/classifyCommand/mergeCommandRouting(`src/bash-router.ts:24-27,162-175`、`src/config.ts:149-166`、`src/command-router.ts`);当前 `dist/src/bash-router.js` 无 classifyCommand、`dist/extensions/index.js` 无 commandRouting 装配、`dist/src/command-router.js` 缺失
- **影响**: 本 checkout 直接运行/安装走旧 dist 行为;基于 src 的安全结论对已发布产物不成立。
- **修复**: 发布前强制 `npm run build` + 产物指纹校验(把 dist 与 src 行为差异纳入 verify 门禁)。

---

## 🟡 MEDIUM

### M1 — 同工作区多容器被静默折叠为第一个 Docker 结果
- discovery 每工作区只留 `dockerList[0]`: `src/runtime/host-discovery.ts:254-284,288-299`;`/devcontainer use` 无从选择: `commands.ts:181-200`
- `selected-ambiguous` 状态与 `bind()` fail-closed 存在但从无生产路径产生: `target-store.ts:104-137`
- 测试把"first wins"固化为行为: `tests/unit/host-discovery.test.ts:380-397`
- **修复**: 保留候选多重性,`use` 呈现全候选;多个 running 视为 ambiguous;绝不用 docker 顺序决定目标。

### M2 — 多变量远程环境只传第一个,其余静默丢弃
- 策略层构造全量允许记录: `src/policy.ts:51-66`;service 全量传 `remoteEnv`: `execution-service.ts:145-158`;adapter 只发 `entries[0]`: `devcontainer-adapter.ts:137-142`(0.88.0 `--remote-env` 单值 last-wins)
- 文档称 allowlist 变量会被转发: `docs/configuration.md:149-156`;示例允许多个(HOME/LANG)
- **修复**: 要么文档明示"仅首变量生效",要么对多变量使用 CLI 支持的方式(如写临时 env 文件/`--remote-env` 前扩展),禁止静默丢弃。

### M3 — 审计覆盖不全:"every operation" 言过其实
- `/devcontainer logs` 完全绕过 ExecutionService: `commands.ts:235-249` → `dockerLifecycle.logs`(`extensions/index.ts:263-268`)无 policy/audit
- `authorize()` 拒绝即抛,无审计记录: `execution-service.ts:268-280`(host runner 拒绝有审计:`extensions/index.ts:198-211`)
- `up`/`build`/lifecycle 只在成功后才 audit,失败路径无记录: `:201-264`
- README "Audits every operation" 与 `docs/security.md:123-127` 不符
- **修复**: 给 `logs` 加 policy+audit;denied 与 adapter 失败在抛出前写最小审计(含 fingerprint,绝不记录被拒 env 值)。

### M4 — reload 后"恢复"的选择永远是 selected-missing,list 不做文档承诺的重解析
- session_start 无条件写 `selected-missing` 且忽略 `recovered.candidateId`: `extensions/index.ts:461-468`
- `list`/`status` 只拉注册表渲染,不调 applySelection/refresh: `commands.ts:165-175`;`beginRefresh/endRefresh` 无生产调用: `target-store.ts:95-105`
- README 承诺"restores after /reload": `README.md:15-18`
- **修复**: 实现统一 reconcile(session restore/list/lifecycle 完成/pre-exec 共用):beginRefresh → 发现 → 按持久化 workspace+candidate 匹配 → selected-valid/stopped/ambiguous/missing → endRefresh。

### M5 — host 执行不受 `maxTimeoutSeconds` 约束,可无超时运行
- host runner 仅在调用方给时设 timeout,无默认、不封顶: `extensions/index.ts:218-226`;host tool 接受任意 `timeoutSeconds`: `tools.ts:42-44,186-190`
- 容器侧有 adapter 级 timeout(来自 maxTimeoutSeconds): `extensions/index.ts:103-110`
- **修复**: host runner 集中封顶:缺省填 `maxTimeoutSeconds*1000`、请求值 clamp 到上限;routed bash 与 host_exec 共用。

### M6 — 配置校验缺嵌套数组/类型检查
- 不校验 `discovery.excludedDirectories`、`dockerPath`、`audit.enabled`、`destructive.*`、`hostExecution.allow` 类型: `src/config.ts:181-215`
- `mergeDiscovery` 假定 `.filter()`: `:98-110`;字符串进 `intersect()` 直接抛非命名错误: `:168-170`
- **修复**: merge 前做完整 shape 校验,逐路径报错;建议 schema 校验器。

### M7 — `/devcontainer logs` 绕过共享执行/审计(与 M3 同源,单列)
- 无 workspace policy 检查、无 audit;基于过期 selection 快照重建合成 DockerContainer 而非新鲜 inspect
- 无 `tests/unit/docker-lifecycle.test.ts`
- **修复**: 并入 ExecutionService:授权选中 workspace → bind/重验 ID → adapter → audit(含 error/truncation)。

### M8 — 打包 Pi smoke 未可靠证明"装入的是打包扩展";发布不强等 runtime smoke
- `smoke-pi-package.mjs` 恢复 env 后才做真 Pi probe,未指向 scratch 包: `scripts/smoke-pi-package.mjs:100-127`;`--no-model` 分支读 checkout 的 dist 而非 tarball: `:139-149`
- release.yml: publish 只依赖 verify,`smoke-pi`(secret-gated)非 publish 前置: `.github/workflows/release.yml:62-66,101-120`
- **修复**: probe 用打包 tarball 安装后的真实扩展加载;把 load 成功设为 publish 门禁。

### M9 — "redacted-text" 命令捕获可残留凭据
- 重定向器只匹配窄赋值形式: `src/policy.ts:78-79`;`curl -H 'Authorization: Bearer eyJ…'` 只红 token 前缀后空格内容残留;不覆盖 `--password value`、JSON body、URL 凭据、多行
- routed bash 记录的是原始 `/bin/sh -lc <text>`: 暴露面更大
- **修复**: 默认 fingerprint-only;如需明文,做参数感知红act(完整 header 值、secret 选项/值对、URL 语法、JSON 字段、多行),不宣称正则即可安全保留任意 shell 文本。

---

## 🔵 LOW / 💭 设计风险

- **L1** `commandRouting.host` 应按"分支选择器"而非 allowlist 建模/文档(见 H1 后果)。
- **L2** `readWorkspaceMapping` 用 `JSON.parse`,JSONC(带注释)配置返回无映射 → 展示回退为宿主路径: `extensions/index.ts:395-400`(仅影响展示)。
- **L3** `audit.enabled`/`audit.directory` 被接受但 runtime 不消费(`audit.enabled:false` 仍写默认目录): `extensions/index.ts:449-452`;文档已披露但仍易误用。修复:未实现前拒绝/移除字段,或接线。
- **D1** 超时/取消只 SIGKILL 直接子进程、无进程组: `src/runtime/process-runner.ts:101-122` → 派生/后台子进程可能存活。设计风险非当前缺陷。
- **D2** `routeMode` 被编译/展示但无任何运行消费路径(`container-preferred`/`host-only` 未接线): `src/config.ts:85`,`commands.ts:114`。文档标为保留,属兼容风险。
- **D3** `/devcontainer up`/`build`/`lifecycle` adapter 失败不写审计(与 M3 同族,在此列)。

---

## 正面对照(已确认有效的控制)

- 容器子环境构建拒绝非 allowlist / `PI_*` / 秘密模式名: `src/policy.ts:52-70`;routed bash 预过滤继承环境: `bash-router.ts:251-261`
- bash 替换 `exposeSessionEnvironment:false`: `extensions/index.ts:529-532`
- 宿主 spawn `shell:false` 边界: `process-runner.ts:43-49`;shell 解释只在路由显式包装处
- 目标绑定冻结 candidate ID,后续选择切换不能重定向在途命令: `target-store.ts:153-158`
- stop/remove 需 policy + 匹配 action/ID 的确认对象: `execution-service.ts:245-264`、`docker-lifecycle.ts:118-162`
- JSONL 审计文件/目录 0700/0600: `audit.ts:19-34`
- 项目级 host 例外与全局相交(trusted 项目不能扩 host 面): `config.ts:135-151`

---

## 与用户架构关切("是否所有命令都走 hook 再路由")的衔接

审计确认当前执行架构是**"hook(单 BashOperations 统一 bash/`!`)+ 两落地点(容器 service / 显式 host tool)"**,而非"单 hook 内再路由"。审计 H1 正是后一思路(把 host 路由塞进同一 operations)会引入的缺陷面。**建议结论**:
- 维持"bash/`!`/`!!` 单一 operations 入口(容器默认)"是正确 hook 用法;不要再把"host 命令选择器"放进该入口 —— 任何基于命令文本的隐式宿主路由都逃不过 H1 类 shell 解析问题。
- 宿主执行保持为**显式** `devcontainer_host_exec`(用户/LLM 明示),而非按命令前缀隐式放行。
- 若确实需要"任务语义"分流,用提示(路径映射注入 + 工具 guideline)驱动 LLM 选显式工具,而非规则/头分类 —— 与 H1/M1 的修复方向一致。
- hook 层(createLocalBashOperations / spawnHook)不适用于已越过 operations 的容器路径;宿主后端如需官方执行内核可 delegate,但 policy/audit 必须外包。

---

## 建议修复优先级路线

1. **P0(安全,合入前必须)**: 丢弃/重设计 commandRouting 宿主路由(H1);workspace-root realpath 化(H2);stdout+stderr 联合预算(H3);bind 后工作区一致性校验(H4)。
2. **P1(正确性)**: up 后刷新选中态(H5/M4);多容器 ambiguity(M1);多 env 变量语义(M2);logs 入 service + 审计(M3/M7);host timeout 封顶(M5)。
3. **P2(治理/工程)**: 配置全量校验(M6);audit denied/失败全覆盖(M3);redact 参数化(M9);发布门禁校验 dist↔src(H6/M8)。
4. **P3(文档)**: 修正 README/security/configuration 关于 restore/audit/bounded-output/command-list 的过度承诺。

> 注:以上行号基于本次审计读取的工作树;未提交的 commandRouting 改动若最终被丢弃(H1 决定),H1/M 相关项随删除自然消失,H2-H6 等与 commandRouting 无关的项仍然成立。
