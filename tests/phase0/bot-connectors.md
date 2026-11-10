# 阶段 0.5：飞书 / QQ 本地长连接验证

日期：2026-11-10
范围：`@agent-in-box/bot-connector` 的连接框架与两个平台适配器
结论边界：**本地 mock HTTP/WebSocket 行为已验证；真实飞书应用 / QQ 机器人凭据接入仍阻塞，未验证。**

## 1. 结论摘要

| 项目 | 结果 |
| --- | --- |
| 飞书生产路径 | 官方 `@larksuiteoapi/node-sdk`（`WSClient` + `EventDispatcher`） |
| 飞书本地验证 | 官方 SDK 连接本地 mock Feishu 服务器，完成引导、ping/pong、事件 ACK、去重、重连测试 |
| QQ 生产路径 | 自研最小 WebSocket 适配器，按官方文档并对照腾讯官方插件/SDK 实现 |
| 通用连接状态机（disconnected / connecting / connected / degraded） | `ManagedBotConnection` 实现，mock 测试通过 |
| 心跳与超时 | QQ 由通用框架看门狗处理；飞书由官方 SDK `pingTimeout` 处理 |
| 指数退避重连 | QQ / 通用框架实现并测试；飞书重连由官方 SDK 按其策略处理 |
| 应用重启后去重入口 | 统一 `InboundPipeline` + 调用方持久化 `DedupeStore`，先持久化、再入队、再 ACK |
| 入站事件与长任务解耦 | 事件先进入 Ingress 队列，监听器在独立异步循环消费 |
| 断线重连 / 重复事件不产生重复任务 | 重连 + 持久化去重测试通过 |
| 可扩展平台 | `BotPlatform` 为开放字符串类型，内置 `feishu`/`qq` 提示，可新增 OneBot/Discord/Telegram |
| 类型检查 / 构建 / 测试 | `typecheck`、`build` 通过；6 个测试文件、34 个测试全部通过 |

结果记录见 [`results/2026-11-10-bot-connectors.json`](results/2026-11-10-bot-connectors.json)。该记录的 `status: success` **只表示本地 mock 范围**，文件中另有 `realPlatformVerification.status: unverified`。

## 2. 实现清单

均在 `packages/bot-connector/` 内：

- `src/contracts.ts`：公共契约。`BotPlatform` 改为 `BuiltInBotPlatform | (string & {})`，保留 `"feishu"`/`"qq"` 编辑器提示并允许新平台字符串。
- `src/ingress.ts`：共享 `InboundPipeline`、`DedupeStore`、`IngressQueue`、异步监听器派发。飞书与 QQ 复用同一份“去重持久化 → 入队 → 派发”语义。
- `src/connection.ts`：通用 `ManagedBotConnection` 状态机、心跳看门狗、指数退避重连、终端错误处理。
- `src/reconnect.ts`：指数退避与抖动策略。
- `src/ws.ts`：可注入 WebSocket 传输（`ws` 实现；处理握手期早到帧与 abort）。
- `src/feishu.ts`：生产飞书连接器 `OfficialFeishuConnector`，包装官方 SDK `WSClient`；保留 tenant token 与文本消息 HTTP 发送。
- `src/qq.ts`：QQ 网关适配器（token、Gateway、Hello/Identify/READY、心跳、Resume、事件映射、发送）。
- `src/http.ts`：可注入 HTTP 客户端；`src/logger.ts`：日志接口与凭据脱敏。
- `src/index.ts`：统一导出。
- `src/test-support/mock-server.ts`：本地 HTTP + WebSocket mock 服务器。
- `src/test-support/feishu-frame-codec.ts`：**仅测试使用**的飞书帧 codec，用于让 mock 服务器说官方 SDK 的 protobuf wire format；不是生产路径，也未从包入口导出。
- `src/*.test.ts`：6 个测试文件。
- `package.json`：新增 `"test": "vitest run"`；运行时依赖 `@larksuiteoapi/node-sdk@1.76.0`、`ws@8.22.2`；开发依赖 `@types/ws@8.18.2`。
- `tsconfig.json`：构建排除测试与 `test-support`。
- `pnpm-workspace.yaml`：为官方 SDK 的 `protobufjs` 传递依赖显式设置 `allowBuilds: false`（纯 JS 运行不需要安装脚本）。
- `pnpm-lock.yaml`：依赖更新。

未修改 `docs/02-technical-design.md`、`docs/03-development-plan.md` 或其他包。

## 3. 通用框架行为

### 3.1 状态与重连

