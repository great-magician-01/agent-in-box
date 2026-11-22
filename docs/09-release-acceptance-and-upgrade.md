# 发行、升级与验收说明

> 适用于本轮安全加固后的代码（Worker RPC 协议 `0.2.0`）。

## 1. 协议与兼容性变更

- **Worker RPC 协议从 `0.1.0` 升到 `0.2.0`**。Prompt 现在携带
  `WorkerTurnContext { turnId, taskId, executionAttempt }`，事件必须回显同一身份；旧 Guest
  Runtime 会在握手阶段被明确拒绝，不再静默忽略新字段。升级 Desktop 后必须重新打包并部署
  Guest Runtime（`pnpm package:guest-runtime`）。
- **任务执行代际**写入 SQLite（追加迁移 `016_execution_generation_and_assignment`）。
  迁移沿用既有的事务与迁移前备份；旧 Token 在重启时仍全部撤销，旧证据只用于展示。
- **VM 元数据新增** `Spec.UUID`、`State.LaunchID`、`State.ProcessStartTicks`、
  `State.Transport`。新建 VM 自动生成每 VM 的 TLS 身份；旧 VM 在**下次启动**时迁移到安全
  传输：Unix 上 QMP 使用 0700 目录内的 Unix Socket，Windows 上 QMP 使用双向 TLS；
  VNC 在所有平台使用 TLS + VeNCrypt，控制面以指纹固定服务端证书并出示每 VM 客户端证书。
  已在运行的旧 VM 仍会以历史 TCP 方式被接管一次，停止并重新启动后完成迁移。
- **控制台 URL 变为 `vnc+tls://…`**。控制面代理自己完成上游 VeNCrypt，浏览器只看到
  RFB 3.8 no-auth；安全协商字节不会进入渲染进程。旧 `vnc://` 回环地址仅作为遗留兼容。
- **新增认证停止接口**：Control Plane `POST /api/v1/shutdown`（安装访问密钥 Bearer 或带
  CSRF 的会话）与 VM Supervisor `POST /api/v1/shutdown`（ACL Bearer）。Desktop 停止被接管的
  进程时使用该接口，并轮询健康检查确认进程真正退出；停止失败会保留 `failed` 状态。

## 2. 行为变更（安全默认值）

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 完成任务 | 仅凭一张新截图即可通过 | 截图只作辅助证据；需要文件/进程校验，或走人工验证 |
| Guest 插件测试 | `passed` 报告可作为注册门槛 | 报告仅作诊断信息；注册不再依赖 Guest 自证 |
| Guest 自动启用插件 | Development Token 可带 `autoEnable` | 永远拒绝；只允许本机用户在桌面启用 |
| 插件开发 Token | 可同时存在多个 | 每个 Worker 只保留一个活跃 Token |
| 人工 Console | 晚到响应可能泄漏 Lease | 被替换/关闭/卸载时立即释放 Lease |
| 外部控制平面 | 停止时直接显示“已停止” | 必须通过认证停止接口并确认健康检查消失 |
| 更新公钥 | 可用环境变量覆盖打包公钥 | 打包版只信任随包公钥；环境变量仅开发模式 |
| Runtime Manifest | 仅依赖 HTTPS | 打包版要求 Ed25519 签名，且与更新签名按用途域隔离 |
| 镜像/备份/下载 | 取消后仍可能读完大文件 | 哈希、下载、激活均响应取消 |

## 3. 数据迁移与回滚

- 升级前 Desktop 会备份 SQLite（含 WAL/SHM）与已安装资源。回滚快照现在覆盖
  `app.asar`、`app.asar.unpacked`、`control-plane`、`web`、`vm-supervisor`、
  `guest-runtime`、`router-runtime` 与公钥文件，并记录每个条目的 SHA-256 清单。
- 恢复前会先校验全部快照条目；任一文件被篡改或缺失时不会改动现有安装。
- 回滚采用 staging + 重命名切换；中途失败会尽力恢复被替换的条目，不会留下新旧混合版本。
- 旧数据库通过追加迁移升级；不修改历史迁移，升级失败时保留迁移前备份。

