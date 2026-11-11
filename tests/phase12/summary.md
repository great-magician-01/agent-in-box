# 阶段 12 验收记录：Linux 安全、故障、升级与全链路验收

日期：2026-11-11

## 结论

阶段 12 完成了本轮可在本机自动化验证的安全、故障、升级和性能加固：

- 新增数据库迁移前备份：存在待应用迁移时，先创建 SQLite 在线备份、执行 `integrity_check`、写入 SHA-256 和保留策略，任一失败都停止启动；
- 新增本机诊断报告 API 与 Web 导出入口：包含版本、迁移、数据库计数、备份、资源、设置和日志尾部，导出前对访问密钥、Bearer、Provider Key、机器人 Secret、会话 Cookie 等形状做结构化与文本脱敏；
- 控制平面未知异常不再把原始堆栈返回给 HTTP 客户端；桌面日志对捕获到的控制平面日志行也做凭据形状脱敏；
- 新增阶段 12 索引迁移，覆盖状态/Worker/项目维度的大历史查询；
- 新增 `pnpm smoke:phase12`，使用真实控制平面、SQLite、静态 Web 构建、迁移备份/恢复、崩溃对账和 2001 条任务历史完成 12 项检查；
- 新增 Linux 全链路验收任务集、安全测试矩阵和用户/机器人/存储/隐私文档。

