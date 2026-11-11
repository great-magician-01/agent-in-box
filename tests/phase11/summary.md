# 阶段 11 验收记录：Web、Electron 和安装体验完善

日期：2026-11-11

## 结论

阶段 11 的本地 Web 认证与 CSRF/Origin 防护、统一导航与通知中心、文件拖放投递、Electron 托盘/通知/开机启动/后台服务管理、更新检查与回滚、NSIS 卸载数据选择均已实现。`pnpm smoke:phase11` 使用真实控制平面、SQLite、静态 Web 构建、HTTP/WebSocket 与文件流完成 12 项检查；`pnpm check`（lint、typecheck、Vitest、Go 测试、构建）通过。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realBrowserUi=false`、`realElectronUi=false`、`windowsNsisInstall=false`、`realAutoUpdateFeed=false`、`relay=false`。

**边界说明**：本轮没有执行真实浏览器/Electron 人工可用性与可访问性验收，没有在干净 Windows 环境安装 NSIS 包，没有连接真实更新源，也没有实现远程 Relay。桌面更新的下载/校验/数据库与资源备份逻辑有单元测试覆盖，但安装程序实际替换文件仍属于打包验收门槛。

## 11.1 完整本地 Web UI

### 认证与会话

- 控制平面首次启动在配置目录创建 `<config-dir>/web-access-key`（0600），密钥只通过文件与本机 Bearer 自动化使用，不写入日志、SQLite 或 VM。
- `POST /api/v1/auth/login` 使用常量时间比较密钥；失败按来源 IP 计数，5 次后限速 30 秒；成功创建 SQLite `auth_sessions`（只存 SHA-256）并返回 `HttpOnly; SameSite=Strict` 会话 Cookie。
- 会话保存在 SQLite，控制平面重启后仍然有效；默认 TTL 30 天，过期自动清理。`POST /api/v1/auth/rotate` 更换密钥并撤销其他会话。
- Electron Main 读取本机密钥并自动把会话 Cookie 注入 Renderer 的 Cookie Jar；沙箱 Renderer 永远不接触访问密钥。浏览器用户首次打开时在解锁页粘贴密钥。
- 受保护 API 统一经过全局 AuthGuard。健康检查、静态资源和认证入口是公开的；其余所有项目、任务、VM、Worker、机器人、通知与文件 API 都需要认证。

### CSRF 与本地 Web 防护

- 移除宽松 CORS；Web 与 Electron 始终同源访问。恶意本机网页不能读取响应，也不能发送自定义 CSRF 头。
- 所有写请求（POST/PUT/PATCH/DELETE）在 Cookie 会话下必须携带与当前会话绑定的 `x-agent-in-box-csrf`；Bearer 自动化凭据不依赖 CSRF。
- 校验 `Host` 必须是回环地址；存在 `Origin` 时必须与请求 Host 完全一致；`Sec-Fetch-Site` 只允许 `same-origin`/`none`。因此 `http://127.0.0.1:其他端口` 的恶意页面也会被拒绝。
- 事件 WebSocket 要求有效会话，并要求 Origin 与 Host 一致；匿名连接返回 401，跨源连接返回 403。
- 静态页面设置 CSP、`X-Frame-Options: DENY`、`Cross-Origin-Resource-Policy`、`Permissions-Policy` 和 API `Cache-Control: no-store`。

### 页面与导航

- 主导航：总览、主会话、项目、任务、虚拟机、归档、通知、设置；Hash 路由支持刷新与 Electron 托盘跳转。
- 主会话使用 Router 会话；项目页包含项目绑定、项目 Worker 会话、项目备份和文件投递；任务页复用持久任务看板、Trace 与审批；VM 页复用生命周期与控制台；归档页复用 Worker Registry 和 Archive 搜索。
- 设置页包含资源策略、存储、运行信息、桌面服务、桌面通知、开机启动、更新/回滚、本机身份与访问密钥轮换。
- 统一通知中心把任务、审批、Worker、VM、资源、Router、机器人事件投影为可读通知，支持全部/未读筛选、单条已读、全部已读和移除。
- 基础可访问性：跳转到主要内容、`header/nav/main/footer` landmark、`aria-current`、`aria-live`、`role="alert"`、可见焦点、表单 label、`visually-hidden` 与减少动画媒体查询。窄屏下导航横向滚动、网格与操作区折叠。

