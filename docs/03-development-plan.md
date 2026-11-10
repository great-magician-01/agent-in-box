# Agent-in-Box 开发计划

> 文档状态：实施计划草案 v0.1  
> 使用方式：按阶段顺序开发。每个阶段先完成验收条件，再进入下一阶段；技术验证未通过时先调整对应选型，不在不稳定的底座上继续堆叠产品功能。

## 0. 当前进度（2026-11-10）

- **阶段 1.1 完成**：单仓库 Monorepo、pnpm Workspace、TypeScript/Go 工具链、统一构建与检查。
- **阶段 1.2 完成（初版）**：核心协议、分页/错误/幂等契约、任务与 Worker 状态机、VM 多对多绑定规则、Computer Use 动作、Guest RPC、VmProvider、Worker Engine 和 Bot Connector 接口均有类型与契约测试。
- **阶段 1.3 完成**：SQLite WAL、外键、内置 Migration Runner、在线备份；项目/VM/会话/任务/Worker/Lease/Outbox/事件去重仓储；幂等任务创建、事务化状态迁移、任务事件与 Outbox 同事务写入；Per-VM Lease 与过期替换。33 个 Vitest 测试和 Go 测试通过。
- **阶段 0.1 完成**：`tests/phase0/` 已包含测试矩阵、15 项验收任务、结果 Schema、cloud-init 模板和 Windows QEMU/WHPX Runbook。
- **阶段 0.2 核心链路通过**：H1（Windows 11 家庭版 26200）已用 MSYS2 QEMU 11.1.3 + WHPX 完成 Ubuntu 24.04 G1 的覆盖盘创建、启动（冷启动 14.1 秒）、cloud-init、SSH、QMP 优雅关机和 qcow2 快照恢复；G2 XFCE 桌面已完成 1280x800 截图、1024x768 分辨率切换、绝对鼠标和 ASCII 键盘输入验证。结果见 `tests/phase0/results/`。
- **Go 原型已落地**：`internal/qmp` 提供受控 QMP 客户端；`internal/vmprovider` 提供 QEMU 覆盖盘/启动/停止/状态对账/快照原型和 Host Inspect。Windows amd64 `vm-supervisor.exe /api/v1/host` 已在本机返回 `ready=true`、`recommendedProvider=qemu-whpx`。
- **阶段 0 尚未完成**：Hyper-V 备选路径、WHPX 性能与长稳、Supervisor 崩溃接管、认证 Guest Agent、中文输入、Pi Computer Use、Model Broker 和真实机器人长连接仍需验证。默认 Provider 尚未冻结；WHPX 下暂用 `-cpu qemu64`，`-cpu max` 的 SMP 启动卡住问题待查。
- **下一步**：实现认证 Guest Agent 的截图/输入并接入 Per-VM Lease 前置校验，补 Supervisor 崩溃接管与 WHPX 性能验证，再验证 Pi Computer Use；不提前进入大规模 UI 开发。

1. 先验证 Hypervisor、镜像、Pi Computer Use 和模型代理等高风险链路，再大规模开发 UI。
2. 每个阶段形成可运行、可测试的纵向能力，避免一次性生成大量空模块。
3. **Windows Host 运行 Linux Guest 是 P0 必须支持能力**；先完成 Linux Guest 全链路和完整验证，再开始 Windows Guest 的可行性验证与对应开发。Windows Guest 仍属于本期交付，不移到下一期；其镜像下载允许提前进行。
4. 所有状态从第一阶段就落库，不以 Router 记忆、进程内变量或前端状态代替。
5. VM 数量不做固定硬限制；开发资源调度时只控制自动启动和排队。
6. 项目与 VM 从第一版 Schema 起就是多对多，避免后续迁移一对一模型。
7. 同 VM 默认单执行 Lease，所有 AI 和人工桌面输入都经过它。
8. Pi 优先通过 SDK/RPC 集成，不先 Fork；Computer Use 兼容性不足时增加独立 Engine。
9. 机器人使用本地长连接，不把云端中继作为默认依赖。
10. 每个阶段同时补测试、日志、取消和故障恢复，而不是最后统一补。

## 2. 里程碑总览

| 里程碑 | 对应阶段 | 可交付结果 |
| --- | --- | --- |
| M0：Linux 技术可行性 | 阶段 0 | Windows Host 运行 Linux VM 及其他高风险链路有真实验证结果和选型结论 |
| M1：本地 Linux VM 基础产品 | 阶段 1～4 | 用户能安装、选存储、下载 Linux VM、启动、查看并人工操作 |
| M2：单项目 Linux AI Worker | 阶段 5～7 | 一个项目中的 Worker 能通过 Computer Use 完成受控 Linux 任务 |
| M3：多项目 Router 工作平台 | 阶段 8～9 | 多项目、多 Linux VM 绑定、任务看板、Worker 复用/归档和资源调度可用 |
| M4：多端 Linux 版本 | 阶段 10～11 | Electron、本地 Web、飞书和 QQ 使用同一套本地 Linux 任务系统 |
| M5：Linux 全链路验证构建 | 阶段 12 | Linux 安全、故障、安装、升级和真实任务全部验收，解锁 Windows VM 开发 |
| M6：本期完整版本 | 阶段 13 | Windows VM 在本期后段完成验证、开发和联合回归，Linux 能力无回归 |