- 初始 `disconnected`；`connect()` 后 `connecting`；适配器完成鉴权后 `connected`。
- 通用传输（QQ）断线后进入 `degraded`，按指数退避重连：
  `initialDelayMs * multiplier^(attempt-1)`，受 `maxDelayMs` 限制，带 `jitterRatio` 抖动。
- 主动 `disconnect()` 取消计时器、关闭 socket、拒绝未完成的 `connect()`，之后不再重连。
- 终端错误（错误凭据、无权限 intents、非法 shard 等）通过 `TerminalBotError` 或平台 `isTerminalClose` 识别，停止重试。
- 飞书的连接与重连由官方 `WSClient` 所有；本包根据 SDK `getConnectionStatus()` 与 `onReady/onReconnected/onReconnecting/onError` 回调映射状态。官方 SDK 首次重连可能立即发起，因此 `degraded` 可能非常短暂。

### 3.2 心跳

- QQ：Hello 的 `d.heartbeat_interval` 设置周期；发送 `op 1`，期望 `op 11` ACK。通用看门狗在超过 `2 * interval + 5s`（或注入的 `heartbeatTimeoutMs`）没有入站帧时重连。
- 飞书：官方 SDK 根据 `ClientConfig.PingInterval` 发送 control ping 并处理 pong；本包通过 `heartbeatTimeoutMs` 配置 SDK 的 `wsConfig.pingTimeout`（默认 30 秒），超时由 SDK 终止 socket 并重连。
- 心跳发送本身不会重置超时；只有入站帧才算“活跃”。

### 3.3 去重与入站队列

- 适配器把平台事件映射为 `InboundEventDraft`，调用共享 `InboundPipeline.accept()`。
- 顺序固定为：`DedupeStore.addIfAbsent()` 成功 → 入队 → 平台 ACK。
- 重复事件仍 ACK，但不会再次入队。
- 如果去重存储报错：不入队、不 ACK（飞书 handler 抛错时官方 SDK 回 500），平台重推后仍由持久化去重保证不重复建任务。
- `DedupeStore` 持久化由调用方负责（建议 SQLite `INSERT OR IGNORE`）。包内 `InMemoryDedupeStore` 只适合测试/演示，应用重启后不保留。
- 入队后由异步派发循环调用 `onMessage` 监听器；WebSocket/SDK handler 只做解析、去重与入队。设置 `autoDispatchIngress: false` 时调用方用 `drainIngress()` 自行消费。
- 入站队列默认上限 1000；满了会拒绝入队并导致不 ACK，由平台重推，避免静默丢事件。

### 3.4 出站与状态

- `send()` 校验平台一致性；飞书/QQ 都通过官方 HTTP API 发送，不依赖 WebSocket 在线。
- `getStatus()` 返回 `platform / state / lastConnectedAt / lastError`；`lastError` 截断并脱敏。
- `getMetrics()`、`getIngressSize()`、`drainIngress()` 为测试/运维辅助接口。

## 4. 飞书：官方 SDK 路径与本地验证

### 4.1 生产路径

- 使用官方 `@larksuiteoapi/node-sdk` 的 `WSClient` 与 `EventDispatcher`。
- `WSClient` 负责：`POST /callback/ws/endpoint` 引导、protobuf 帧编解码、ping/pong、事件 ACK、多包重组、重连。
- 本包负责：
  - 官方 handler 中把扁平化的 `im.message.receive_v1` 数据映射为 `InboundEventDraft`；
  - 调用共享 `InboundPipeline`，在 handler 返回前完成持久化去重与入队；
  - `onMessage` 的异步派发；
  - 状态映射、终端错误处理、主动断开；
  - tenant_access_token 获取与文本消息 HTTP 发送。
- 官方 SDK 的 handler 返回后才会发送 ACK，因此“先持久化再 ACK”语义由 handler 的完成时机保证。

### 4.2 已对齐的官方行为

1. **端点引导**
   - `POST https://open.feishu.cn/callback/ws/endpoint`
   - Body：`{ "AppID": "...", "AppSecret": "..." }`
   - Response：`{ code, msg, data: { URL, ClientConfig } }`
   - `ClientConfig`：`ReconnectCount`、`ReconnectInterval`（秒）、`ReconnectNonce`、`PingInterval`（秒）。
2. **App ID 校验**
   - 官方 SDK 只接受 `cli_` + 16 位十六进制字符；本包在 `connect()` 前显式校验，避免 SDK 静默返回导致 Promise 悬挂。
