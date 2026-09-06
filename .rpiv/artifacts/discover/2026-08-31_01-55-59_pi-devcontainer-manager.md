---
date: 2026-08-31T01:55:59+0800
author: geebytes
commit: no-commit
branch: no-branch
repository: unknown
topic: "pi-devcontainer-manager"
tags: [intent, frd, pi-extension, devcontainer, docker]
status: ready
last_updated: 2026-08-31T01:55:59+0800
last_updated_by: geebytes
---

# FRD: pi-devcontainer-manager

## Summary
构建一个运行在宿主机上的 Pi 扩展，使单个 Pi 安装及单个可长期运行的 Pi 会话能够发现、选择、管理并在多个项目的 VS Code DevContainer 中执行工作，而无需在每个容器内安装 Pi。扩展应同时面向日常开发者、扩展维护者和受控环境运维者：提供明确的目标切换和生命周期操作、可配置可测试可发布的包结构，以及最小权限、凭据隔离和可审计的宿主机—容器执行边界。

当前仓库尚无实现；现有 `package.json` 仅为占位清单，技术讨论文档提供了设计素材。后续阶段应将该素材校验为与当前 Pi 扩展 API、Dev Containers CLI 和 Docker 行为相符的可实现技术方案。

## Problem & Intent
用户要求“重新学习梳理 `/data/work/ahaeureka/pi-devcontainer-manager/docs/pi-devconatiner-manager.md`，并为该项目制定完整详细的技术方案，最终输出至 `/data/work/ahaeureka/pi-devcontainer-manager/docs/`”。用户同时选择面向开发者、团队维护者和平台运维者，成功标准为“三者兼顾”，并要求“你直接梳理讨论内容然后输出技术方案即可”。

要解决的问题是：Pi 应属于宿主机而非某个项目或容器；开发者需要在一个会话内面向多个项目 DevContainer 发现、选择和运行命令，维护者需要一个可安装、配置、测试和发布的扩展，运维者需要受控的 Docker/Dev Container 调用、凭据不进入容器以及可追溯的执行记录。

## Goals
- 让宿主机上的单个 Pi 安装枚举并选择多个 VS Code DevContainer 作为可切换执行目标。
- 不在任何目标 DevContainer 中安装 Pi、Pi 配置、Pi session 或模型凭据。
- 为目标容器的发现、状态、启动、停止、重建、日志和命令执行提供清晰的 Pi 命令及 LLM 工具接口。
- 将普通 shell 命令在目标被选中时安全地路由至对应的 DevContainer；未选择目标时保持宿主机行为可预期。
- 提供可维护的 TypeScript/npm 扩展结构、配置模型、测试策略、CI 和发布方案。
- 对外部 CLI、Docker 权限、环境变量和敏感信息建立最小权限与审计边界。

## Non-Goals
- 不实现或替代 VS Code Dev Containers 扩展、Docker Engine 或 Dev Containers CLI 的镜像构建与容器编排能力。
- 不把 Pi 二进制、`~/.pi`、模型凭据或 Pi session 同步、安装或挂载进目标容器。
- MVP 不实现跨主机集中注册表、远程集群调度、多租户身份系统或完整容器监控平台。
- MVP 不承诺直接控制 VS Code UI；“打开/聚焦 VS Code 窗口”仅作为可选后续能力。