---

## 阶段 0：Linux 高风险技术验证

### 0.1 建立测试矩阵和验收任务集

**工作项**

- 确定首批 Windows Host 版本、硬件虚拟化配置和资源档位；
- 确定首批 Linux Guest 版本；
- 准备普通办公、浏览器、文件、中文输入、开发和长任务样例；
- 为每个任务定义机器可检查或人工可复核的完成条件；
- 建立结果记录格式，区分成功、失败、人工接管和环境异常。

**验收**

- 测试矩阵和任务集已保存到测试目录；
- 后续所有 Linux 技术验证使用同一批任务，能比较不同 Provider 和 Engine；
- 不以“模型说完成”为成功标准。

### 0.2 验证 Windows Host 运行 Linux Guest 的 VmProvider

**工作项**

- 分别验证 QEMU/WHPX 与 Hyper-V 的可用环境；
- 测试 Linux Guest 的创建、启动、停止、重启和快照；
- 测试显示、网络、输入、性能和宿主资源压力；
- 测试应用崩溃后能否发现并接管已有 VM；
- 记录系统功能启用、管理员权限和重启要求。

**验收**

- 得到默认 Provider 与备选 Provider 的明确结论；
- 至少一条路径可在干净 Windows Host 上稳定运行 Linux Guest，这是必须通过的 P0 验收；
- 不能支持的系统有明确检测和提示，不发生无响应或误报 Ready。

### 0.3 验证 Linux 镜像自动供给

**工作项**

- 从官方或测试镜像源下载 Linux 镜像；
- 实现分块、续传、校验和原子启用的验证原型；
- 用 Packer/cloud-init 构建含 Guest Agent 占位的 Linux Golden Image；
- 验证非系统盘存储路径；
- 可同步验证 Windows 镜像的 Manifest、下载、校验和存储兼容性，但不进行 Windows VM 创建或可行性验证。

**验收**

- 下载中断后可以继续，坏文件不会启动；
- Linux VM 能在用户选择的目录创建；
- 提前下载 Windows 镜像时，界面和日志不得将其标记为已验证或可用 VM。

### 0.4 验证 Pi Worker 与 Computer Use

**工作项**

- 在 VM 内启动 Pi RPC；
- 注册最小截图、点击、输入和等待工具；
- 验证图片回传、工具循环、事件流、Steer、Follow-up、Abort 和 Session Resume；
- 验证目标模型的原生 Computer Use 能力是否可通过 Pi 完整使用；
- 验证长会话压缩后继续任务；
- 用同一任务集对比专用 Computer Use 路径；
- 验证宿主机没有向 Worker 暴露 Shell 或 Supervisor 接口。

**验收**

- 形成“Pi 直接承担 CUA”或“Pi General Worker + 专用 CUA Engine”的选型结论；
- 截图、输入和取消形成完整闭环；
- 取消后没有残留的后台动作；
- 会话恢复失败时能明确降级，不伪造无损恢复。

### 0.5 验证 Model Broker 和机器人长连接

**工作项**

- 验证 VM 内 Worker 经本地代理访问模型时的流式文本、工具、图片、取消和错误；
- 确认长期 API Key 不需要放入 VM；
- 使用测试飞书应用验证 WebSocket 收发；
- 使用目标 QQ 机器人类型验证 WebSocket、Intents 和消息回复；
- 验证断线重连、重复事件和应用重启。

**验收**

- 模型代理不破坏 Computer Use 所需协议；
- 飞书与 QQ 的目标接入形态均无需公网回调，或明确记录能力限制；
- 重复事件不会创建重复任务。

**阶段出口**

- 阶段 0 的技术决策已更新到《技术设计文档》第 18 节；
- 未通过项有替代路径，不直接进入大规模产品开发。

---

## 阶段 1：工程骨架、协议和本地持久化

### 1.1 创建单仓库 Monorepo、pnpm Workspace 和基础工具链

**工作项**

- 创建单一根仓库，不使用业务子仓库或 Git Submodule；
- 创建 `apps/web`、`apps/desktop`、`services/control-plane`；
- 创建 `packages/protocol`、`packages/domain`、`packages/config`；
- 配置根 `package.json`、`pnpm-workspace.yaml`、`packageManager` 和唯一 `pnpm-lock.yaml`；
- 内部依赖统一使用 `workspace:*`，根包和内部包默认私有；
- 配置 TypeScript、Node/pnpm 版本、Lint、格式化、测试和原生构建脚本 Allowlist；
- 为 Go Supervisor/Guest Agent 建立 Go Modules，需要时增加 `go.work`；
- 使用根 pnpm 脚本统一编排 TypeScript 与 Go 的开发、构建和测试；
- 配置统一结构化日志和错误代码；
- 建立开发环境启动脚本和 CI 基础检查；
- 本阶段不引入 Nx/Turborepo，也不拆分无真实复用需求的内部小包。

**验收**

