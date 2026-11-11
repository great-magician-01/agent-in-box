# 阶段 10 验收记录：飞书和 QQ 本地机器人

日期：2026-11-11

## 结论

阶段 10 的 Bot Connector 框架、飞书/QQ 适配、持久化 Ingress、身份/白名单、敏感操作确认和机器人到 Router 的完整流程已实现。平台事件先与去重键一起原子落库，再由本地 Dispatcher 处理；机器人不是独立任务事实源，自然语言消息进入同一个主 Router 会话，任务、审批与回复通过 Outbox 和持久出站队列回到来源平台会话。Web 机器人面板可配置账号、绑定/解除执行电脑、生成一次性绑定码、维护用户/群白名单并查看连接、队列和最近事件。

机器结果：[`results/2026-11-11-smoke.json`](results/2026-11-11-smoke.json)。其中 `realFeishuApp=false`、`realQqBot=false`、`realNetworkRedelivery=false`、`realRouterPi=false`、`realModel=false`、`browserElectronUi=false`；QQ 协议服务和官方飞书 SDK 对端为测试替身。

**边界说明**：本轮没有使用真实飞书/QQ 应用凭据，也没有连接真实平台网络。Smoke 使用真实控制平面、真实 SQLite、真实 Router Tool Broker、真实 HTTP/WS 协议帧和真实持久出站队列，但平台 REST/WS 服务、飞书官方 SDK 的服务端以及 Router Pi 是固定协议的测试替身；不把结果表述为真实平台权限矩阵或长时连接稳定性验收通过。

## 10.1 Bot Connector 公共框架

已实现：

- `packages/bot-connector` 新增 `DurableIngressStore` 和 `admit(key, message)`：
  - 事件去重键为 `platform:deviceId:eventId`；
  - `bot_events` 的 `dedup_key` 为主键，完整消息、原始事件、接收时间和状态在同一 SQLite 事务中写入；
  - 只有 `admit` 返回 `true` 后连接器才向平台 ACK；重复事件返回 `duplicate` 并重新 ACK，不进入处理队列。
- `BotConnectorService` 管理每个启用账号的连接器：
  - 支持连接、断开、手动重连、测试连接和账号启停；
  - 只有本机被绑定为活跃执行电脑时启动连接器（`botDeviceId` / `botActiveDeviceId`）；
  - 连接状态 `disabled/disconnected/connecting/connected/degraded`、最近连接时间、最后错误写入 `bot_accounts`；
  - 连接/断开写 Outbox `bot.connected` / `bot.disconnected`；日志统一脱敏 Secret、Bearer/QQBot 令牌和凭据 JSON 字段。
- `BotIngressDispatcherService` 持久消费 `bot_events`：
  - pending → processing → processed/failed，失败退避重试，最长处理时间回收；
  - 超过最大事件年龄（默认 30 分钟）的旧消息只记录并提示用户重新发送，不执行旧指令；
  - 控制平面重启后继续消费 pending 事件。
- `BotOutboundService` 持久化出站消息，连接未就绪时保留 pending，失败按指数退避重试，最终失败保留明确错误；长文本按平台文本上限分片。
- `BotIdentityService`：
  - `bot_identities` 绑定平台用户与本地用户（单管理员首版），支持 `admin`/`member`；
  - 一次性 `bot_access_codes`（SHA-256 存储、单次使用、默认 10 分钟过期、角色由生成者指定）；
  - 单聊按绑定身份授权；群聊必须显式加入 `bot_chats` 白名单；
  - `bot_chats.project_id` 可作为该会话的默认项目提示传给 Router。
- `BotNotificationService` 读取 Outbox 增量游标，将任务/审批/Router 回复映射为出站通知；每类通知有唯一 dedupe key，重复 Outbox 事件不会重复发送。
- `BotAccountService` 校验平台、App ID、URL、Intents 和凭据标识；Secret 只通过 Electron 凭据桥（`HostCredentialProvider`）或开发凭据文件读取，不写入 SQLite、VM 或普通日志。

逐项验收：

- [x] 事件处理与长任务解耦：平台回调只做去重/落库，AI 工作在独立异步 Dispatcher 中执行。
- [x] 重连不重复创建任务：事件 ID 持久去重，控制平面重启后仍生效。
- [x] 未授权平台用户不能操作 VM：默认拒绝，未绑定用户只能获得绑定提示，不能触发 Router 或命令。
- [x] Secret 不进入 VM 和普通日志：平台 Secret 只存系统安全存储/开发凭据文件；连接器日志与错误统一脱敏。
- [x] 一台活跃执行电脑绑定：非活跃设备不启动连接器。
- [x] 用户/群白名单与权限：管理员/只读成员、单聊绑定、群聊白名单、未授权群静默忽略。