## 11.2 Electron 与后台服务

### 托盘、通知、开机启动

- 托盘菜单显示本地服务状态，支持启动/停止/重启、打开通知中心、开机启动、桌面通知、检查更新和退出。
- 桌面通知由渲染进程在收到新未读通知时通过白名单 IPC 请求 Main 显示；通知 ID 去重并持久化已提示集合；点击通知会显示主窗口并跳转通知中心。设置中可关闭桌面通知。
- 开机启动使用 Windows/macOS `setLoginItemSettings` 或 Linux `~/.config/autostart/agent-in-box.desktop`，以 `--hidden` 启动到托盘；设置持久化在 `app-config.json`。
- 关闭窗口行为（后台运行/退出）继续由窗口关闭策略控制。

### 后台服务状态

- 渲染进程可通过白名单 IPC 启动、停止、重启本地 Control Plane；状态、pid、最近错误在桌面条、设置页和托盘中可见。
- Control Plane 异常退出、渲染进程崩溃和子进程退出继续记录结构化日志。

### 文件拖放

- 项目页新增文件投递区：可拖放或选择文件，流式上传到数据根目录 `inbox/`，记录原始文件名、大小、SHA-256、项目关联和时间。
- 服务端清洗路径与文件名、限制单文件大小（默认 256 MiB，`AGENT_IN_BOX_INBOX_MAX_BYTES`）、记录元数据并支持列表、下载和删除。
- 文件不会自动复制进 Guest；需要 Guest 使用时仍由 Worker 或人工传输。这是有意的安全边界。

### 自动更新与回滚

- 更新源为 HTTPS Manifest（开发测试允许回环 HTTP），包含版本、说明和按平台/架构区分的安装包 URL、SHA-256、大小和可选安装参数。示例：

  ```json
  {
    "version": "0.2.0",
    "notes": "更新说明",
    "files": [
      {
        "platform": "win32",
        "arch": "x64",
        "url": "https://updates.example.com/agent-in-box-0.2.0-x64.exe",
        "sha256": "64 位十六进制 SHA-256",
        "sizeBytes": 123456789,
        "installArgs": ["/S"]
      }
    ]
  }
  ```

- `UpdateManager` 检查版本、流式下载、限制大小、校验 SHA-256；失败不会产生可安装文件。
- 安装前停止 Control Plane，备份 SQLite 主库/WAL/SHM，并快照已安装的 `app.asar`、`app.asar.unpacked`、`control-plane`、`web`；记录 pending 更新和回滚快照后启动安装程序并退出。
- 更新成功启动后清除 pending；回滚会恢复数据库和已安装资源并重启应用。Windows 上替换仍被 Electron 打开的资源文件可能受文件锁影响，需在干净 Windows 安装环境显式验证。
- 设置页展示当前/可用版本、下载进度、错误、安装和回滚入口；托盘菜单可触发检查更新。

### 安装器与卸载

- NSIS 保持 per-user 安装、可选安装目录、桌面/开始菜单快捷方式，`deleteAppDataOnUninstall: false`。
- 安装完成提示首次启动向导将选择数据目录、Host Reserve、VM 自动启动和审批设置。
- 卸载时主动询问是否删除数据，默认“否”；只有用户选择“是”才调用应用 `--uninstall-clean-data --yes`。
- 数据目录删除前必须存在控制平面写入的 `.agent-in-box-data-root` 标记，且拒绝文件系统根目录、用户主目录及其上级目录；配置目录只删除应用拥有的文件，不删除未知文件。

## 11.3 远程 Web 边界

- 阶段 11 只提供本机回环 Web；`CONTROL_PLANE_HOST` 不是回环地址时控制平面拒绝启动并提示远程访问必须通过后续独立、可选、加密的 Relay 与设备授权。
- 没有实现 Relay，也没有把 Relay 作为本地核心、机器人长连接或通知的前置依赖。无 Relay 时全部本地功能可用。
- 远程访问不会要求用户自行开放路由器端口；该能力仍待后续阶段设计和验收。

## 自动化与真实进程证据

- 全仓 `pnpm check` 通过。
- 新增控制平面测试：
  - `auth.test.ts`：访问密钥权限、错误密钥限速、Bearer 凭据、轮换、SQLite 会话过期、Origin/Host/Sec-Fetch-Site 校验。
  - `notifications.test.ts`：Outbox 投影、去重、已读/移除、历史事件不回放、审批/资源映射。
  - `inbox.test.ts`：文件校验和、项目过滤、流式下载、大小限制、路径穿越清洗。
  - `events.service.test.ts`：WebSocket 会话认证与匿名拒绝。