3. **事件处理**
   - 官方 SDK 把 v2 事件拍平为：header 字段（`event_id`、`event_type`、`create_time`）+ `sender` + `message`。
   - 本包映射：
     - `eventId`：`message.message_id`（回退 `event_id`）。官方“接收消息 v2.0”文档明确要求用 `message_id` 做幂等，不依赖 `event_id`。
     - `platformUserId`：`sender.sender_id.open_id`（回退 `user_id` / `union_id`）。
     - `conversationId`：`message.chat_id`。
     - `text`：`message_type === "text"` 时解析 `content` JSON 的 `text`；其他类型暂为空字符串。
     - `receivedAt`：`message.create_time`（毫秒）。
4. **ACK**
   - 官方 SDK 在 handler 成功后回 `{ code: 200 }`；handler 抛错回 `{ code: 500 }`。
   - 本包只在去重持久化 + 入队成功后让 handler 正常返回，因此不会在 AI 任务完成前 ACK，也不会在本地未持久化时 ACK。
5. **官方长连接限制**
   - 仅企业自建应用支持；单应用最多 50 条连接；推送为集群模式，随机一个客户端收到。

### 4.3 本地 mock 验证方式

- 测试 mock 服务器使用 `src/test-support/feishu-frame-codec.ts` 生成/解析官方 pbbp2 protobuf 帧。
- 官方 `WSClient` 通过 `domain: http://127.0.0.1:<port>` 完成真实 SDK 引导与 WebSocket 升级。
- 测试验证：
  - 引导请求体与 `ClientConfig` 解析；
  - 官方 SDK 的 control ping 与 pong 配置更新；
  - `im.message.receive_v1` 扁平化数据映射；
  - ACK 内容（`code: 200`、`biz_rt`）；
  - 重复 `message_id` 只入队一次；
  - 异常断线后官方 SDK 重新引导/重连；
  - 主动 disconnect 后不再重连；
  - tenant token + 文本消息发送；
  - SDK 错误消息中即使出现 AppSecret，也会在 `lastError` 与日志中被替换为 `[REDACTED]`。
- 这验证的是“官方 SDK 与我们的本地 mock/wrapper 可互操作”，**不是**真实飞书服务。

## 5. QQ：官方文档 + 活跃插件对齐

### 5.1 已对齐的握手与字段

1. **访问凭证**
   - `POST /app/getAppAccessToken`，Body `{ appId, clientSecret }`。
   - 成功：`{ access_token, expires_in }`；业务错误可能 HTTP 200 + `{ code, message }`。
   - OpenAPI Header：`Authorization: QQBot {ACCESS_TOKEN}`。
   - 当前官方文档使用 `https://api.bot.qq.com`；腾讯官方插件 `openclaw-qqbot` 与 Satori/Koishi QQ adapter 仍使用 `https://bots.qq.com`。本适配器默认 token 地址取 `https://bots.qq.com`，API 默认 `https://api.bot.qq.com`，两者均可通过 `tokenBaseUrl` / `apiBase` 覆盖。
2. **网关**
   - `GET /gateway` → `{ "url": "wss://..." }`。
3. **Hello / Identify / READY**
   - 服务端先发 `{ "op": 10, "d": { "heartbeat_interval": 45000 } }`（毫秒）。
   - 客户端发 `op 2`：`token: "QQBot {token}"`、`intents`、`shard: [0,1]`、`properties`。
   - 默认 `intents = 1 << 25`（`GROUP_AND_C2C_EVENT`）；需要频道事件时必须另行申请权限，不能擅自加入未获批的 intents。
   - 服务端回 `op 0, t=READY`，记录 `d.session_id` 与最新 `s`。
4. **心跳**
   - 发送 `{ "op": 1, "d": <最新 s，首次 null> }`；服务端回 `{ "op": 11 }`。
5. **Resume**
   - 重连后发送 `{ "op": 6, "d": { "token", "session_id", "seq" } }`；服务端补发后回 `t=RESUMED`。
   - 本适配器在会话对象外保存 `sessionId/lastSeq`，重连后仍可 Resume。
6. **事件结构**
   - 外层：`{ "id", "op": 0, "s", "t", "d" }`。
   - `C2C_MESSAGE_CREATE`：`d.id`、`d.author.user_openid`、`d.content`、`d.timestamp`。
   - `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE`：`d.id`、`d.group_openid`、`d.author.member_openid`、`d.content`。
   - `conversationId` 编码为 `c2c:<user_openid>` / `group:<group_openid>`，出站可直接复用。