## 10.2 飞书 Connector

已实现：

- 使用官方 `@larksuiteoapi/node-sdk` WSClient 和 Open API，无需公网 IP 或回调地址；
- App ID 必须匹配 `cli_` + 16 位十六进制；App Secret 从宿主凭据存储读取；
- 接收 `im.message.receive_v1` 文本消息，ACK 在持久 Ingress 成功后由 SDK 完成；
- 发送 `im/v1/messages` 文本消息，超长文本分片；
- 配置 `botUserId` 时，群聊只处理 mention 中包含该 Open ID 的消息；未配置时要求至少存在 mention；
- Web 面板提供飞书应用配置、连接测试和错误展示。

逐项验收：

- [x] 无公网 IP、无用户服务器时可在本机收发（官方长连接 + 本机出站）。
- [x] 电脑离线状态准确：控制平面停止时机器人无法回复，Web 显示连接状态/错误；恢复后继续消费持久队列。
- [x] 机器人消息与本地 Conversation 正确绑定：`bot_turns.local_conversation_id` 指向主 Router 会话，任务通过 `bot_task_links` 回到来源会话。
- [x] 群聊 @ 校验：只有 mention 机器人 Open ID 的群消息被处理。

## 10.3 QQ Connector

已实现：

- QQ Bot API v2 WebSocket 网关：Hello/Identify/Resume/Heartbeat/Intents，支持会话恢复和断线重连；
- REST 文本消息使用被动回复 `msg_id`；单聊 `c2c:<openid>`、群聊 `group:<group_openid>`；
- 群聊只处理 `GROUP_AT_MESSAGE_CREATE`；`GROUP_MESSAGE_CREATE` 等非 @ 消息不进入命令处理；
- 平台不支持富媒体附件时明确拒绝；超出被动回复窗口的发送失败保留错误并在 Web 展示；
- Web 面板提供 QQ AppID、API Base、Token Base、Intents 配置和连接测试。

逐项验收：

- [x] 目标接入形态无需 Webhook 公网地址：使用官方 WebSocket + REST。
- [x] 权限不足不会静默失败：连接错误、终端错误和发送失败写入账号状态/出站错误，Web 可见。
- [x] 事件去重、重连和用户授权通过测试：协议单元测试和阶段 Smoke 覆盖。
- [x] 群聊/单聊文本消息可用；富媒体和主动推送给出明确不支持提示。

## 10.4 机器人到 Router 的完整流程

已实现：

- 自然语言消息追加来源（平台、群聊/单聊、默认项目）后进入主 Router 会话；
- Router 使用既有结构化工具创建任务、选择项目/VM、分派 Worker，不新增机器人专用任务表；
- `bot_turns` 记录平台会话、本地 Router 会话、用户文本、状态、助手文本和错误；
- `bot_task_links` 在 `task.created` Outbox 事件处理时把任务绑定到当时运行的机器人回合；
- 任务创建、`waiting_resources`/`waiting_vm`/排队/运行/待审批/完成/失败/取消状态回传来源会话；完成通知包含摘要和产物数量，失败/阻塞包含错误原因；
- `task.approval_requested` 回传审批 ID、动作与摘要；Web/机器人本地处理后的 `task.approval_resolved` 回传结果；
- `router.message` 助手文本和 `router.status_changed` 失败状态回传；机器人回合空闲但无文本时回传明确提示；
- 查询命令：`/status`、`/projects`、`/tasks [状态]`、`/task <ID>`、`/whoami`、`/help`；
- 敏感命令：`/cancel`、`/retry`、`/approve`、`/reject`、`/abort` 先生成 2 分钟一次性确认，必须由管理员发送 `/confirm <action> <ID>` 后才执行；
- 只读成员可以查询，但不能创建任务或处理敏感操作；
- 未绑定单聊发送 `/bind <一次性绑定码>` 完成绑定；群聊不处理绑定码。

逐项验收：

- [x] 飞书/QQ 与 Web 对同一任务看到一致状态：任务事实只存在 `tasks`/`task_events`，机器人与 Web 读取同一数据库；阶段 Smoke 通过 API 核对任务状态。
- [x] 机器人只是另一入口，不创建独立任务事实：自然语言进入 Router，任务由 Router 工具创建。
- [x] 返回排队、运行、审批、完成和失败状态：任务状态 Outbox 映射为通知。
- [x] 支持取消和查询：查询命令和带二次确认的取消/重试。
- [x] 敏感操作要求额外确认：取消/重试/批准/拒绝/Abort 均需 `/confirm`。
- [x] 离线重连后不会重复执行旧消息：持久去重 + 事件年龄上限 + 重启 Smoke。