- 干净环境可按文档使用固定 Node/pnpm 版本安装依赖并运行测试；
- 仓库不存在 npm/Yarn 混用锁文件；
- Web、Control Plane 和 Go 模块能分别构建，根命令能统一执行；
- Workspace Filter 能独立构建和测试目标包；
- 内部依赖使用 `workspace:*`，没有依赖开发机全局包或手工 Link；
- 原生模块在目标 Windows Host 完成安装和加载测试；
- 协议包可以被 TypeScript 与 Go 代码生成或校验流程使用。

### 1.2 定义核心协议和 Schema

**工作项**

- 定义 Image、VMInstance、Project、ProjectVmBinding、Conversation、Worker、Task、TaskEvent；
- 定义 Power State、Guest Health、Task State、Worker State；
- 定义 API 错误、事件版本、幂等键和分页格式；
- 定义 Computer Use Action 和 Guest RPC 的初版 Schema；
- 定义 Provider、Worker Engine 和 Bot Connector 接口。

**验收**

- Schema 包含项目与 VM 多对多，不存在固定一对一字段假设；
- Task 显式包含目标 `vm_id`；
- 所有状态迁移和接口有版本化文档及基础契约测试。

### 1.3 实现 SQLite 基础层

**工作项**

- 建立 Migration、事务、WAL、备份和恢复工具；
- 实现 Task、Worker、VM 等基础 Repository；
- 实现 Outbox 和本地持久任务队列表；
- 实现 Lease 数据结构和事件去重表；
- 测试控制进程异常退出后的数据库完整性。

**验收**

- 服务重启后数据不丢失；
- 同一幂等键不会创建重复任务；
- Outbox 不出现“状态已提交但事件永久丢失”的常规故障；
- 数据库备份可在新目录恢复。

---

## 阶段 2：Electron、本地服务和自定义存储

### 2.1 建立无特权 Electron 壳

**工作项**

- Electron 加载共用 React 前端；
- 建立 Renderer、Main 和 Control Plane 的最小权限 IPC；
- 实现本地服务启动、健康检查和异常提示；
- 实现关闭窗口与退出后台服务的不同行为；
- 配置基础日志和崩溃诊断；
- 验证 electron-builder 对 pnpm Workspace 链接结构的打包，生成最小 Windows 安装包并运行 Smoke Test。

**验收**

- Renderer 无 Node 任意执行和 Supervisor 直接访问能力；
- 关闭窗口后按用户选择保持或停止后台服务；
- Control Plane 异常时 UI 显示明确状态，不无限等待；
- 打包后的 Electron、Control Plane、原生模块和本地 API 在干净 Windows 环境可运行，不依赖开发机 pnpm Store。

### 2.2 实现首次启动向导

**工作项**

- 检查 CPU 虚拟化、操作系统、内存和磁盘；
- 选择数据根目录；
- 设置 Host Reserve 和自动启动策略；
- 配置模型凭据并保存到 OS 安全存储；
- 创建本地管理员/用户身份和基础安全设置。

**验收**

- 第一次下载前必须能选择存储位置；
- 非系统盘、包含空格和 Unicode 的路径通过测试；
- 长期密钥不以明文写入普通配置或日志。

### 2.3 实现 Storage Manager

**工作项**

- 统一管理镜像、下载、VM、快照、产物和归档路径；
- 实现空间与权限检查；
- 实现路径变更事务和存储锁；
- 实现基础迁移流程；
- 增加缓存与用户数据分类。

**验收**

- 业务模块无散落的默认系统盘路径；
- 迁移失败仍可使用旧路径；
- 迁移后 VM 和快照链通过完整性检查；
- 清理下载缓存不会删除 VM 或项目数据。

---

## 阶段 3：镜像和 VM 生命周期

### 3.1 实现 Image Service

**工作项**

- 实现 Manifest、来源配置、下载、续传、校验和版本管理；
- 实现并发下载去重和取消；
- 实现下载进度事件和失败诊断；
- 接入阶段 0 验证的 Linux 镜像构建产物；
- Windows 镜像可提前复用统一下载器完成 Manifest、下载、续传、校验和存储，但此阶段不创建或验证 Windows VM。

**验收**

- 同一镜像不会重复下载；
- 应用重启后可恢复下载；
- 只有校验通过的镜像进入 Available；
- 镜像更新不覆盖使用中版本。

### 3.2 实现 VM Supervisor 和首个 VmProvider

**工作项**

- 实现 Host Inspect；
- 实现 VM Create、Start、Stop、Suspend、Resume、State 和 Console；
- 实现受 ACL 保护的本地 IPC；
- 实现 QEMU 进程发现和崩溃恢复；
- 实现结构化错误和超时；
- 删除接口默认不开放给自动任务。

**验收**

- Supervisor 重启后能重新识别现有 VM；
- AI/Router 无 Supervisor 通用工具；
- Start/Stop 重复请求具有幂等结果；
- VM 进程状态与 Guest Health 分开显示。

### 3.3 打通 Linux Guest

**工作项**

- 创建带独立覆盖盘的 Linux VM；
- 配置 VirtIO、网络、显示和控制台；
- 启动后执行 Guest 健康检查；
- 保存 VM 配置和资源档位；
- 验证停止后重开以及宿主机重启后的恢复；
- Windows Guest 只保留协议扩展点，本阶段不开展可行性或对应功能开发。