## Functional Requirements
1. 系统 SHALL 提供容器发现能力，使用 Docker 容器元数据识别带有 `devcontainer.local_folder` 标签的 DevContainer，并返回规范化工作区路径、容器 ID、名称、状态、配置文件标签与发现错误。
2. 系统 SHALL 支持按工作区路径或稳定显示名列出、选择、清除和查询当前活动 DevContainer；选择状态必须在会话范围内明确，切换后不得误向前一个目标执行命令。
3. 系统 SHALL 通过 `devcontainer exec --workspace-folder <workspace> -- <command>`（具体参数格式待研究确认）在活动工作区执行命令，并返回退出码、标准输出、标准错误、是否截断和目标工作区标识。
4. 系统 SHALL 支持通过 Dev Containers CLI 启动或复用指定工作区的容器，并在成功后重新发现和返回对应容器信息。
5. 系统 SHALL 支持停止、删除/关闭及重建指定工作区的容器；破坏性操作必须以显式工具或命令调用，不得由普通命令路由隐式触发。
6. 系统 SHALL 提供容器状态与日志查询；日志查询必须按输出字节数或行数限制返回内容。
7. 系统 SHALL 为上述能力注册机器可调用工具（最少 list、select、status、start、exec；stop/down、rebuild、logs 由方案确定）并定义严格的输入/输出 schema。
8. 系统 SHALL 提供面向用户的命令界面，用于显示容器列表、选择/取消选择目标、查看状态及触发显式生命周期操作。
9. 系统 SHALL 在活动目标存在时将已批准的 shell 执行路径路由到 DevContainer；没有活动目标、目标不再运行或路由配置关闭时，必须显示确定性的回退或错误行为，而非静默执行到错误环境。
10. 系统 SHALL 以参数数组/受控 spawn 调用外部二进制，避免将工作区路径或原始命令通过未转义的宿主机 shell 字符串拼接。
11. 系统 SHALL 检查 `docker`、`devcontainer` 和所需运行时的可用性，并将不存在、不可执行、权限不足、超时、CLI 退出失败和不可解析输出转化为可行动的诊断。
12. 系统 SHALL 支持全局和项目级扩展配置，至少覆盖 CLI 路径/后端选择、默认工作区或路由模式、命令/日志输出上限、超时、允许的工作区根目录和审计开关；合并优先级必须文档化。
13. 系统 SHALL 默认不向容器传递 Pi 凭据及与模型访问有关的环境变量，并允许对执行时环境变量采用显式 allowlist。
14. 系统 SHALL 为所有生命周期与执行操作生成结构化审计事件，至少记录时间、动作、目标工作区/容器、发起路径、结果/退出码和脱敏后的错误摘要。
15. 系统 SHALL 提供单元测试覆盖参数构造、Docker 标签解析、选择状态、配置合并、环境过滤、输出截断和错误映射。
16. 系统 SHALL 提供可选的集成/E2E 测试，验证两个以上独立工作区的发现、切换、`exec` 路由、失败恢复和容器复用。
17. 系统 SHALL 作为可被 Pi 安装和加载的 npm 包交付，包含正确的 Pi 扩展清单、构建产物、版本策略、安装文档和发布校验。

## Non-Functional Requirements
- **Performance**: 列表、状态和选择操作不应启动或重建容器；发现应使用一次受限的 Docker 查询并在普通本地 Docker 环境中快速返回。命令和日志必须有可配置超时与输出上限，避免 Pi 上下文被大输出耗尽。
- **Security**: 扩展在宿主机执行 Docker/Dev Containers CLI，因此必须将 Docker 等同于高权限边界对待；禁止不受控 shell 拼接、默认凭据透传和任意工作区外目标。破坏性动作、环境透传和允许范围须显式配置并记录审计。
- **UX / Accessibility**: 交互文本必须显示当前选定工作区、容器状态和下一步命令；错误消息应包含失败的依赖、目标路径和可执行修复建议。工具输出须是结构化、可读并有稳定字段的文本/JSON 表达。
- **Reliability**: 外部进程必须支持取消信号、超时、退出码检查和有界重试；只对幂等且可识别的暂态失败重试。操作完成后须重新发现或验证状态，防止陈旧选择状态。

## Constraints & Assumptions
- Pi、Docker、VS Code 和 Dev Containers CLI 均运行或可从宿主机访问；目标容器由 VS Code Dev Containers 语义创建或可由 `devcontainer up` 创建。
- 容器发现优先依赖 `devcontainer.local_folder` 与相关 config 标签；标签名称、路径规范化及跨平台行为必须由研究阶段以 CLI/规范证据确认。
- 当前仓库没有扩展源码、测试、构建、CI、配置或发布实现：`package.json:1-12` 仅声明 CommonJS 包和一个始终失败的测试脚本；设计文档中的代码片段不是可运行实现。
- 初始范围以 Docker + Linux/macOS 宿主机为基线；Podman、Windows/WSL 路径和 VS Code UI 自动化需要以能力探测与降级策略处理。
- 为避免与现有 Pi 内置/第三方 shell 工具冲突，是否覆盖 `bash`、包装命令路径或提供独立执行工具必须由下游研究和设计阶段确定。
- 最终“完整详细技术方案”应写入项目 `docs/`，但本发现阶段只产生下游流程输入 FRD，不修改产品源码。

