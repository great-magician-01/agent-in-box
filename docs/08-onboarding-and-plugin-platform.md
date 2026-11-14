# 零门槛初始化与 Agent 扩展平台方案

> 文档状态：首版实现已落地；真实桌面、Hypervisor 与模型环境验收待完成  
> 更新日期：2026-11-14  
> 适用范围：Electron、本地 Web、Control Plane、VM Supervisor、Guest Runtime、Router、Worker 与 Pi 扩展  
> 相关文档：[产品方案](01-product-solution.md)、[技术设计](02-technical-design.md)、[开发计划](03-development-plan.md)、[用户指南](04-user-guide.md)、[存储指南](06-storage-guide.md)、[隐私说明](07-privacy.md)

## 1. 背景

Agent-in-Box 已具备模型代理、镜像下载、VM 生命周期、Guest 初始化、Router/Worker、Computer Use、任务持久化、审批和恢复等基础能力，但这些能力尚未被编排成一条面向新用户的完整首次使用链路。

当前主要问题不是缺少某个单独功能，而是：

1. 首次向导完成只代表设置已保存，不代表模型、Router、VM、Guest 或 Worker 可用；
2. 用户仍需分别理解并操作 QEMU、VM、项目、Guest 工作目录、VM 绑定和 Worker；
3. “一键创建 Linux VM”的编排主要位于 Renderer，缺少后端持久化状态、统一恢复和修复入口；
4. 宿主 Router 默认依赖 PATH 中的 `pi`，桌面发布包尚未形成完整的宿主 Agent 运行时；
5. 模型配置以保存成功为终点，缺少统一的连通性、模型有效性和图片输入能力验证；
6. Pi 已支持通过 `--extension` 显式加载扩展，但产品尚没有插件 Manifest、注册表、版本、作用域、测试、启用和回滚机制；
7. AI 若要自行开发并注册插件，不能简单等同于向扩展目录写文件，必须经过与用户插件一致的生命周期和权限边界。

本方案将上述问题拆成两项相互衔接的建设：

- **零门槛初始化**：普通用户只需确认保存位置和模型，其余环境准备自动完成；
- **Agent 扩展平台**：内置项目必需扩展，允许用户开发和注册插件，并支持 AI 在受控开发模式中自行开发、测试和注册插件。

## 2. 产品目标与核心决策

### 2.1 总体目标

一个新用户不阅读 README，只凭应用界面即可完成：

```text
选择保存位置 → 配置模型 → 开始对话 → 下达任务
```

普通用户不需要预先理解 QEMU、cloud-init、Guest Agent、Supervisor、Router、Worker、项目与 VM 绑定等内部概念。

### 2.2 已确定的产品决策

1. **首次启动只要求两项用户决策**：数据保存位置和可用模型；其余均使用安全默认值或自动检测。
2. **可对话与可执行分开就绪**：模型和 Router 可用后即可聊天，执行环境在后台继续准备。
3. **自动创建默认工作区**：首次执行准备完成后，系统已拥有默认项目、默认 Linux VM、主绑定和 Guest 工作目录。
4. **初始化由后端持久化编排**：Renderer 只展示状态和提供操作，不负责拥有核心流程。
5. **高级能力不删除**：现有多项目、多 VM、资源、存储、模型和运行时管理保留在高级入口。
6. **内置扩展随版本发布**：项目必需扩展及其依赖随应用或 Guest Runtime 一起构建、校验和升级。
7. **用户插件与 AI 插件共用生命周期**：开发、校验、测试、注册、启用、升级、禁用和回滚使用同一套协议。
8. **注册与启用分离**：注册保存一个不可变版本；启用改变某个项目或 Worker 的能力。
9. **第三方扩展先限定 Guest Worker**：首版不允许用户或 AI 插件直接加载进 Electron、Control Plane 或宿主 Router。
10. **会话使用不可变扩展集合**：首版不热替换正在执行任务的扩展，新版本对新建或重启的 Worker 会话生效。
11. **核心安全规则不插件化**：Lease、审批、长期凭据、VM 生命周期和任务完成证据继续由确定性服务强制执行。

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| Bootstrap | 从保存用户选择到执行环境可用的完整初始化过程 |
| Conversation Ready | 模型、凭据、宿主 Pi 和 Router 已验证，可进行主会话对话 |
| Execution Ready | 默认 VM、Guest、Worker Runtime、默认项目及绑定均可用，可接收执行任务 |
| Pi Extension | Pi 通过 `--extension` 显式加载的扩展模块 |
| Plugin | Agent-in-Box 管理的完整插件包，包含 Manifest、一个或多个扩展、测试及资源 |
| Register | 校验并保存一个不可变插件版本，不等于启用 |
| Enable | 将指定插件版本加入某个项目或 Worker 后续会话的扩展集合 |
| Plugin Session Snapshot | 某次 Worker 会话实际使用的有序插件 ID、版本和内容哈希集合 |
| Development Worker | 用于插件生成、测试和验证的 Guest Worker，不自动获得其他项目的启用权限 |