**验收**

- Windows Host 运行 Linux Guest 的 P0 路径具有可重复的创建与启动流程；
- 停止的 VM 保留磁盘、配置和绑定；
- 用户可以创建多台 Linux VM，没有固定数量硬限制；
- 异常 VM 不被误标为 Ready。

### 3.4 实现 VM 管理 UI

**工作项**

- 展示名称、系统、状态、资源、路径、绑定项目和当前任务；
- 提供下载、创建、启动、停止、休眠和控制台入口；
- 显示资源建议和磁盘占用；
- 提供存储位置迁移入口。

**验收**

- 用户能理解“已拥有”和“正在运行”的区别；
- 多 VM 停止和运行状态显示准确；
- 危险操作有明确影响说明。

---

## 阶段 4：Guest Agent、画面与人工控制

### 4.1 实现 Guest Agent 基础服务

**工作项**

- 实现认证管理通道、心跳和能力查询；
- 实现截图、桌面状态、分辨率和 DPI 信息；
- 实现鼠标、键盘、Unicode、滚动和等待；
- 实现动作 ID、超时、结果和错误；
- 实现 Guest Agent 更新和版本握手。

**验收**

- Linux 目标桌面完成输入与截图测试，Windows 桌面测试在本期后段单独验收；
- 未认证请求不能执行输入；
- 分辨率和 DPI 改变后坐标仍正确；
- Guest Agent 崩溃不会扩大为宿主机操作。

### 4.2 接入 noVNC 控制台

**工作项**

- 实现本地 WebSocket 代理和访问鉴权；
- 在 Web/Electron 中显示实时画面；
- 支持用户鼠标键盘接管；
- 实现控制台连接状态与重连。

**验收**

- 本地浏览器和 Electron 均可操作控制台；
- 控制台不暴露为无认证公网服务；
- VM 重启后控制台能恢复或明确提示重新连接。

### 4.3 实现统一 Execution Lease

**工作项**

- 实现 Per-VM Lease、心跳和过期处理；
- 将 Guest Input 与 noVNC Input 接入 Lease 校验；
- 实现 AI、人工和空闲三种控制状态；
- 实现人工接管时 AI 暂停。

**验收**

- 两个请求不能同时向同一 VM 注入桌面输入；
- 人工接管后 AI 动作被拒绝或暂停；
- Lease 过期后不会盲目重放旧动作。

---

## 阶段 5：项目、绑定和任务内核

### 5.1 实现 Project 与 ProjectVmBinding

**工作项**

- 实现项目 CRUD、归档和工作区配置；
- 实现多 VM 绑定、主 VM 和工作目录；
- 实现项目会话、项目活动和产物引用；
- 在 UI 明示共享 VM 的项目清单和状态影响。

**验收**

- 多项目可绑定同 VM；
- 单项目可绑定多 VM；
- 项目可绑定停止 VM；
- 解绑或删除项目不会误删共享 VM。

### 5.2 实现 Task Service

**工作项**

- 实现任务创建、依赖、优先级和幂等；
- 实现状态机、取消、重试和错误记录；
- 实现 TaskEvent、Outbox 和任务时间线；
- 实现目标 VM 队列；
- 实现任务完成结果和产物校验接口。

**验收**

- 所有状态迁移合法且有事件；
- 同 VM 任务串行，即使来自不同项目；
- 重启后任务不会重复执行；
- 前端不能直接将任务伪改为完成。

### 5.3 实现基础任务看板

**工作项**

- 展示待排队、等待 VM、执行中、审批、完成和失败；
- 按项目、VM、Worker 和状态筛选；
- 支持排队优先级、取消、重试和任务详情；
- 通过 WebSocket 实时更新。

**验收**

- 看板与数据库一致；
- 重连后完整同步，不只依赖漏收的增量事件；
- 任务详情能跳转项目、VM 和来源会话。

---

## 阶段 6：Pi Worker、会话和模型接入

### 6.1 将 Worker Runtime 集成进 VM 镜像

**工作项**

- 安装固定版本 Node 和 Pi；
- 创建非特权 Worker 用户；
- 配置工作目录、工具和资源加载；
- 实现 Guest 内 RPC 服务和 Host 侧 RpcClient；
- 实现 Engine/Session 版本检查。

**验收**

- VM 启动后能按任务启动 Worker；
- Worker 不具有不必要的 root/Administrator 权限；
- 版本不兼容时明确失败，不直接读写不兼容会话。

### 6.2 实现 Model Broker

**工作项**

- 接入本地 OS 凭据存储；
- 实现 VM 短期令牌、模型白名单、超时和撤销；
- 支持流式、工具、图片、取消和重试；
- 实现用量和错误记录；
- 验证 Computer Use 协议完整性。

**验收**

- VM 镜像和文件中没有长期 Provider Key；
- 撤销令牌后 Worker 无法继续调用；
- 断线和 Provider 错误能够映射为明确任务状态。

### 6.3 实现 Worker Engine Adapter

**工作项**