## 4. 发布可信链

- 发布工作流要求：tag 指向的 commit 与构建 run 的 `head_sha` 一致，且同一 commit 存在成功的
  CI run（含 `go test -race ./...`、阶段 2～14 Smoke）。
- 每类 artifact 携带 `release-provenance.json`：`{tag, sourceSha, packageVersion, workflow}`；
  与 tag 不匹配时禁止生成校验和与发布。
- 桌面安装包必须在打包时存在 `update-public-key.pem`（以及可选的
  `runtime-public-key.pem`）；缺失时打包失败，不会产出无法验证更新的版本。
- `runtime-assets.json` 由 Ed25519 私钥签名，签名覆盖
  `agent-in-box/runtime-assets/v1\n` + 规范化 JSON；更新清单使用独立用途域
  `agent-in-box/desktop-update/v1`，两者不可互相重放。
- 校验和基于固定发布计划生成（不是扫描目录），并核对 provenance 与版本号。
- 所有 GitHub Actions 固定到完整 commit SHA。

## 5. 自动化已验证 / 外部环境仍需验收

**已在仓库内自动化验证（单元/集成测试与构建）：**

- Worker turn/attempt 围栏、迟到事件、未知 Prompt 结果、CUA 动作重放、截图证据拒绝、
  审批过期/竞争、Router abort 取消在途工具。
- 迁移升级、备份/恢复租约、保留可续跑的部分恢复、镜像历史文件名、Provisioning 迟到失败。
- Guest/Token ACL 校验、`os.Root` 句柄化文件访问、归档尺寸/取消、像素与 HTTP 边界、
  QMP TLS/Unix Socket、VeNCrypt 代理、指纹不匹配拒绝、停止未确认时不标记 stopped。
- Desktop 外部实例认证停止、异步 spawn 失败、回滚清单校验与篡改拒绝、semver 预发布排序、
  Runtime Manifest 签名与归档链接拒绝。
- Web 卸载/切换时 Lease 释放、通知刷新排队、Select 模态焦点、Bot 凭据清理（jsdom）。
- SSRF 地址分类、DNS 固定连接、包装后 `ws` 版本断言、插件自动启用移除、收件箱总配额。

**仍需在对应环境人工/硬件验收（不得用 mock 结果替代）：**

- 真实 WHPX / KVM 启动、Windows Guest 与 Linux Desktop Guest 的 QMP/VNC TLS 会话。
- 不同 OS 用户的 ACL / DACL 行为（Windows 凭据文件、Linux 0600 检查）。
- NSIS 与 AppImage 的实际安装、升级、回滚（含 AppImage FUSE 不可用时的
  extract-and-run 边界）。
- 真实飞书/QQ 应用凭据、外网 DNS/TLS、证书轮换与出口防火墙。
- 真实 GitHub Release 发布（需要受保护 Secret：签名私钥与公钥；本轮未提交任何私钥，
  也未实际发布 Release）。

## 6. 验收矩阵（摘要）

| 能力 | 自动化入口 | 外部验收 |
| --- | --- | --- |
| Worker 协议 0.2.0 | `pnpm test`、阶段 6/8 Smoke | 升级后的真实 Guest Runtime |
| VM 安全传输 | `go test ./internal/qmp ./internal/vmprovider` | 真实 QEMU + Windows/Linux Guest |
| 控制面/ Supervisor 停止 | `pnpm --filter @agent-in-box/desktop test` | 实际 NSIS/AppImage 退出流程 |
| 更新与回滚 | `pnpm --filter @agent-in-box/desktop test` | 一次真实安装→升级→回滚 |
| 插件策略 | `services/control-plane` 插件测试 | 桌面端人工启用流程 |
| Bot 撤销 | `src/bots/bots.test.ts` | 真实机器人账号停用/换机 |
| 发布可信链 | `node scripts/sign-runtime-assets.mjs ...`、`release-checksums --plan` | 受保护 Secret 下的真实发布 |
