# Agent-in-Box 用户指南（Linux / Windows）

> 适用版本：0.1.0 阶段 13 代码与自动化构建
> 本文描述当前已实现的行为。真实 Linux/Windows 镜像、模型和机器人凭据仍需按验收环境配置。

## 1. 安装与首次启动

1. 在 Windows Host 上运行安装包。当前为 per-user 安装，不需要管理员权限。
2. 首次启动只需确认或改选数据保存目录，然后选择服务商、填写 API Key 和默认模型。保存时会执行一次最小模型验证；长期凭据保存在宿主 OS 安全存储（Electron `safeStorage`），不会写入 VM。
3. 验证通过后直接进入主会话。应用在后台自动准备 QEMU、默认 Linux VM、Guest Runtime 和“我的工作区”；可对话与可执行状态分开显示，任务可以提前排队。
4. 资源、自动启动、敏感操作审批和关闭行为使用安全默认值，可在高级设置中修改。关闭窗口默认继续在托盘运行。
5. 只有虚拟化功能、管理员授权、系统重启、网络或模型配置需要用户处理时，后台状态条才显示对应操作。高级“运行环境”页仍可选择已有 QEMU、查看 Supervisor 和执行恢复。
6. 桌面发布包内置宿主 Router Pi 运行时；普通用户不需要全局安装 Node、Pi 或开发工具。

首次启动后，控制平面在配置目录生成 0600 的 `web-access-key`。浏览器打开本机地址时需要粘贴该密钥；Electron 由 Main 自动登录，Renderer 不接触密钥。

## 2. 数据目录与空间

- 应用配置：Windows `%APPDATA%\AgentInBox`；Linux `~/.config/agent-in-box`；macOS `~/Library/Application Support/AgentInBox`。
- 默认数据根：Windows `%LOCALAPPDATA%\AgentInBox`；首次向导会要求确认或改选。
- 大文件全部位于数据根：`images/`、`downloads/`、`vms/`、`snapshots/`、`artifacts/`、`archives/`、`inbox/`、`backups/`。
- 存储页显示分类占用、可用空间、存储锁和迁移状态。迁移会复制并逐个校验文件、在线备份 SQLite、更新配置；旧目录不会自动删除。
- 备份目录保存数据库迁移前自动备份；默认保留 5 份。

更完整的存储操作见 [存储指南](06-storage-guide.md)。

## 3. 下载镜像与创建 Linux/Windows VM

1. 首次初始化会自动创建默认 Linux VM 和项目绑定；高级“虚拟机”页仍可使用“一键创建 Linux 工作 VM”手动下载并校验版本化 Ubuntu 24.04 Cloud Image、创建 4 vCPU / 8 GiB / 40 GiB VM、启动并通过 cloud-init 安装 XFCE、Guest Agent、Node/Pi 与 Worker。首次初始化通常需要 5～20 分钟，页面会显示当前阶段。
2. 也可以手动下载镜像、创建 VM 后再启动。下载显示进度、速度和错误；中断后重新开始会从已下载部分续传，校验不通过的文件不会启用。
3. 默认 Manifest 只包含 Linux 基线；Windows Golden Image 需要通过 `AGENT_IN_BOX_IMAGE_MANIFEST` 指向内部 Manifest。Windows Guest 至少需要 4 GiB 内存和 32 GiB 磁盘。
4. Linux 项目默认 Guest 工作目录为 `/home/aib-worker/workspace`，与 Worker runtime 的安装目录一致；如使用自定义镜像，请在项目绑定中改为实际路径。
4. VM 电源状态与 Guest 健康状态分开显示。`running` 不等于 Guest Agent 一定健康。
5. 停止 VM 使用 ACPI 优雅关机；强制停止可能丢失 Guest 内未保存数据。
6. Windows 镜像必须来自合法 ISO、评估镜像或内部 Golden Image；构建和 token 注入步骤见 [Windows Guest 资产](../images/windows/README.md)。