- 实现 Start、Prompt、Steer、Follow-up、Abort 和 Subscribe；
- 将 Pi 事件映射到统一 TaskEvent；
- 将 Worker 状态、心跳和当前任务持久化；
- 实现异常退出、RPC 断线和对账；
- 实现会话备份与恢复入口。

**验收**

- 用户可在一个项目会话中持续与 Worker 对话；
- Steer 与 Follow-up 行为可区分；
- Abort 后工具执行停止且任务状态准确；
- 控制平面重启不丢 Worker 绑定。

---

## 阶段 7：完整 Computer Use 执行器

### 7.1 实现 Computer Use 工具集

**工作项**

- 接入截图、点击、双击、移动、输入、按键、滚动、拖拽和等待；
- 校验动作 Schema、Lease、截图和显示元数据；
- 实现动作前后截图及 Trace；
- 实现屏幕变化、分辨率和 DPI 处理。

**验收**

- 所有动作可审计到任务和 Worker；
- 无有效 Lease 的动作不会执行；
- 中文、滚动、拖拽和分辨率变化通过测试。

### 7.2 实现 Agent 执行闭环与保护

**工作项**

- 实现观察、决策、执行、验证循环；
- 实现最大步数、超时、无进展和重复动作检测；
- 实现卡住、失败、等待用户和取消；
- 实现任务完成验证；
- 实现 VM 重启后的重新观察，而非旧动作重放。

**验收**

- 无进展任务会暂停或失败，不无限点击；
- 用户取消及时生效；
- 完成状态有独立结果证据；
- VM 状态不确定时进入 Blocked 或等待用户。

### 7.3 实现 Policy 和 Approval

**工作项**

- 定义敏感动作和项目策略；
- 实现 Waiting Approval、批准、拒绝和超时；
- 将审批绑定具体动作和上下文摘要；
- 实现网络、文件交换和凭据策略基础版本。

**验收**

- 审批前动作不执行；
- 拒绝后产生明确工具结果和任务事件；
- 审批记录可审计；
- VM 网络访问不默认覆盖宿主机管理网段。

### 7.4 运行首轮真实任务评测

**工作项**

- 运行阶段 0 任务集；
- 比较 Pi 与专用 Engine（如已验证）；
- 记录成功率、步数、卡死和人工接管；
- 修复高频基础设施问题，再调整 Prompt 或模型配置。

**验收**

- 形成基线报告；
- 关键任务有重复运行结果；
- 不用单次演示代替稳定性结论。

---

## 阶段 8：Router、Worker Registry 和归档

### 8.1 实现 Worker Registry 与 Conversation Binding

**工作项**

- 持久化 Worker、Agent Session、Project + VM 和来源会话；
- 实现 Active Roster 和 Archive Registry；
- 实现 Worker 摘要、能力、当前任务和最后活跃记录；
- 提供 Router 结构化查询工具。

**验收**

- Router 重启后可准确列出任务分配；
- Worker 不跨项目错误复用；
- Active Roster 可从数据库完整重建。

### 8.2 实现 Router Runtime

**工作项**

- 在本地启动 Pi Router Session；
- 只注册任务、项目、Worker、看板和归档工具；
- 实现需求澄清、目标项目识别和任务创建；
- 实现复用、恢复或新建 Worker 的决策流程；
- 实现任务进度和结果的汇总通知。

**验收**

- Router 无 VM 输入、Shell 和 Supervisor 工具；
- 新任务分派前会查询已有 Worker；
- 跨项目任务分别进入正确 VM 队列；
- Router 返回后 Worker 仍能独立运行。

### 8.3 实现 Worker 自动归档

**工作项**

- 实现空闲检测、归档阻塞条件和空闲策略；
- 保存会话引用、恢复点、摘要和产物；
- 发布归档事件并更新 Active Roster 和看板；
- 停止不再需要的 Worker 进程，但不自动停止 VM。

**验收**

- 运行、待审批、排队或持锁 Worker 不会被归档；
- 归档后历史仍可搜索；
- Router 默认上下文不再携带归档 Worker 卡片；
- 归档不删除 VM、项目或任务。

### 8.4 实现 Worker 恢复

**工作项**

- 支持同版本原生会话恢复；
- 支持新 Worker 加载归档摘要；
- 注入最新截图和离开期间项目/VM 变化；
- 处理 Engine 或 Session 不兼容。

**验收**

- 用户能继续归档前工作；
- 不使用过期截图直接输入；
- 语义恢复时 UI 和日志明确标注恢复类型。

---

## 阶段 9：多 VM 资源调度和共享环境完善

### 9.1 实现 Resource Manager

**工作项**

- 统计宿主资源、运行 VM 和软预算；
- 实现自动启动、等待资源、等待 VM 和排队；
- 实现手动、自动启动和空闲休眠策略；
- 实现资源不足通知；
- 确保不擅自停止有任务的 VM。

**验收**

- VM 拥有数量不受固定值限制；
- 资源足够时不同 VM 可并行；
- 资源不足时自动任务等待；
- 用户停止/休眠后等待任务能按策略继续。

### 9.2 完善共享 VM 项目保护

**工作项**