## Acceptance Criteria
- [ ] 在一个包含至少两个已启动且标签为 `devcontainer.local_folder` 的测试容器的宿主机环境中，运行未来定义的容器列表命令/工具可返回两个不同工作区及其状态，且输出不启动或重建任何容器。
- [ ] 选择工作区 A 后运行 `pwd` 或等价测试命令，结果可证明命令在 A 的容器内执行；切换至工作区 B 后同一命令可证明在 B 内执行。
- [ ] 在未选择目标、目标容器已停止、`docker` 不可用、`devcontainer` 不可用和 Docker 权限被拒绝的场景中，相关命令返回非零/错误结构及可读修复建议，且不将命令静默执行到另一容器。
- [ ] 通过单元测试命令（由实现阶段确定，如 `npm test`）时，测试覆盖标签解析、参数数组构造、路径验证、选择切换、环境过滤、输出截断与错误映射，命令以退出码 0 结束。
- [ ] 集成测试启动两个最小 DevContainer 工作区后，可依次验证 `list → select A → exec → select B → exec → stop/down/rebuild` 中被纳入 MVP 的操作，并以退出码 0 结束。
- [ ] 对一次 `exec` 和一次破坏性生命周期操作，审计输出/文件含动作、目标、时间和结果，但不包含 API key、认证 token 或允许外的环境变量值。
- [ ] `npm pack --dry-run`（或等价发布校验）包含编译后的扩展入口和必要清单；在干净 Pi 环境中按文档安装后，扩展可被 Pi 加载并显示其命令/工具。
- [ ] 下游 `/skill:research`、`/skill:design` 和 `/skill:plan` 产物最终形成并写入 `docs/` 的完整技术方案，明确 API、模块、数据流、安全策略、测试矩阵、兼容性与交付里程碑。

## Recommended Approach
以宿主机 TypeScript Pi 扩展为核心，拆分为容器发现/CLI 适配器、会话级目标选择状态、工具与命令注册、受控执行路由、配置与策略、审计和测试层。使用 Dev Containers CLI 承担工作区语义与命令执行，使用 Docker 只承担标签化发现、状态和有限日志查询；所有外部进程采用参数化调用、能力检查、路径/环境策略和有界输出。

## Decisions

### 以单个宿主机 Pi 管理多个容器
**Question**: 该项目应只支持“一次宿主机安装、多个独立 Pi session”，还是支持“一个 Pi session 动态选择多个 DevContainer”？
**Recommended**: 支持一个宿主机 Pi 会话列出、选择并切换多个 DevContainer，同时仍允许多个独立 session 共存。
**Chosen**: 一个常驻 Pi session 可以面向多个动态可选的 DevContainer；Pi 归属 Host，DevContainer 是执行目标。
**Rationale**: 输入文档已明确区分两种模型并将后者定义为最终体验；用户要求直接梳理该讨论并形成完整方案。

### 三类用户共同作为目标角色
**Question**: 技术方案优先服务开发者、团队维护者还是平台运维者？
**Recommended**: 明确三者的不同目标，并以开发者工作流为主线、以可维护性和治理作为不可省略约束。
**Chosen**: 开发者、团队维护者和平台运维者三者兼顾。
**Rationale**: 用户选择“1,2,3”并明确“成功标准：三者兼顾”。

### Pi 与凭据保留在宿主机
**Question**: Pi 是否应安装、运行或将配置/凭据挂载到目标 DevContainer？
**Recommended**: 不安装、不挂载；仅从宿主机通过受控工具执行容器内命令。
**Chosen**: Pi、credentials、模型配置、extensions、sessions 和 skills 全部保留在 Host。
**Rationale**: 输入文档的目标架构明确将容器视为 execution targets，并将 Pi 相关状态留在宿主机。