## 4. 项目、任务与 Worker

1. 新建项目并绑定一个或多个 VM，指定 Guest 工作目录和主 VM。
2. 在项目页创建任务，填写可验证的目标。任务会持久入队，同一 VM 同时只有一个运行中/待审批/待人工处理任务。
3. Worker 由 Router 或项目页启动；创建后 Worker 在 Guest 内运行 Pi，宿主只持有短期 Broker 令牌。
4. 任务看板可按项目、VM、Worker 和状态筛选；任务详情显示 Trace、截图、审批和产物。
5. 完成必须由 Guest 文件/进程证据或重新截图验证；模型自述“完成”不会自动把任务置为完成。
6. 取消、重试、批准/拒绝和人工接管都要求明确操作；人工控制台输入会抢占 AI Lease，旧 AI 动作会被拒绝。
7. 遇到手机扫码、图片 CAPTCHA、发到用户手机的短信/验证器码或 Passkey 等需要本人设备的验证步骤，Worker 会暂停任务并发出通知。普通登录、任务材料中已提供的验证码和确认按钮由 Worker 直接处理。
8. 收到人工处理通知后，在任务详情查看 Worker 提交的截图：二维码可手机直接扫；需要输入时打开实时控制台并“人工接管”。处理完成后关闭控制台并点击“人工已处理，恢复任务”；任务重新排队，Worker 会重新截图观察后继续。

## 5. 主会话（Router）与模型配置

- 主会话是宿主侧 Pi Router，可查询项目/任务/Worker/看板/归档，并通过结构化工具创建和分派任务。
- Router 不拥有 Shell、宿主文件系统、VM 输入或 Supervisor 工具。
- Router 可以复用现有 Worker、新建 Worker、归档空闲 Worker，并在需要时恢复会话；恢复时会注入最新截图和离开期间的环境变化。
- 归档不会删除任务或 Router 历史消息；恢复后仍需重新观察桌面。
- “设置 → 模型与 API 配置”可以保存多套 Provider（配置名、Base URL、API 类型、模型白名单、凭据引用），并分别选择新 Worker 默认模型和 Router 模型。Router 空闲时可“应用并重启会话”，下一次发送使用新模型；已有 Worker 需要“切换模型（归档并新建会话）”。运行中的 Router 不能切换。
- 长期 API Key 只通过桌面应用保存到系统安全存储；设置页只显示凭据是否已保存，不读取或回显密钥。

### 插件与 AI 插件开发模式

- “设置 → 插件”可以导入包含 `manifest.json` 的本地插件目录。导入只读取、校验并复制文件，不执行插件；注册版本不可变，启用按项目或 Worker 授权。
- 新建或恢复 Worker 时生成扩展快照；插件变更只影响后续会话，不热替换正在执行的任务。恢复原 Worker 时继续使用其原快照。
- 需要 AI 开发插件时，在插件页选择项目并显式创建 Development Worker。AI 可在 Guest 内使用模板、文件和 Shell 编写插件，并通过内置工具实际执行 `npm test` 后注册。
- “允许 AI 在当前项目自动启用”是创建 Development Worker 时的单独选项。未开启时，AI 只能完成开发、测试和注册，启用由本机用户操作；任何模式都不允许 AI 跨项目或申请任意宿主权限。
- 插件测试代码只在显式授权的 Guest Development Worker 中运行，不在 Electron 或宿主 Control Plane 中执行。插件仍共享该 VM 的系统和项目环境，不构成独立安全沙箱。

## 6. 实时控制台与观察栏