## 4. 零门槛初始化方案

### 4.1 普通用户流程

首次启动页面只包含两个主要区域。

#### A. 保存位置

- 提供可直接接受的默认目录；
- 支持原生目录选择器；
- 显示可用空间、建议空间和目录可写性；
- 不要求用户理解内部存储布局；
- 根据最终选择目录重新执行磁盘检查，避免默认盘空间不足阻塞用户进入目录选择步骤；
- 目录变更必须协调 Control Plane、VM Supervisor 和相关桌面运行时，不允许只更新其中一个进程的配置。

#### B. 模型

普通模式只显示：

- 服务商；
- API Key 或该服务商支持的登录方式；
- 默认模型。

保存后自动执行：

1. 安全存储可用性和凭据保存检查；
2. Provider 网络与鉴权验证；
3. 模型 ID 有效性验证；
4. Router 最小请求验证；
5. Worker 图片输入能力检查；
6. 保存默认模型选择。

Router 与 Worker 默认共用同一套已验证配置。高级设置中才显示 Base URL、API 协议、Provider ID、模型白名单以及 Router/Worker 分模型配置。

如果模型只支持文本：

- 可以标记为 Conversation Ready；
- 不得标记为 Computer Use Execution Ready；
- 界面明确说明需要选择支持图片的模型才能操作 VM；
- 不允许等到创建 Worker 时才首次暴露该问题。

### 4.2 初始化后的界面

模型和 Router 验证通过后立即进入主会话，并允许用户输入。

执行环境仍在准备时：

- 主会话正常可用；
- 页面只显示一条简洁的准备状态，例如“正在准备执行环境”；
- 可展开查看当前阶段、下载进度和预计剩余工作；
- 用户可提前下达任务，任务按现有持久队列保存；
- 只有实际执行需要等待环境，聊天、规划和历史查看不被阻塞；
- 不显示内部组件术语，除非用户打开高级诊断。

默认文案不得承诺固定完成时间。镜像下载和 Guest 初始化可以显示基于当前进度的估计，但不能将估计当作保证。

### 4.3 自动创建的默认资源

初始化完成后自动形成：

```text
默认工作区“我的工作区”
└─ 默认 Project
   ├─ 默认 Linux VM
   ├─ 主 ProjectVmBinding
   ├─ 默认 Guest 工作目录
   └─ 默认 Worker 配置
```

要求：

- 名称、描述、资源档位和 Guest 路径均有安全默认值；
- 默认 VM 资源根据宿主可用内存、Host Reserve 和当前压力计算；
- 不覆盖用户已有项目、VM 或绑定；
- 重试时复用已创建且校验通过的默认资源；
- 不要求用户先进入项目页或 VM 页完成补充操作；
- 用户以后可以从高级入口拆分、修改或新增项目与 VM。

默认工作区是产品初始状态，不是新的安全边界。其数据模型继续使用现有 Project、VMInstance、ProjectVmBinding 和 Worker，不引入平行体系。

### 4.4 两级就绪模型

#### Conversation Ready

必须同时满足：

- 配置和数据目录可读写；
- 凭据可由系统安全存储正常解密；
- 宿主 Pi 运行时存在且版本兼容；
- Router 可以建立会话；
- Provider、模型和最小上游请求验证通过；
- 必要的本地认证和 Control Plane 服务正常。

#### Execution Ready

必须同时满足：

- Conversation Ready；
- 宿主虚拟化能力和资源检查通过；
- Supervisor 与 QEMU 可用；
- 默认镜像已下载、校验并可用；
- 默认 VM 已创建并启动；
- cloud-init/Guest 初始化达到明确 Ready；
- Guest Agent 和 Worker RPC 健康、版本兼容；
- 默认项目、主 VM 绑定和 Guest 工作目录完整；
- Worker 所选模型支持任务所需模态。