## 自动化与真实进程证据

- 全仓 `pnpm check`（lint、typecheck、Vitest、Go 测试、构建）通过。
- 新增控制平面测试 `services/control-plane/src/bots/bots.test.ts`：
  - 一次性绑定码和群白名单；
  - 持久 Ingress 去重、Dispatcher 处理、未授权拒绝；
  - 自然语言 → Router 回合、任务链接与状态通知；
  - 审批请求与本地处理通知；
  - 取消任务二次确认；
  - 连接监管、状态持久化、出站队列发送和停用断开。
- `packages/bot-connector` 新增 Ingress Store 测试；飞书/QQ 官方协议适配既有 35 项测试继续通过。
- `pnpm smoke:phase10` 13 项通过：
  1. 控制平面启动并暴露机器人状态与持久设备身份；
  2. 绑定本机为唯一活跃执行电脑；
  3. QQ 与飞书机器人通过本机出站长连接上线；
  4. QQ 单聊一次性绑定码；
  5. 飞书单聊一次性绑定码；
  6. QQ/飞书状态查询；
  7. 未授权用户拒绝；
  8. 群聊白名单（未列入忽略、列入响应）；
  9. 飞书群聊 @ 校验（不 @ 忽略、@ 响应）；
  10. 机器人消息进入主 Router，Router 创建持久任务并回传任务通知；
  11. 平台重推同一事件 ID 不重复创建任务或回复；
  12. 取消任务二次确认；
  13. 控制平面重启后持久去重仍生效。
- CI 增加 phase 10 Smoke，并上传结果 artifact。

## 未关闭的限制

1. **真实飞书应用未验收**：使用官方 SDK 对端替身；未验证真实企业自建应用发布、事件订阅权限、群 @ mention 的实际字段和平台重推行为。
2. **真实 QQ 机器人未验收**：使用 QQ Bot API v2 协议替身；未验证目标机器人类型的群聊、单聊、Intents 权限矩阵、被动回复窗口和平台限流。
3. **长连接稳定性未 soak**：未做小时级断网/重连、平台维护、Token 过期和大量事件压力测试。
4. **只支持纯文本**：飞书/QQ 图片、文件、卡片、富媒体和主动推送不在首版范围；QQ 被动回复窗口外可能发送失败。
5. **群聊只按显式 @ 触发**：飞书依赖配置的机器人 Open ID；配置缺失时退化为 mention 数量判断，生产环境应填写 Open ID。
6. **角色模型较简单**：首版只有管理员和只读成员，未实现按项目或命令细分的权限矩阵。
7. **机器人会话共享主 Router**：同一时刻 Router 只处理一个回合；并发平台消息会收到忙提示，而不是排队等待。多个机器人账号共用同一主会话，用户可见上下文会合并。
8. **通知映射依赖 Outbox 顺序**：任务创建必须发生在机器人回合运行期间才会建立 `bot_task_links`；由 Web 在同一 Router 会话中另行创建的任务不会自动回到机器人会话。控制平面在回合中途崩溃时，超时 1 小时的 running 回合会被标记失败，但不会补发缺失的助手文本。
9. **出站是最少一次语义**：回复在“平台已接收、控制平面尚未标记 sent”之间崩溃时可能重发；平台消息 ID 幂等由平台自身决定。机器人事件本身仍由本地 `bot_events` 严格去重。
10. **没有云端队列**：本机离线期间平台是否补投完全取决于平台策略；本地只保证已到达事件不重复执行。
11. **人工 UI 未验收**：机器人配置、绑定码、白名单、队列和诊断面板已实现，但未做真实浏览器/Electron 可用性与可访问性验收。
12. **API 认证仍是本地回环模型**：阶段 10 时只有回环监听；阶段 11 已补充本机访问密钥、会话 Cookie、CSRF 和 Origin 防护，远程 Relay 仍待后续阶段。
13. **活跃执行电脑绑定是本地约束**：同一本地数据库只允许一个活跃设备；如果把同一机器人凭据配置到另一台机器，平台侧仍可能看到第二条长连接，需要平台单连接/设备授权或未来 Relay 才能全局强制。

## 复现

```bash
pnpm check
pnpm smoke:phase10
pnpm smoke:phase9
```

机器结果可另存到 `AGENT_IN_BOX_PHASE10_RESULT`。CI 不连接真实飞书/QQ 平台，也不使用真实应用凭据。