- 展示软件、桌面和系统状态共享提示；
- 实现项目目录备份和产物版本；
- 限制以整机快照回滚单项目；
- 实现项目删除与 VM 删除的依赖检查；
- 为 Worker 恢复生成环境增量摘要。

**验收**

- 恢复共享 VM 快照前明确列出全部受影响项目；
- 项目级备份可以独立恢复；
- 共享 VM 上其他项目不会被静默删除或回滚。

### 9.3 完整多端状态同步

**工作项**

- 看板增加等待资源和 VM 状态；
- VM 页显示队列和当前 Worker；
- 项目页显示所有绑定和活跃 Worker；
- 支持从任务跳转实时控制台和 Worker 会话。

**验收**

- 同一任务在 Router、看板、项目和 VM 页状态一致；
- 所有页面在断线重连后能对账恢复。

---

## 阶段 10：飞书和 QQ 本地机器人

### 10.1 实现 Bot Connector 公共框架

**工作项**

- 实现连接状态、心跳、重连、事件去重和本地 Ingress 队列；
- 实现平台身份与本地用户绑定；
- 实现用户/群白名单和权限；
- 实现出站消息、任务通知和审批通知；
- 实现一台活跃执行电脑绑定。

**验收**

- 事件处理与长任务解耦；
- 重连不重复创建任务；
- 未授权平台用户不能操作 VM；
- Secret 不进入 VM 和普通日志。

### 10.2 实现飞书 Connector

**工作项**

- 实现应用配置向导和权限检查；
- 接入官方 WebSocket 和 Open API；
- 支持文本任务、进度、结果和基础交互；
- 处理后台服务运行和离线状态。

**验收**

- 无公网 IP、无用户服务器时可在本机收发；
- 电脑离线状态准确；
- 机器人消息与本地 Conversation 正确绑定。

### 10.3 实现 QQ Connector

**工作项**

- 实现目标机器人类型的配置向导；
- 接入 WebSocket、Intents 和 REST；
- 验证群聊、单聊和允许的消息类型；
- 对平台不支持的能力给出明确提示。

**验收**

- 目标接入形态无需 Webhook 公网地址；
- 权限不足不会静默失败；
- 事件去重、重连和用户授权通过测试。

### 10.4 打通机器人到 Router 的完整流程

**工作项**

- 创建或继续主会话；
- 创建任务、选择项目、分派 Worker；
- 返回排队、运行、审批、完成和失败状态；
- 支持取消和查询；
- 敏感操作要求额外确认。

**验收**

- 飞书/QQ 与 Web 对同一任务看到一致状态；
- 机器人只是另一入口，不创建独立任务事实；
- 离线重连后不会重复执行旧消息。

---

## 阶段 11：Web、Electron 和安装体验完善

### 11.1 完整本地 Web UI

**工作项**

- 完成主会话、项目会话、任务看板、VM 管理、控制台、归档和设置；
- 实现本地浏览器认证和 CSRF/Origin 等本机 Web 防护；
- 实现响应式和基础可访问性；
- 实现统一通知中心。

**验收**

- 本地 Web 与 Electron 功能一致，除明确的桌面系统能力；
- 仅绑定本机地址不等于无需认证，本机恶意网页不能随意调用 API；
- 刷新和重启不丢 UI 对应的任务状态。

### 11.2 完善 Electron 和后台服务

**工作项**

- 托盘、通知、文件拖放和开机启动选项；
- 后台服务状态管理；
- 自动更新和回滚；
- 安装器处理权限、系统功能、重启和卸载；
- 卸载默认保留用户 VM 数据，并由用户明确选择是否删除。

**验收**

- 关闭窗口行为符合用户设置；
- 更新失败可恢复旧版本和数据库；
- 卸载不会默认删除自定义目录中的 VM；
- 安装过程清晰展示存储和资源选项。

### 11.3 远程 Web 边界确认

**工作项**

- 首版确认本地 Web 已满足浏览器访问；
- 若开发远程访问，单独实现可选加密 Relay 和设备授权；
- Relay 不成为本地核心或机器人长连接的依赖。

**验收**

- 无 Relay 时所有本地核心功能仍可使用；
- 远程访问不会要求用户自行开放路由器端口。

---

## 阶段 12：Linux 安全、故障、升级与全链路验收

### 12.1 安全测试

**工作项**

- 测试 Renderer 到 Supervisor 的权限绕过；
- 测试 Guest RPC、VNC、本地 API 和机器人鉴权；
- 测试 VM 访问宿主机、内网和元数据地址；
- 测试恶意网页/文件提示词注入后的权限边界；
- 测试审批绕过、路径穿越、文件交换和密钥泄露；
- 检查日志和截图敏感信息。

**验收**

- 高危问题关闭后才进入公开发布；
- AI 无宿主机通用执行通道；
- 同 VM 项目不被宣传为强安全隔离；
- 外部网络影响有明确审批与提示。

### 12.2 故障与恢复测试

**工作项**

- Electron、Control Plane、Supervisor、Guest Agent、Worker 分别崩溃；
- VM 崩溃、宿主机重启、断电模拟、断网和磁盘不足；
- 下载中断、迁移中断、快照损坏和数据库恢复；
- 机器人重连和重复事件；
- 任务执行中人工接管和取消。