`VM powerState = running` 不等于 Guest Ready，`onboarding.completedAt` 也不等于上述任一就绪状态。

### 4.5 Bootstrap Orchestrator

在 Control Plane 新增持久化初始化编排职责，统一调用现有存储、模型、镜像、VM、Provisioning、项目和 Worker 能力。

建议顶层状态：

```text
not_started
  → preferences_saved
  → validating_model
  → conversation_ready
  → checking_host
  → preparing_runtime
  → preparing_image
  → creating_default_vm
  → provisioning_guest
  → creating_default_workspace
  → verifying_execution
  → execution_ready
```

任一阶段可进入：

- `waiting_user_action`：必须由用户处理，例如管理员授权或重启；
- `retryable_failed`：网络、下载、临时进程失败，可重试或续传；
- `blocked`：当前硬件、模型或配置不满足要求；
- `cancelled`：用户明确取消尚未完成的准备工作。

`conversation_ready` 后允许后台执行准备；模型验证与部分下载可以并行，但大流量下载必须先完成磁盘和网络预检。

### 4.6 持久化与幂等

每次初始化至少记录：

- 初始化 ID 和当前状态；
- 当前阶段及阶段内进度；
- 已选数据根和默认模型引用；
- 已创建的镜像、VM、项目和绑定 ID；
- 已完成阶段及完成时间；
- 最近错误的稳定错误码、用户可读摘要和诊断引用；
- 重试次数、下次可重试时间；
- 是否需要重启或用户授权；
- Orchestrator 协议版本。

要求：

1. 状态入 SQLite，不以 React 状态作为事实源；
2. 每个阶段可重复进入，重复执行不得创建重复 VM、项目或绑定；
3. 外部 VM 创建成功而数据库写入失败时必须有补偿或对账；
4. 应用重启后从最后一致阶段恢复；
5. 运行中的桌面动作不因 UI 恢复而自动重放；
6. 下载、校验、安装和 Ready 判定分别有明确状态；
7. 旧版本初始化记录需要可迁移，升级后不能重复执行破坏性步骤。

### 4.7 跨进程职责

| 组件 | 职责 |
| --- | --- |
| Electron | 原生目录选择、系统安全存储、托管 QEMU、进程监管、需要时的系统授权与重启引导 |
| Control Plane | Bootstrap 事实源、模型验证、默认资源创建、状态持久化、事件和恢复 |
| VM Supervisor | 固定 VM/Hypervisor 操作、状态对账，不接受模型生成的任意指令 |
| Guest Agent | Guest 健康、文件/进程证据和既有受控能力 |
| Worker Runtime | Pi/扩展加载、Worker 健康和会话就绪 |
| Renderer | 展示状态、收集两项必要配置、提供重试/取消/高级诊断 |

数据根变化时，由桌面层协调 Control Plane 与 Supervisor 的停止、迁移、重启和健康验证；成功前不宣称迁移或初始化完成。

### 4.8 模型配置事务

模型设置不能继续保持“凭据保存”和“Provider 注册”互不相干的状态。

逻辑事务为：

```text
保存凭据到系统安全存储
→ 保存/更新 Provider 配置
→ 验证 Provider 与模型
→ 保存默认选择
→ 标记验证结果
```

上游验证失败时：

- 可以保留用户已输入的配置以便修改；
- 不得将其标记为已验证；
- 不得仅凭配置存在就进入 Conversation Ready；
- 凭据仍只在既有安全边界内使用；
- 错误需区分鉴权、区域/工作区、模型不存在、网络、限流和不支持图片。

### 4.9 自包含与网络依赖

发布包必须包含宿主 Router 所需的、版本固定的 Pi 运行时及生产依赖，不再假设干净宿主 PATH 中存在 `pi`。

Guest 所需扩展随 Worker Runtime 打包。需要盘点并尽量预构建 Pi 安装依赖，避免已带 npm tarball 却仍在首次 Guest 安装时隐式访问 Registry。

所有外部依赖应进入预检和诊断：

- 模型 Provider；
- QEMU 发布 Manifest 和资产源；
- Ubuntu 镜像及镜像源；
- Ubuntu 软件源；
- npm 或其他运行时依赖源；
- 系统安全存储服务。