7. **去重**
   - 与腾讯官方插件/SDK 一致，按消息 ID（`d.id`）去重。
   - `message_scene.ext` 的 `msg_idx` 用于引用消息索引，不作为投递去重键；早期实现把它拼进 eventId 会因索引变化产生重复任务，已修正。

### 5.2 对照活跃插件的修正

对照版本：`@tencent-connect/openclaw-qqbot@2.0.4`（依赖 `@tencent-connect/qqbot-nodejs@1.0.5`）、`@satorijs/adapter-qq@4.14.1`（`@koishijs/plugin-adapter-qq@4.14.0` 转发到该包）。据此修正：

| 场景 | 修正 |
| --- | --- |
| 关闭码 `4004`（invalid token） | 由“终端错误”改为可恢复：清 session、清 token 缓存、刷新 token 后重新 Identify |
| `4006` / `4007`（invalid session / seq 错误） | 清 session + 刷新 token，重新 Identify |
| `4009`（session timeout） | 清 session + 刷新 token，重新 Identify（对齐腾讯 SDK；官方文档允许 resume，此处选择更保守的 re-identify） |
| `4900~4913`（内部错误） | 清 session + 刷新 token，重连后 Identify |
| `4008`（限流） | 保留 session，默认等待 60 秒后重连（可通过 `rateLimitReconnectDelayMs` 覆盖） |
| `op 9 Invalid Session` | 仅当 `d !== true` 时清 session；可恢复时保留 session 并走 Resume |
| 消息去重 | 改为 `messageId`，不再拼 `msg_idx` |
| `4001`/`4002`/`4010`~`4014` | 按官方错误表视为不可重试终端错误（腾讯 SDK 对未知码默认重连，此处以官方文档为准） |
| `4914`/`4915` | 终端错误，不再重连（与腾讯 SDK 一致） |

无法联网核实或无法在本地 mock 验证的内容已在第 7 节列出。

## 6. 本地 mock 测试

测试只使用 `127.0.0.1` 上的临时 HTTP + WebSocket 服务器，**没有请求发往 `open.feishu.cn`、`api.bot.qq.com`、`bots.qq.com` 或任何真实平台**。

| 测试文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `connection.test.ts` | 8 | 通用状态机、入站队列、出站帧、重复事件只入队一次、调用方去重存储跨 connector 重建复用、监听器不在 WS 回调执行、断线重连、disconnect 不重连、终端错误不重试、心跳超时重连 |
| `feishu.test.ts` | 6 | 官方 SDK 引导、ping/pong、事件映射、ACK、重复 message_id 去重、官方 SDK 重连、disconnect、tenant token + 发送、514 终端错误脱敏、appId 形状校验 |
| `qq.test.ts` | 11 | token/Gateway、Hello/Identify/READY、C2C/群事件映射、messageId 去重、异常断线 Resume、4004 刷新 token、4009 清 session、op9 resumable、disconnect、C2C/群发送、4014 终端、错误凭据脱敏、被动回复构造 |
| `reconnect.test.ts` | 3 | 指数增长、上限、确定性抖动、非法参数 |
| `logger.test.ts` | 2 | Bearer/QQBot token 与 secret 字段脱敏、错误长度上限 |
| `bot-connector.test.ts` | 4 | 原有 `dedupKey` / 授权回归、开放平台字符串 |
| **合计** | **34** | 全部通过 |

执行结果（2026-11-10）：

```text
pnpm --filter @agent-in-box/bot-connector typecheck  -> pass
pnpm --filter @agent-in-box/bot-connector build      -> pass
pnpm --filter @agent-in-box/bot-connector test       -> 6 files, 34 tests passed
```

## 7. 真实平台验证：仍阻塞

以下内容**未验证**，需要用户创建测试应用/机器人后才能继续。当前没有使用任何真实凭据，也没有连接真实平台。

### 7.1 飞书

需要用户提供/完成：

1. 在飞书开放平台创建**企业自建应用**（长连接不支持商店应用）。
2. 开启机器人能力。
3. 在“事件与回调 → 事件配置”选择**使用长连接接收事件**；保存时要求本地客户端已在线。
4. 订阅 `im.message.receive_v1` 并申请单聊/群 @ 消息所需权限。
5. 提供测试应用 `App ID` / `App Secret`，只注入宿主机 connector 进程（不写入 VM、镜像、结果文件或普通日志）。
6. 宿主机可访问 `open.feishu.cn`。

拿到凭据后需要补验：真实端点引导与鉴权、真实 ping/pong 周期、真实事件字段、平台 3 秒 ACK 重推、真实发送、50 连接/集群随机投递。

### 7.2 QQ 机器人