**验收**

- 不发生重复任务和盲目桌面动作重放；
- 状态不确定时进入明确的安全状态；
- 备份可恢复，错误有可操作诊断；
- 用户数据不被默认删除。

### 12.3 Linux 性能和资源测试

**工作项**

- 多镜像、多停止 VM 和不同运行组合；
- 多台 Linux VM 同时运行与资源不足；
- 长时间运行、内存泄漏和句柄泄漏；
- 大量 Worker 归档和任务历史下的看板/Router 查询；
- 大镜像下载和非系统盘迁移。

**验收**

- 无固定 VM 数量假设导致的功能错误；
- 宿主资源不足有保护性排队和提示；
- 归档能控制 Router 活跃上下文大小；
- 常用页面和事件在目标数据量下保持可用。

### 12.4 Linux 全量真实任务回归

**工作项**

- 全量运行 Linux Computer Use 任务集；
- 覆盖 Linux 共享 VM、独立 VM 和停止后恢复；
- 覆盖 Router 复用、新建、归档、恢复 Worker；
- 覆盖 Web、Electron、飞书、QQ；
- 记录成功率、人工接管和已知限制。

**验收**

- 形成 Linux 全链路验收基线和已知问题清单；
- 核心任务具有重复验证结果；
- 文档、安装、权限和故障提示与实际行为一致。

### 12.5 形成 Linux 全链路验收构建并解锁 Windows VM

**工作项**

- 固定 Linux 验证构建的依赖、Pi、镜像和协议版本；
- 生成带签名的测试安装包和校验信息；
- 完成升级与回滚验证；
- 完成用户指南、机器人配置指南、存储指南和隐私说明的 Linux 版本；
- 建立问题诊断和反馈流程；
- 明确该构建是本期 Linux 全链路里程碑，不是本期最终完成声明。

**验收**

- 干净 Windows Host 按文档可完成安装并运行首个 Linux VM 任务；
- 用户可选择非系统盘、下载后停止 VM、共享或独占 VM；
- 无用户服务器时本地机器人和核心产品可用；
- Linux 全链路测试全部通过，正式解锁本期后段 Windows VM 的可行性和开发；
- 发布说明不夸大隔离、离线、Windows 支持或 Computer Use 成功率。

---

## 阶段 13：Windows VM 可行性、开发与本期最终联合验收

> 本阶段属于本期必做范围，不是下一期或可选扩展。入口条件是阶段 0～12 的 Linux 全链路完整验收通过。此前允许完成 Windows 镜像下载，但不允许把下载成功当作 Windows VM 可行性结论。

### 13.1 验证 Windows Guest 镜像和基本可行性

**工作项**

- 确定合法 ISO、评估镜像或内部镜像来源及激活要求；
- 验证无人值守安装、VirtIO、显示和 Golden Image 构建；
- 验证已提前下载镜像的校验、版本和适用性；
- 在目标 Windows Host Provider 上创建并启动 Windows Guest；
- 验证桌面会话、网络、分辨率、DPI、重启和停止；
- 记录 UAC、锁屏、安全桌面和许可限制。

**验收**

- Windows Guest 有明确、可重复的镜像构建与启动路径；
- 镜像来源和许可条件清晰，不分发无许可镜像；
- 不可自动操作的系统边界有明确人工处理方案；
- 若主路径不可行，先调整 Provider 或镜像方案，不继续堆叠上层功能。

### 13.2 完成 Windows VM 生命周期与存储适配

**工作项**

- 接入 Create、Start、Stop、Suspend/Resume、Snapshot 和 State；
- 实现 Windows VM 健康检查、异常恢复和 Supervisor 重启对账；
- 验证自定义存储、迁移、覆盖盘和快照链；
- 验证多项目共享、项目独占和多 VM 绑定；
- 将 Windows VM 纳入统一 Resource Manager 和 Per-VM Lease。

**验收**

- Windows VM 与 Linux VM 使用统一领域模型和任务协议；
- 停止、休眠和宿主重启后状态准确；
- 同一 Windows VM 上不同项目任务串行；
- 用户可创建并保留多台 Windows VM，无固定数量硬限制。

### 13.3 实现 Windows Guest Agent 与 Computer Use

**工作项**

- 实现 Windows 屏幕采集、鼠标、键盘、Unicode、滚动和拖拽；
- 处理桌面焦点、DPI、多显示器、锁屏和会话状态；
- 接入 noVNC/控制台和人工接管；
- 接入 Computer Use 工具、动作审计、取消和卡住检测；
- UAC 和安全桌面转人工，不绕过系统安全机制。

**验收**

- Windows 截图、坐标、中文输入和人工接管通过任务测试；
- 无有效 Lease 的输入不会执行；
- 取消后无残留动作；
- 状态不确定时不盲目重放旧动作。

### 13.4 验证 Windows Pi Worker 与 Model Broker

**工作项**

- 在 Windows Guest 安装固定版本 Node、Pi 和 Worker Runtime；
- 验证 RPC、事件、Steer、Follow-up、Abort 和 Session Resume；
- 验证 Model Broker 流式、图片、工具、Thinking 和取消；
- 验证 Worker 归档、恢复和环境增量；
- 验证长期密钥不进入 Windows VM。