QEMU 与镜像应尽可能共用统一下载能力：进度、取消、重试、断点续传、SHA-256、原子启用和重启恢复。

### 4.10 错误与恢复

普通界面只展示可行动信息：

| 内部情况 | 用户界面应表达的内容 |
| --- | --- |
| 磁盘不足 | 需要多少空间、当前可用多少、如何更换目录 |
| 镜像/QEMU 下载失败 | 当前已保留进度、自动/手动重试、镜像设置入口 |
| Key 无效 | 对应服务商鉴权失败，可重新填写并验证 |
| 模型不支持图片 | 可以聊天，但执行任务需换多模态模型 |
| Guest 初始化失败 | 初始化未完成，可从失败阶段重试并查看诊断 |
| WHPX/KVM 不可用 | 需要的系统功能、授权或重启步骤 |
| Worker 不兼容 | 当前运行时版本问题和可执行的修复方式 |

技术日志、路径、PID、QEMU 参数和堆栈放入高级诊断，不作为普通用户的第一层错误信息。

### 4.11 不能伪装成全自动的边界

以下事项允许由应用检测、组织和引导，但不能承诺完全无感：

- BIOS/UEFI 虚拟化设置；
- Windows 功能启用、管理员授权和系统重启；
- 用户获取模型账号、凭据或完成服务商登录；
- 网络不可用、磁盘不足和第三方服务故障；
- Windows Guest 的合法 ISO、授权和激活；
- 登录、扫码、CAPTCHA、手机验证、UAC 和系统安全桌面。

默认安全审批也不因初始化简化而关闭，只将审批配置移到实际事件发生时的上下文提示及高级设置。

## 5. Agent 扩展平台方案

### 5.1 当前基础与保留原则

现有实现已经具备：

- CUA Pi 扩展；
- 内置 Subagent Pi 扩展；
- `PiWorkerEngine.extensionPaths` 多扩展入口；
- 通过多个 `--extension` 参数显式加载；
- 默认关闭 Skills、上下文文件、Prompt Templates 和 MCP 自动能力；
- Subagent 子进程只继承父 Worker 显式允许的扩展；
- 按项目控制 MCP，且只影响新建或恢复的 Worker 会话。

这些显式加载原则必须保留。插件平台不能退化为“扫描目录并自动执行其中全部代码”。

### 5.2 内置扩展

内置扩展分为两类。

#### 产品必需

随应用和 Guest Runtime 强制提供，并由应用版本统一管理：

- Computer Use Broker 适配；
- Subagent；
- 后续经设计确认的任务进度、产物、项目上下文等薄适配扩展。

产品必需扩展可以不在普通界面出现，但不能以禁用插件的方式关闭底层 Lease、审批或证据校验。

#### 可选能力

默认安装但按项目或用户设置启用，例如：

- MCP 兼容能力；
- 经验证的效率工具；
- 特定工作流扩展。

内置不等于无审计。每个内置扩展仍需：

- 固定版本和哈希；
- 明确目标运行时；
- 在 Linux/Windows 支持矩阵中验证；
- 随 Guest Runtime 构建，不要求用户首次启动时另行安装；
- 记录到 Plugin Session Snapshot。

不建议将流行社区扩展不加筛选地全部内置。只有产品闭环需要、维护责任和兼容性明确的扩展才进入默认包。

### 5.3 插件包与 Manifest

插件是产品管理单元，Pi Extension 是运行时加载单元。一个插件可以包含一个或多个扩展入口及所需资源。

建议 Manifest 至少包含：

```json
{
  "schemaVersion": 1,
  "id": "com.example.plugin",
  "version": "1.0.0",
  "displayName": "Example Plugin",
  "apiVersion": 1,
  "targets": ["worker"],
  "entrypoints": {
    "worker": "dist/extension.js"
  },
  "runtime": {
    "kind": "pi-extension",
    "minPiVersion": "1.5.1",
    "minAppVersion": "0.1.0"
  },
  "permissions": [],
  "tools": [],
  "dependencies": [],
  "description": "Example local extension"
}
```

实际实现前需要以版本化 JSON Schema 固化以下规则：