- 应用采用三栏工作区：左侧项目与 Worker 会话，中间 Router/Worker 会话，右侧观察栏默认隐藏。点击顶栏“观察栏”或左侧“观察”可打开。
- 观察栏的“VM 画面”是 **只读观察**：不获取 Execution Lease，也不会向 Guest 转发键盘、鼠标或剪贴板；可以一边观察 Agent 操作，一边保持 AI Lease。
- 只有点击“人工接管”并确认后，才打开交互控制台并获取 human Lease；AI 需要重新获得 Lease 才能继续。
- VM 页面的交互 noVNC 控制台使用回环一次性票据；票据失效后不能继续输入。
- Windows Guest 出现锁屏或 UAC 安全桌面时，AI 截图/输入会被拒绝并返回 `session_locked`/`secure_desktop`，任务进入 `blocked`。请在控制台人工解锁或处理 UAC，然后让 Worker 重新观察；`Ctrl+Alt+Del` 只能人工操作。

## 7. 通知、Web 与桌面

- 通知中心汇总任务、审批、Worker、VM、资源、Router 和机器人事件，支持已读/移除和全部已读。
- Electron 支持托盘状态、启动/停止/重启本地服务、桌面通知、开机启动和更新检查。
- 浏览器只支持本机回环访问。非回环监听会被控制平面拒绝；远程访问需要后续独立 Relay，不是当前功能。
- 文件投递区可拖放上传文件到宿主 `inbox/`，但不会自动复制进 Guest。

## 8. 更新与回滚

1. 在设置页填写 HTTPS 更新 Manifest 地址（开发测试允许回环 HTTP）。
2. 检查更新、下载并校验 SHA-256；失败不会留下可安装文件。
3. 安装前会停止本地服务，并备份数据库与已安装应用资源。
4. 更新后启动新版本；如果失败，可在设置页执行回滚。
5. Windows 上运行时替换 `app.asar` 等资源可能受文件锁影响，干净安装环境的升级/回滚仍需按验收清单执行。

## 9. 诊断与反馈

- 设置页“导出本机诊断报告”会生成 JSON，包含版本、迁移、数据库计数、备份、资源、设置和最近日志。
- 报告可能包含本机路径、错误片段和日志内容，属于潜在敏感信息；分享前请检查。它不会自动上传。
- 控制平面未知错误不会把原始堆栈返回给客户端；请导出诊断报告并查看日志目录。
- 日志目录由托盘/设置页的“打开日志目录”打开；桌面日志自动轮转。

## 10. 常见问题

| 现象 | 排查 |
| --- | --- |
| 浏览器提示需要登录 | 打开配置目录的 `web-access-key`，粘贴到解锁页；不要发送给他人 |
| VM 显示运行但控制台黑屏 | 检查 Guest 健康、显示栈和 noVNC 连接；必要时查看 Guest Agent 日志 |
| 任务一直等待资源 | 检查 Host Reserve、软预算和正在运行的 VM；降低并发或调整资源策略 |
| 任务失败并提示 `control_plane_restarted` | 控制平面重启导致 Worker 回合中断，属于安全失败；确认桌面状态后重试或恢复 Worker |
| 更新下载失败 | 检查 Manifest HTTPS、大小、SHA-256 和网络；失败文件不会安装 |
| 磁盘空间不足 | 在存储页清理下载缓存；迁移到非系统盘前先确认目标空间 |

## 11. 当前明确限制

- Linux 全链路验收构建仍需要真实 QEMU/WHPX、Golden Image、Pi/模型和机器人凭据验收。
- Windows Guest 代码与自动化主链路已落地，但真实 Windows ISO 安装、WHPX Windows Guest、截图/中文输入/UAC/锁屏/DPI、真实 Pi/模型和每 VM token 自动注入仍待验收。
- Windows 锁屏、UAC 安全桌面、Ctrl+Alt+Del 和激活界面必须人工处理；产品不绕过这些系统安全机制。
- Wayland、远程 Relay、真实更新源和长时稳定性不属于本构建已验证范围。
- 同一 VM 上的多个项目不构成强安全隔离；共享桌面/软件/系统状态会互相影响。
- Computer Use 的成功率取决于模型、镜像和任务；不要用模型自述代替结果验证。