- 新增桌面测试：
  - `updates.test.ts`：版本比较、Manifest 校验、HTTPS/回环限制、下载/SHA-256、资源与数据库快照恢复。
  - `control-plane-auth.test.ts`：Main 自动登录、Cookie 注入和复用。
  - `phase11-desktop.test.ts`：偏好持久化、Linux autostart、Windows/macOS 登录启动、卸载数据标记与安全删除。
- `pnpm smoke:phase11` 12 项通过：
  1. 控制平面启动并保持回环监听；
  2. 静态 Web 可加载，CSP/安全头生效且没有宽松 CORS；
  3. 未登录 API 返回 401；
  4. 错误密钥被拒绝，正确密钥建立 HttpOnly + SameSite=Strict 会话；
  5. Cookie 写操作必须携带 CSRF；
  6. 跨端口 Origin、same-site 请求被拒绝，Bearer 可用于本机自动化；
  7. 事件 WebSocket 要求有效会话；
  8. Outbox 只投影一次到通知中心并支持已读/移除；
  9. 文件投递的上传、命名清洗、大小限制、SHA-256、下载和删除；
  10. 控制平面重启后会话与通知游标仍然有效；
  11. 更换访问密钥后旧密钥/旧会话失效；
  12. 连续错误密钥触发限速。
- 阶段 2～10 Smoke 全部在阶段 11 认证改造后重新运行通过。
- CI 增加 phase 11 Smoke 与结果 artifact。

## 未关闭的限制

1. **真实浏览器/Electron 人工 UI 未验收**：本轮完成生产构建、HTTP/WS 和自动化 API 检查，没有进行真实浏览器与打包 Electron 的人工布局、键盘、屏幕阅读器和响应式验收。
2. **Windows NSIS 未在干净 Windows 环境安装验收**：自定义卸载脚本、数据删除选择、安装提示和更新替换仍需在 Windows 上实际执行。本轮尝试重建 Linux 目录包时 electron-builder 下载依赖超时，因此没有重新执行 `pnpm smoke:desktop`；保留的旧目录包不包含阶段 11 代码。
3. **真实更新源未验收**：Manifest 和下载协议有本地服务测试；没有真实的 HTTPS 发布源、签名校验（当前依赖 SHA-256 与 HTTPS）和失败回退演练。
4. **Windows 回滚文件锁**：回滚在应用运行时替换 `app.asar` 等资源；Windows 可能因文件锁失败。需要打包环境验证，必要时改为退出后由外部助手替换。
5. **文件投递不进入 Guest**：投递文件保存在宿主数据目录，不会自动传输到 VM；没有实现拖放直接附加到 Worker 任务。
6. **通知只面向本机管理员**：没有多用户通知偏好、按项目订阅或邮件/外部推送。
7. **原生通知依赖渲染进程存活**：窗口关闭到托盘时渲染进程仍在，因此通知可用；如果渲染进程被销毁（macOS 关闭窗口的默认行为等），Main 不会独立轮询通知。
8. **限速是进程内状态**：控制平面重启后登录失败计数清零；由于仅回环监听，当前风险可接受。
9. **未实现远程 Relay**：仅完成边界确认和拒绝非回环监听的保护；设备授权、端到端加密和 Relay 拓扑不在本轮范围。
10. **前端包体较大**：生产构建单个 JS chunk 约 696 kB，未做路由级代码分割；不影响功能，但后续应拆分 noVNC/大面板。
11. **Web 与 Electron 功能差异**：桌面服务管理、开机启动、原生通知、更新/回滚和目录选择只在 Electron 提供；这是明确的桌面系统能力差异。

## 复现

```bash
pnpm check
pnpm smoke:phase11
pnpm smoke:phase2
pnpm smoke:phase3
pnpm smoke:phase4
pnpm smoke:phase5
pnpm smoke:phase6
pnpm smoke:phase7
pnpm smoke:phase8
pnpm smoke:phase9
pnpm smoke:phase10
```

机器结果可另存到 `AGENT_IN_BOX_PHASE11_RESULT`。CI 不连接真实更新源、不执行 Windows 安装、不实现远程 Relay。