- `id` 使用稳定的反向域名或等价唯一标识；
- `version` 使用语义化版本；
- 同一 `id + version` 的内容不可变；
- 入口必须位于插件包内，不允许绝对路径、`..` 或符号链接逃逸；
- 所有文件计算内容哈希；
- 目标、API、Pi 和应用版本必须兼容；
- 工具名称带插件命名空间，避免与内置工具冲突；
- 构建产物应自包含，首版不在激活时执行任意 npm install 或生命周期脚本；
- Manifest 权限声明用于审查、界面和 Broker 授权，不被误称为通用 Node 沙箱。

### 5.4 插件注册表与存储

Control Plane 维护插件事实源，至少包含：

- Plugin：稳定 ID、名称、来源、创建者类型和当前状态；
- PluginVersion：不可变版本、哈希、Manifest、兼容性和存储位置；
- PluginInstallation：本机安装状态和默认策略；
- PluginEnablement：项目或 Worker 作用域、固定版本和启用状态；
- PluginTestRun：测试 Worker、结果、日志和诊断引用；
- PluginAuditEvent：导入、注册、启用、禁用、升级、回滚和失败记录；
- PluginSessionSnapshot：会话实际加载的有序扩展及版本哈希。

插件内容建议位于数据根下的专用版本化目录，例如：

```text
plugins/
  <plugin-id>/
    <version>/
      manifest.json
      files...
```

内置插件可以来自只读发布资源，但注册表仍记录其版本和启用关系。用户插件不得通过宿主共享目录直接挂载进 VM；需要经过受控传输、哈希校验和 Guest 侧固定插件根目录落盘。

### 5.5 生命周期

```text
draft
→ validating
→ testing
→ registered
→ enabled
→ disabled
```

异常状态包括：

- `invalid`：Manifest、入口、哈希或兼容性不通过；
- `test_failed`：测试未通过；
- `load_failed`：Worker 加载失败；
- `quarantined`： crash-loop、严重异常或用户撤销信任；
- `superseded`：已有更新版本，但旧版本仍可供历史会话和回滚使用。

状态规则：

1. 未通过结构和兼容性校验的版本不能注册；
2. 用户可明确跳过非强制测试，但界面必须显示“未测试”，AI 自动注册默认必须完成测试；
3. 启用必须指向一个已注册且内容哈希一致的版本；
4. 禁用不删除历史、插件文件或会话记录；
5. 升级创建新版本，不原地修改已启用版本；
6. 回滚是将作用域重新指向旧版本，不重写历史；
7. 正在运行的会话继续使用启动时快照；
8. 加载失败不得阻止整个 Control Plane 启动，受影响 Worker 应进入可诊断状态。

### 5.6 会话解析与生效规则

创建或恢复 Worker 时：

1. 读取项目/Worker 的启用关系；
2. 合并产品必需扩展和显式启用的可选扩展；
3. 按固定规则排序并解决工具名冲突；
4. 校验版本、入口和哈希；
5. 生成 Plugin Session Snapshot；
6. 将扩展路径显式传给 `PiWorkerEngine`；
7. Subagent 只继承父会话明确允许的扩展；
8. 将快照 ID 写入 Worker 会话和审计记录。

首版不做运行中热加载。界面可以显示“已启用，将在下次 Worker 会话生效”，避免用户误以为当前任务已改变能力。

后续若支持热加载，必须单独设计会话一致性、工具调用中状态、撤销、恢复和 Subagent 继承，不在本方案首版默认承诺。

### 5.7 用户手动开发流程

提供版本化插件模板和统一 CLI/API，概念命令为：

```text
aib-plugin init
aib-plugin validate
aib-plugin test
aib-plugin register
aib-plugin enable --project <project-id>
aib-plugin disable --project <project-id>
aib-plugin rollback --project <project-id> --version <version>
```

桌面界面提供对应能力：

- 从本地目录或压缩包导入；
- 查看 Manifest、权限、版本和源码来源；
- 运行测试并查看结果；
- 按项目或 Worker 启用；
- 禁用、升级和回滚；
- 打开高级诊断。

本地高级用户可以安装自己信任的未签名代码，但必须明确显示来源和权限，不将“用户确认”表述为代码安全证明。

### 5.8 AI 插件开发模式

新增独立的插件开发模式。用户可用自然语言提出：

> “开发一个插件，让 Worker 能把每周结果整理成固定格式，并在以后这个项目中使用。”

标准流程：

```text
理解需求并生成插件计划
→ 从内置模板创建工程
→ AI 编写 Manifest、扩展和测试
→ 静态校验与兼容性检查
→ 在 Development Worker 中加载并测试
→ AI 根据结果迭代
→ 注册不可变版本
→ 按作用域策略启用
→ 后续 Worker 会话使用
```