**验收**

- Windows Worker 与 Linux Worker 遵守同一 Worker Engine 协议；
- 取消、断线、归档和恢复行为准确；
- 会话不兼容时有明确降级；
- Windows VM 不包含长期 Provider 或机器人 Secret。

### 13.5 完成 Linux/Windows 混合项目与调度

**工作项**

- 验证一个项目绑定 Linux 和 Windows VM；
- 验证多个项目共享同一 Windows VM；
- 验证资源允许时跨 VM 并行、资源不足时排队；
- 验证共享 VM 快照影响提示和项目独立备份；
- 打通 Router、任务看板、Web、Electron、飞书和 QQ 的混合任务。

**验收**

- 任务正确路由到目标 OS 和 VM；
- 跨项目 Worker 不会错误复用；
- 同 VM 串行与跨 VM 并行均符合资源策略；
- 各端对同一混合任务看到一致状态。

### 13.6 本期最终联合回归与发布

**工作项**

- 全量运行 Linux 和 Windows Computer Use 任务集；
- 重跑 Linux 全链路回归，确认 Windows 开发没有造成回归；
- 完成两种 Guest 的安全、故障、恢复、升级、存储和资源测试；
- 更新用户文档、能力矩阵和已知限制；
- 固定本期最终依赖、镜像、协议和安装包版本。

**验收**

- Linux 与 Windows 均达到本期任务基线；
- Windows Host 运行 Linux VM 的 P0 能力无回归；
- Windows VM 已在本期交付，不存在仅剩文档或仅可下载镜像的占位状态；
- 干净电脑可完成安装、创建项目并通过两种 Guest 执行任务；
- 最终发布说明准确描述隔离、离线、平台权限和 Computer Use 限制。

---

## 3. 每阶段固定交付物

每个阶段结束必须同时提交：

1. 可运行功能或验证原型；
2. 自动化测试与真实环境测试结果；
3. 协议、配置或架构文档更新；
4. 错误处理、取消、日志和故障行为说明；
5. 已知限制和下一阶段依赖；
6. 对本文档验收项的逐项勾选，不以口头“基本完成”代替。

## 4. 开发中的禁止事项

- 禁止把固定两台 VM 写成产品限制；
- 禁止在个人开发阶段引入总集成仓库、业务子仓库或 Git Submodule 联动；
- 禁止混用 npm、pnpm、Yarn 锁文件，或通过未声明依赖和默认全局 Hoist 掩盖 Workspace 问题；
- 禁止把 Windows Host 运行 Linux VM 降为可选能力；
- 禁止把 Windows VM 移出本期最终范围，或以仅支持镜像下载代替 Windows VM 交付；
- 禁止在 Linux 全链路完整验收前开展 Windows VM 可行性或对应功能开发，提前镜像下载除外；
- 禁止把项目与 VM 改成一对一后再通过补丁支持共享；
- 禁止让 Router 直接获得 VM 输入或 Supervisor 通用接口；
- 禁止让 Electron Renderer 直接执行特权命令；
- 禁止把长期模型或机器人 Secret 写入 VM 镜像；
- 禁止同 VM 多 Worker 绕过 Execution Lease 并行输入；
- 禁止以恢复共享 VM 快照作为单项目回滚；
- 禁止仅因 Worker 空闲就归档仍有排队、审批或 Lease 的 Worker；
- 禁止把归档实现为删除任务或修改 Router 历史消息；
- 禁止把机器人事件处理同步阻塞在整个 AI 任务上；
- 禁止在电脑离线时宣称本地任务仍在执行；
- 禁止以模型自述完成代替任务结果验证；
- 禁止在 Pi Computer Use 验证失败时通过开放宿主机工具绕过问题。

## 5. 立即开始的第一批任务

实际开发从以下顺序开始：

1. 建立 Linux 测试矩阵和 Computer Use 验收任务集；
2. 验证 Windows Host 上 QEMU/WHPX 与 Hyper-V 运行 Linux VM，这是 P0 必过项；
3. 验证 Linux 镜像下载、校验和 Golden Image 构建；
4. 可选提前验证 Windows 镜像的下载与存储，但不开展 Windows VM 可行性或功能开发；
5. 验证 Linux VM 内 Pi RPC、截图/点击工具和完整取消；
6. 验证 Pi 对目标模型 Computer Use 的兼容程度；
7. 验证本地 Model Broker 不破坏流式、图片和工具协议；
8. 验证飞书和 QQ 目标机器人账号的本地 WebSocket 收发；
9. 将验证结论回写技术文档，冻结 Linux 先行阶段 Provider 与 Worker Engine；
10. 再进入 Monorepo、数据库和 Linux 产品功能开发；
11. 等阶段 0～12 的 Linux 全链路完整验收后，进入阶段 13，完成本期 Windows VM 验证、开发和联合发布。

完成前九项之前，不优先投入复杂看板视觉、自动化安装界面美化或云端扩展。Windows 镜像下载可以提前，但不得打乱 Linux 全链路先行的主路径。