需要用户提供/完成：

1. 在 QQ 开放平台注册机器人，获得 `AppID` / `ClientSecret`。
2. 为测试机器人申请权限；默认只订阅 `GROUP_AND_C2C_EVENT (1<<25)`。
3. 将机器人加入测试群，并与测试账号建立单聊。
4. 提供沙箱/正式环境凭据（只保留在宿主机 connector 进程）。
5. 宿主机可访问 `api.bot.qq.com` 与 `bots.qq.com`（或配置覆盖为可用域名）。

拿到凭据后需要补验：真实 token 地址行为、Hello/Identify/READY、心跳 ACK、真实断线 Resume/RESUMED 补发、`4004/4006/4007/4009/4008/4900~4913` 的实际关闭行为、真实事件字段与发送频控。

### 7.3 阻塞结论

- 不能宣称“飞书/QQ 机器人接入已完成”。
- 不能宣称已验证平台侧重推、限流、集群投递与权限错误行为。
- 只能宣称“通用框架与按官方文档/SDK 对齐的适配器已通过本地 mock 验证”。

## 8. 安全边界

- 飞书 `AppSecret` 与 QQ `ClientSecret`/`AccessToken` 只作为宿主机进程内配置；适配器不写入 `getStatus()`、事件 `raw` 或普通日志。
- `lastError` 与日志经过 `redactSecrets()`；飞书额外用 `redactSecretValues()` 替换 SDK 错误中可能原样回显的 AppSecret。
- 官方 SDK 的日志通过一个脱敏 `Logger` 适配器接入本包 logger；默认 logger 静默，SDK 默认日志级别为 error。
- 测试与结果文件不包含真实凭据；mock 使用固定假值。
- 长期 bot secret 不应下发到 VM；connector 应运行在宿主机。

## 9. 已知限制与后续工作

1. **飞书出站仍用本包 HTTP 实现**：入站用官方 SDK WSClient，出站使用 tenant_access_token + `/open-apis/im/v1/messages`。若希望出站也走官方 `Client`，可在后续替换，但需保留错误脱敏。
2. **飞书附录/富媒体未实现**：`send()` 目前只支持文本，传 `attachments` 会抛错；非文本消息映射为空文本。
3. **飞书重连策略由 SDK 决定**：不使用本包的 `ReconnectPolicy`；SDK 首次重连可能立即发起。
4. **QQ 使用自研协议适配器**：未引入 `@tencent-connect/qqbot-nodejs`，因为该 SDK 会接管连接生命周期且体积较大；已按官方文档与活跃插件核对关键状态机。真实接入前应再用真实凭据做一轮集成验证。
5. **QQ 频道（Guild）事件未启用**：默认 intents 不含 `PUBLIC_GUILD_MESSAGES`；如需频道场景需单独申请权限并扩展出站接口。
6. **持久化去重是部署责任**：`InMemoryDedupeStore` 不跨重启；生产必须注入持久化 `DedupeStore`，并与设备 ID 绑定。
7. **QQ resume 状态目前是进程内**：应用重启后首次连接会 Identify；持久化去重仍阻止重复任务。若需要跨进程 Resume，需像腾讯 SDK 一样持久化 `session_id/seq`。

## 10. 复现命令

```bash
pnpm install
pnpm --filter @agent-in-box/bot-connector typecheck
pnpm --filter @agent-in-box/bot-connector test
pnpm --filter @agent-in-box/bot-connector build
```

## 11. 参考来源

飞书：

- 使用长连接接收事件：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- 接收消息 v2.0：<https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive>
- 发送消息：<https://open.feishu.cn/document/server-docs/im-v1/message/create>
- 自建应用获取 tenant_access_token：<https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal>
- 官方 Node SDK：<https://github.com/larksuite/node-sdk>
- 官方 Go SDK WebSocket 源码（帧字段参考）：<https://github.com/larksuite/oapi-sdk-go/tree/v3_main/ws>

QQ：

- WebSocket 方式：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html>
- 通用数据结构 / Intents：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html>
- 获取通用 WSS 接入点：<https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html>
- 获取访问凭证：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>
- API 调用指南：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html>
- 单聊消息事件：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html>
- 群消息事件：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html>
- 发送单聊消息：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>
- 发送群聊消息：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>
- 官方插件 openclaw-qqbot：<https://github.com/tencent-connect/openclaw-qqbot>
- 腾讯官方 qqbot-nodejs SDK：<https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs>
- Koishi QQ adapter（Satori）：<https://koishi.chat/zh-CN/plugins/adapter/qq>