AI 使用的不是另一套特权机制，而是与用户插件相同的校验、测试和注册协议。

Development Worker 要求：

- 在 Guest 内运行；
- 使用独立开发工作区；
- 不自动获得其他项目的插件启用权；
- 不获得宿主 Shell、长期模型密钥或任意 Supervisor 能力；
- 测试过程、加载错误和工具调用可审计；
- 失败后可重建，不污染已注册版本；
- 默认不复用正在执行其他项目任务的会话进行插件热替换。

AI 可以在获得开发模式授权后自动完成开发、测试、修复和注册。自动启用按第 5.9 节策略执行。

### 5.9 注册与启用策略

| 操作 | 默认策略 |
| --- | --- |
| 在当前开发工作区生成和修改草稿 | 开发模式内允许 |
| 执行结构校验和本地测试 | 开发模式内允许 |
| 注册新的不可变版本 | 测试通过后允许 |
| 在当前项目自动启用 | 仅用户预先开启“当前项目 AI 插件自动启用”时允许 |
| 首次全局启用或跨项目启用 | 本机用户确认 |
| 申请新的宿主 Broker 能力 | 本机用户确认，且必须有固定服务接口 |
| 直接加载进 Electron、Control Plane 或宿主 Router | 首版禁止 |
| 替换正在运行会话的扩展 | 首版禁止 |
| 从机器人消息或网页内容提升插件权限 | 禁止，必须回到本机授权上下文 |

未开启自动启用时，AI 完成注册后向用户呈现插件名称、版本、用途、权限、测试结果和启用按钮。

### 5.10 权限与宿主能力

首版第三方扩展只在 Guest Worker 中运行。Guest 内已有的 Shell、文件和网络能力仍需遵守项目及 VM 既有策略；Manifest 不会被当作对任意 Node 代码的操作系统级约束。

需要访问宿主能力时，只能使用固定 Broker：

- 每个能力有独立、版本化接口；
- 使用短期、绑定项目/Worker/任务的令牌；
- 服务端校验作用域、Lease、审批和参数；
- 不暴露任意宿主路径、Shell、数据库、Supervisor 或长期凭据；
- 所有调用进入审计；
- 撤销令牌后不能继续调用。

Router 内置扩展可以继续由项目自己维护和发布；第三方 Router 扩展需要另行设计宿主进程隔离和权限模型，不属于首版范围。

### 5.11 故障隔离与恢复

Pi 同进程扩展可能崩溃、死循环或抛出未处理异常。首版至少提供：

- 启动前入口与哈希检查；
- 加载失败错误归因到具体插件和版本；
- Worker 进程监管和有限重启；
- crash-loop 后自动隔离该插件对后续会话的启用；
- 一键禁用并恢复上一已知可用版本；
- 不让单个插件失败导致其他项目或 Control Plane 不可用；
- 诊断日志脱敏，不记录长期密钥和 Broker 令牌。

真正的单插件 CPU、内存、文件系统和进程隔离需要独立运行时，不在首版虚假承诺。

## 6. 普通与高级信息架构

### 普通模式默认展示

- 主会话；
- 当前任务和结果；
- 简洁执行环境状态；
- 必要的审批与人工接管；
- 保存位置和默认模型的基础设置。

### 高级模式展示

- 多项目和多 VM 管理；
- QEMU、Supervisor 和运行时诊断；
- Router/Worker 分模型；
- 资源、存储、快照、归档和恢复；
- 插件管理、插件开发模式和权限；
- MCP、Subagent 策略及其他 Agent 高级设置。

渐进式隐藏只改变默认展示，不削弱服务端权限校验，也不删除现有高级用户能力。

## 7. 分阶段实施

### 阶段 A：初始化事实源与自包含运行时

- 内置宿主 Router Pi 及生产依赖；
- 新增模型验证能力；
- 定义 Conversation Ready / Execution Ready；
- 新增持久化 Bootstrap 状态和事件；
- 修复数据根切换的跨进程协调；
- 将宿主、磁盘和网络预检放在大下载之前。

**出口**：干净测试环境不再依赖 PATH 中的宿主 `pi`；向导完成后可准确区分可对话与不可执行原因。

### 阶段 B：默认执行环境自动准备