`pnpm smoke:phase12` 12 项通过；`pnpm check` 通过。机器结果见 [`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。

**边界说明**：本轮没有真实 QEMU/WHPX Linux Guest、真实 Pi 进程/模型、真实飞书/QQ 应用凭据、Windows NSIS 安装、真实 HTTPS 更新源或长时 soak。`smoke:phase12` 中的 VM/Worker 是持久数据库 Fixture，不替代 `full-chain-tasks.json` 的真实任务验收。真实 Guest 网络边界（宿主回环、内网、云元数据地址）仍是发布门槛。

## 12.1 安全测试

### 已实现的加固

1. **迁移前备份**（`services/control-plane/src/persistence/migration-backup.ts`）
   - 仅在已有数据库且存在 pending migration 时触发；
   - 备份写入 `backups/pre-migration-*.sqlite`，使用 `.partial` + rename，避免半成品被当成备份；
   - 备份后以只读方式执行 `PRAGMA integrity_check`，再计算 SHA-256 并写 `.sha256`；
   - 默认保留 5 份，`AGENT_IN_BOX_MIGRATION_BACKUP_KEEP` 可调（1～50）；
   - 备份失败、完整性失败或校验和写入失败都会抛错并阻止 Schema Migration。
2. **诊断报告**（`GET /api/v1/diagnostics`）
   - 需要本机登录或 Bearer；响应 `Cache-Control: no-store`；
   - 包含 `warning`、产品/协议/Node 版本、平台、数据根、配置/日志路径、数据库 quick check、已应用/待应用迁移、迁移备份、表计数、任务/VM/Worker/镜像状态计数、待发布 Outbox、未读通知、资源/安全/Worker 策略和日志尾部；
   - 日志尾部最多读取 256 KiB（`AGENT_IN_BOX_DIAGNOSTICS_LOG_BYTES` 可调），按文件尾部截断；
   - 结构化对象按 secret/token/password/apiKey/authorization/credential/cookie/accessKey 等键脱敏；文本按 `aib_`、`sk-`、`sk-ant-`、Bearer/QQBot、URL token、JSON/键值 Secret、`aib_session` 等形状脱敏；
   - 不读取、不输出访问密钥内容；只报告密钥文件是否存在。
3. **错误与日志脱敏**
   - `ApiExceptionFilter` 对 `PersistenceError`、`HttpException` 和未知异常的 message 做文本脱敏；
   - 未知异常不再向 HTTP 返回原始消息或堆栈，只返回通用错误提示；脱敏后的堆栈只写本地日志，并提示用户导出诊断报告；
   - `apps/desktop` 日志对捕获的控制平面 stdout/stderr 行做同样的凭据形状脱敏。
4. **查询索引**：`011_phase12_hardening` 增加 `tasks(status, created_at)`、`tasks(assigned_worker_id, created_at)`、`workers(status, created_at)`、`workers(project_id, vm_id)`。

### 测试覆盖

| 项目 | 证据 | 状态 |
| --- | --- | --- |
| Renderer → Supervisor 权限边界 | 阶段 2/11 桌面测试与打包 Smoke；preload 白名单 | 自动化通过 |
| 本地 API 认证/CSRF/Origin/Host | 阶段 11 `auth.test.ts`；`smoke:phase12` 未认证 401、伪造 Host 403、跨端口 Origin/跨站 Sec-Fetch-Site 403 | 通过 |
| WebSocket 认证 | 阶段 11 匿名连接 401、跨源 403 | 通过 |
| Guest RPC/VNC/Guest Agent 鉴权 | 阶段 4/6 RFB、Lease、Bearer、动作去重测试与 Smoke | 自动化通过 |
| 机器人鉴权/去重/白名单 | 阶段 10 测试与 `smoke:phase10` | 协议替身通过 |
| VM 访问宿主机/内网/元数据 | 本阶段记录 QEMU user networking 边界；未在真实 Guest 执行 | **未关闭** |
| 恶意网页/文件提示词注入 | 阶段 7 Policy/审批与完成证据测试；真实模型注入评测未执行 | **部分覆盖** |
| 审批绕过/路径穿越/文件交换/密钥泄露 | 阶段 9/11 路径与 SHA-256 测试；阶段 12 诊断/日志脱敏测试 | 自动化通过 |
| 日志和截图敏感信息 | 日志轮转、正则脱敏、诊断导出测试；截图仅认证 API 访问 | 自动化通过 |

逐项安全边界与剩余验收见 [`security-matrix.md`](security-matrix.md)。

## 12.2 故障与恢复测试

### 本轮自动化验证

`smoke:phase12` 在真实控制平面进程中完成：

1. 创建项目、VM、Worker、运行中任务和 Execution Lease；
2. 在任务和 Worker 均处于运行状态时 SIGKILL 控制平面后重启；
3. 重启对账把 Worker 标记 `failed`/`control_plane_restarted`，运行任务标记 `failed`/`worker_runtime_restarted`，`currentTaskId` 清空，Lease 释放；
4. 任务 `attemptCount` 保持 1，没有重复创建或盲目重放；
5. 任务 Trace 中存在 `worker.runtime_restarted` 事件；
6. 迁移前备份创建并通过完整性校验；复制备份恢复主数据库后，项目、2001 条任务历史和迁移记录重新可用。

### 覆盖矩阵

| 故障场景 | 当前证据 | 状态 |
| --- | --- | --- |
| Control Plane 崩溃/重启 | `smoke:phase5`、`smoke:phase11`、`smoke:phase12` | 通过 |
| Supervisor 崩溃接管 | 阶段 0 真实 QEMU 验证、阶段 3 Go 测试 | 真实验证过；未在本轮复跑 |
| Guest Agent 断线/心跳 | 阶段 4 测试；Worker RPC 断线阶段 6/7 | 自动化通过 |
| Worker/Pi 回合中断 | 阶段 6/7/8 测试；阶段 12 重启对账 | 自动化通过 |
| VM 崩溃/宿主机重启/断电 | 阶段 0 部分快照与 Provider 重启；本轮未做断电模拟 | **未关闭** |
| 断网/下载中断 | 阶段 3 强制结束控制平面后自动续传；阶段 3 测试 | 自动化通过；真实 CDN 未验收 |
| 磁盘不足 | Storage Manager 空间/写入检查与提示 | 自动化通过；未做真实写满演练 |
| 迁移中断 | Storage Manager 失败回滚、锁、旧目录保留测试 | 自动化通过 |
| 快照损坏/数据库恢复 | 阶段 12 备份完整性/恢复；阶段 9 快照影响测试 | 自动化通过；真实 qcow2 损坏未验收 |
| 机器人重连/重复事件 | 阶段 10 持久去重、重启后继续消费 | 协议替身通过 |
| 任务执行中人工接管/取消 | 阶段 4 Lease、阶段 7 审批/取消、阶段 9/11 测试 | 自动化通过 |

## 12.3 Linux 性能和资源测试

`smoke:phase12` 在当前 Windows 11 开发机（Node.js 22.22.0）写入 2001 条任务和 500 条 Router 消息后测量：

- `GET /api/v1/tasks/board`：2001 条任务，64 ms；
- `GET /api/v1/router/messages?limit=100`：100 条，4 ms。

这些数字只用于本机回归阈值（board < 5 s、router < 3 s），不是产品容量承诺。资源不足排队、软预算和空闲休眠已有阶段 9 测试；本轮没有做多台真实 Linux VM 并行、长时内存/句柄泄漏和真实大镜像下载/迁移压测。

新增索引用于大历史下的状态/Worker/项目查询；看板仍返回完整任务快照，以保持 Web/Electron 的“打开/重连后完整对账”语义。若后续任务历史达到更大规模，应增加显式历史窗口而不是让所有端隐式截断。Router 任务/归档工具在阶段 8 已使用分页/结果上限（默认 25，最大 100），归档只保存索引与摘要引用，不会把全部归档历史注入活跃上下文。

## 12.4 Linux 全量真实任务回归

新增 [`full-chain-tasks.json`](full-chain-tasks.json)，覆盖：

- 共享 VM / 独占 VM、停止后恢复；
- Router 复用、新建、归档、恢复 Worker；
- Web、Electron、飞书、QQ；
- 执行中崩溃、取消、人工接管；
- Guest 外网/内网/元数据边界；
- 非系统盘、镜像续传、自动启动；
- 升级、迁移前备份与回滚；
- 成功、失败、人工接管和证据记录要求。

该任务集尚未在本轮执行，原因是当前环境没有阶段 0 的 QEMU/WHPX、Linux Golden Image、真实 Pi/模型和飞书/QQ 凭据。不能把 `smoke:phase12` 的 Fixture 结果当作真实任务成功率基线。

## 12.5 Linux 全链路验收构建

### 已具备

- 依赖、Pi、镜像、协议版本和构建命令已在前序阶段文档与 `bundle.json` 中固定；
- 可生成 Control Plane 自包含 bundle、Worker Runtime tar.gz + `.sha256`、Windows portable/NSIS 构建命令；
- 新增 `pnpm release:checksums`：扫描 release 下的安装包/压缩包和 Control Plane `bundle.json`，校验已有 `.sha256` sidecar，生成 `release/SHA256SUMS` 与 `release/build-manifest.json`；签名仍需要外部证书；
- 升级前数据库备份、迁移和回滚路径有自动化测试；
- 新增 Linux 版本用户指南、机器人配置指南、存储指南和隐私说明；
- 新增本机诊断报告与反馈排查路径；
- 明确本构建是 **Linux 全链路里程碑**，不是本期最终完成声明。

### 本轮未关闭的发布门槛

1. 干净 Windows Host 上执行 NSIS 安装、升级、回滚和卸载，并生成带签名的测试安装包与校验信息；
2. 真实 QEMU/WHPX + Linux Golden Image + noVNC 人工操作回归；
3. 真实 Pi/模型 Computer Use 与 Router 任务集重复运行，形成成功率/接管率/卡死率基线；
4. 真实飞书/QQ 应用凭据和平台权限矩阵；
5. 真实 HTTPS 更新源和更新替换/回滚；
6. 长时间运行、内存/句柄泄漏、断电和多 VM 资源压力；
7. 真实 Guest 对 `10.0.2.2`、内网和云元数据地址的网络边界验证。

## 自动化与真实进程证据

- `pnpm smoke:phase12` 12 项通过：
  1. 控制平面启动并保持回环监听；
  2. Host/Origin/Sec-Fetch-Site 边界与未认证 API 拒绝；
  3. 静态 Web 安全头生效且没有宽松 CORS；
  4. Cookie 会话写操作强制 CSRF，Bearer/Cookie 认证可用；
  5. 诊断报告认证、迁移/计数/日志与凭据脱敏；
  6. Router 工具面不包含宿主命令、Shell 或 VM 输入能力；
  7. 运行任务状态下 SIGKILL 控制平面，Fixture 与待应用迁移已持久化；
  8. 迁移前备份完整性校验和 SHA-256；
  9. 崩溃后任务安全失败、Worker 对账、Lease 释放、不重放；
  10. 2001 条任务看板与 Router 消息查询性能；
  11. 使用备份恢复数据库；
  12. 恢复后项目、任务历史和迁移记录可用。
- `migration-backup.test.ts`：无迁移不备份、备份先于迁移、数据保留、SHA-256、保留策略、迁移幂等，以及备份写入失败时阻止继续。
- `diagnostics.service.test.ts`：计数、迁移、quick check、日志脱敏、备份列表、访问密钥不出现在报告中。
- `redaction.test.ts` / `api-exception.filter.test.ts` / 桌面 `logger.test.ts`：凭据形状脱敏、错误响应不泄露堆栈。
- 阶段 2～11 Smoke 在阶段 12 迁移/存储布局变更后已全部重跑通过；CI 已增加阶段 12 Smoke 与结果 artifact。

## 复现

```bash
pnpm check
pnpm smoke:phase12
pnpm smoke:phase2
pnpm smoke:phase3
pnpm smoke:phase4
pnpm smoke:phase5
pnpm smoke:phase6
pnpm smoke:phase7
pnpm smoke:phase8
pnpm smoke:phase9
pnpm smoke:phase10
pnpm smoke:phase11
```

机器结果可另存到 `AGENT_IN_BOX_PHASE12_RESULT`；设置 `AGENT_IN_BOX_PHASE12_KEEP=1` 可保留临时数据目录用于排查。