### Dev Containers CLI 为主执行边界
**Question**: 容器内命令应优先使用裸 `docker exec` 还是 Dev Containers CLI？
**Recommended**: 使用 Dev Containers CLI 执行工作区命令，Docker 仅用于发现、状态与日志。
**Chosen**: 推荐 `devcontainer exec --workspace-folder`，而非裸 `docker exec`。
**Rationale**: 输入文档指出 CLI 具有 workspace、remote user 和环境等 Dev Container 语义；后续研究须验证准确 API 与版本兼容性。

### 标签化多容器发现
**Question**: 如何从宿主机识别可用的 VS Code DevContainer？
**Recommended**: 使用 Docker 容器标签（尤其 `devcontainer.local_folder`）关联容器和工作区，再以规范化路径为稳定键。
**Chosen**: 以 `docker ps` 过滤 DevContainer 标签并返回工作区映射。
**Rationale**: 输入文档给出该机制与命令示例；当前仓库无代码先例，需由研究阶段确认标签契约和边界条件。

### 安全默认值与可审计执行
**Question**: 宿主机高权限 Docker 调用和容器命令执行应采用何种安全模型？
**Recommended**: 参数化 CLI、工作区 allowlist、默认环境变量过滤、显式破坏性操作、超时/输出上限和结构化审计。
**Chosen**: 将最小权限、凭据隔离、受控路由和审计列入 MVP 必需约束。
**Rationale**: 用户要求兼顾平台运维者；输入文档也将 Docker 权限、密钥保护和容器隔离列为核心安全议题。

### 直接产出下游方案输入
**Question**: 是否继续进行逐项访谈以细化每个实现取舍？
**Recommended**: 按发现阶段的逐项访谈收集可逆技术选择。
**Chosen**: 直接梳理已有讨论并输出技术方案路径所需的需求基线。
**Rationale**: 用户明确要求“你直接梳理讨论内容然后输出技术方案即可”。

## Open Questions
- 当前 Pi 版本实际支持的扩展入口格式、工具注册 API、命令 API、配置 API 与可否安全覆盖/包装内置 `bash` 工具分别是什么？
- 当前 Dev Containers CLI 中 `exec`、`up`、`build`、停止/删除操作的精确参数、JSON 输出、退出码和版本支持矩阵是什么？文档中提及的 `stop`/`down` 是否为真实且稳定的 CLI 子命令？
- 如何可靠地处理多 Compose 服务、多容器工作区、重复/缺失标签、停止容器、旧版 VS Code 创建的容器和工作区路径软链接？
- 目标选择状态的正确生命周期是什么：仅内存、Pi session 级持久化还是可恢复的配置状态？不同方案的并发与安全影响是什么？
- 路由普通 shell 工具是否会意外将 Pi 自身构建、扩展管理或宿主机管理命令送进容器；独立 `devcontainer_exec` 与受控 bash 包装的风险/体验取舍如何？
- 支持 Docker、Podman、macOS、Linux、Windows/WSL2 的 MVP 范围、路径转换策略和能力降级如何界定？
- 审计日志应落在何处、保留多久、如何脱敏及如何避免把命令内容中的密钥写入日志？

## Suggested Follow-ups
- 评估与 `pi-dev-worktrees` 的共存、命令冲突和迁移说明；该扩展在输入文档中被作为“每个 cwd/session 一个容器”的相邻方案提出。
- 作为后续能力评估 VS Code 窗口打开/聚焦和容器日志监控，不将其绑定进 MVP。
- 补齐仓库基础设施：当前 `package.json:1-12` 没有 `pi.extensions`、`pi-package` keyword、依赖、构建脚本、测试框架或实际入口文件。

## References
- `/data/work/ahaeureka/pi-devcontainer-manager/docs/pi-devconatiner-manager.md`
- `package.json:1-12`
- 用户意图确认：目标“1,2,3”；成功标准“三者兼顾”；直接产出要求“你直接梳理讨论内容然后输出技术方案即可”。