- 自动准备 QEMU、镜像、默认 Linux VM 和 Guest；
- 自动创建默认项目、主绑定和 Guest 工作目录；
- 将 Renderer 快速创建流程迁移到后端 Orchestrator；
- 支持续传、重试、取消、重启恢复和阶段修复；
- 任务按真实 Execution Ready 和 Guest 健康进行调度门控。

**出口**：新用户只完成目录和模型配置，即可在主会话下达并最终执行默认 Linux 任务。

### 阶段 C：插件底座与内置扩展统一

- 定义 Manifest JSON Schema、插件 API 和兼容性规则；
- 建立注册表、版本化存储和审计；
- 建立 Plugin Session Snapshot；
- 将现有 CUA/Subagent 纳入统一描述，不改变其核心安全行为；
- 提供用户模板、导入、校验、测试、注册、启用、禁用和回滚；
- 完成 Guest 插件受控同步。

**出口**：本地用户开发的示例插件可在指定项目注册并在下一 Worker 会话生效，禁用后可恢复。

### 阶段 D：AI 插件开发模式

- 提供 Development Worker 和插件开发工具；
- AI 使用统一 CLI/API 完成生成、测试和注册；
- 实现当前项目自动启用的显式偏好；
- 实现跨项目、全局和宿主能力的本机确认；
- 完成加载失败隔离和版本回滚。

**出口**：AI 能从自然语言需求生成一个插件，通过测试并注册；未获自动启用授权时停在用户确认，获授权后仅在当前项目生效。

### 阶段 E：后续增强，不作为首版门槛

- 运行中热加载；
- 第三方宿主/Router 插件独立进程；
- 更细粒度插件资源隔离；
- 签名分发、插件商店和远程仓库；
- 更复杂的插件依赖解析。

## 8. 验收标准

### 8.1 首次使用

1. 干净 Windows 宿主安装后，无全局 Pi、Node 开发环境或手工 Control Plane 配置也能进入主会话；
2. 用户只需确认目录和模型，不需要访问 QEMU、VM、项目绑定页面；
3. 默认盘空间不足时，用户仍能先选择其他目录再继续；
4. 模型 Key 无效、模型失效和不支持图片分别在配置阶段得到明确结果；
5. Conversation Ready 后可聊天，Execution Not Ready 时任务可靠排队；
6. 初始化中切换页面、刷新 UI 或重启应用，不丢失事实状态、不重复创建资源；
7. 下载中断可恢复，失败重试不重复下载已校验内容；
8. 目录变更后 Control Plane 和 Supervisor 使用同一有效数据根；
9. 默认项目、VM、主绑定和 Guest 工作目录自动就绪；
10. 需要管理员、重启、登录或 CAPTCHA 时只出现对应当前操作的明确提示。

### 8.2 插件平台

1. 未注册目录中的扩展不会被自动加载；
2. 同一版本内容被修改后哈希校验失败，不能静默替换；
3. 不兼容 Pi/API 版本的插件不能启用；
4. 插件可以按项目启用，不影响未授权项目；
5. 新插件不改变正在运行会话的扩展快照；
6. 禁用和回滚后，下一 Worker 会话使用预期版本；
7. Subagent 不获得父会话未显式允许的扩展；
8. 插件不能通过声明或调用绕过 Lease、审批、模型凭据和 Supervisor 边界；
9. 插件加载崩溃不会拖垮 Control Plane，且可定位、禁用和恢复；
10. 用户可查看每次会话实际使用的插件版本和哈希。

### 8.3 AI 开发模式

1. AI 能从模板生成 Manifest、扩展和测试；
2. 测试失败的版本不能被标记为已验证注册；
3. 注册与启用是两条独立、可审计操作；
4. 未开启自动启用时，AI 不能自行扩大作用域；
5. 开启当前项目自动启用后，也不能跨项目或获得宿主权限；
6. 机器人或网页内容不能间接触发权限提升；
7. AI 生成的新版本只影响下一 Worker 会话；
8. 每次注册、测试、启用和回滚均能追溯到具体开发会话和插件版本。

## 9. 测试矩阵

除现有单元测试和阶段 Smoke 外，新增以下场景：

- 干净 Windows/Linux 桌面包、无全局 Pi；
- 默认目录正常、默认盘空间不足、目标目录不可写；
- 有效/无效 Key、错误区域、无效模型、纯文本模型、多模态模型；
- QEMU 未安装、下载中断、哈希错误、Supervisor 不可用；
- 镜像续传、cloud-init 失败、Guest 超时、Worker 版本不兼容；
- 初始化中刷新、切页、Control Plane 重启、Electron 重启和系统重启；
- 默认资源部分创建后的幂等恢复与外部 VM 对账；
- 插件非法入口、路径逃逸、符号链接、哈希变化、工具名冲突和版本不兼容；
- 插件测试失败、加载失败、crash-loop、禁用和回滚；
- 项目 A 启用后项目 B 不可见，Subagent 继承范围正确；
- AI 自动注册、等待启用确认、当前项目自动启用、跨项目拒绝；
- 插件尝试调用未授权 Broker、过期令牌和撤销令牌；
- Linux/Windows Guest 支持矩阵及恢复后的扩展快照一致性。

## 10. 非目标

本方案首版不做：

- 删除现有高级项目、VM、存储和模型管理；
- 为普通用户强制隐藏所有诊断能力；
- 默认安装大量社区扩展；
- 让模型直接执行任意宿主命令；
- 将长期 Provider Key 或机器人 Secret 传入 Guest；
- 将 Manifest 权限声明当作完整代码沙箱；
- 运行中无快照热替换扩展；
- 自动分发无合法来源的 Windows Guest 镜像；
- 绕过 BIOS、UAC、锁屏、CAPTCHA 或其他系统安全机制；
- 在首版建设插件商店、远程 Relay 或第三方宿主插件运行时。

## 11. 与现有架构的关系

本方案不改变以下既有原则：

- 本地优先，数据库、镜像、VM 和凭据仍由用户本机持有；
- Router 与 Worker 分离，直接执行仍局限于 VM；
- 长期秘密不进入 Guest；
- 同一 VM 的 AI 与人工共用 Execution Lease；
- 数据库是任务、项目和初始化事实源；
- 完成必须由 Guest 证据校验；
- Pi 优先通过固定版本 SDK/RPC 和显式扩展集成，不 Fork；
- 高级用户仍可观察、审批、接管、停止、恢复和诊断。

本方案新增的是两层产品化能力：

1. 用持久化初始化编排把现有底层能力组合成真正的一键首次使用；
2. 用版本化插件平台把现有 Pi 扩展入口发展成用户和 AI 都能安全参与的扩展生态。

## 12. 首版实现索引与验证边界

主要实现位置：

- `services/control-plane/src/bootstrap/`：持久化初始化状态、模型验证衔接、宿主 Router Pi 预检、镜像下载进度、默认 VM/项目创建和恢复；
- `services/control-plane/src/models/model-validation.service.ts`：有界、无秘密回显的真实 Provider/模型验证；
- `services/control-plane/src/router/router-runtime.service.ts`：宿主 Router Pi 的 `--version` 有界预检，未通过时不宣称 Conversation Ready；
- `packages/plugin-runtime/`：严格 Manifest、包检查、内容哈希和内置插件模板；
- `services/control-plane/src/plugins/`：不可变注册、作用域启用、会话快照、Guest 传输和开发 Broker；
- `packages/agent-runtime/src/pi-engine.ts`：Guest 包落盘、完整性复核、显式扩展加载和快照恢复；
- `packages/agent-runtime/extensions/plugin-development-extension.js`：AI 脚手架、真实 `npm test`、注册和按授权启用；
- `scripts/package-router-runtime.mjs`：固定版本的宿主 Router Pi 与 Windows/Linux 生产依赖；
- `apps/web/src/OnboardingWizard.tsx`、`BootstrapMonitor.tsx`、`PluginManager.tsx`：两步向导、后台状态和高级插件管理。

自动化验证覆盖模型请求分类、初始化幂等/取消/恢复、插件路径与哈希、注册不可变、作用域隔离、Guest 传输完整性、真实模板测试和开发 Broker 令牌权限。

以下仍需对应环境验收，不能由本机模拟测试替代：

- 干净 Windows/Linux 安装包中的宿主 Router Pi 实际启动；
- WHPX/KVM、QEMU 托管下载、真实镜像和 cloud-init 的完整首次初始化；
- 真实模型 Provider 的验证请求及 Worker Computer Use；
- Development Worker 在真实 Linux/Windows Guest 中的模板、npm 测试和插件加载；
- 长任务中的令牌续期策略、共享 VM 影响和长时稳定性。
