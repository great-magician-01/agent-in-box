/* eslint-disable react-hooks/set-state-in-effect -- server snapshot polling intentionally updates state */
import { useCallback, useEffect, useState } from "react";
import type {
  BotAccountView,
  BotChatRecord,
  BotIdentityRecord,
  BotOverview,
  BotPlatform,
  BotRuntimeState,
  DesktopBridge,
} from "@agent-in-box/protocol";
import { api, ApiRequestError, subscribeTaskEvents } from "./api";
import { formatDate } from "./format";

const STATE_LABELS: Record<BotRuntimeState, string> = {
  disabled: "已停用",
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  degraded: "重连中",
};

interface BotManagerProps {
  bridge: DesktopBridge | null;
}

interface AccountForm {
  platform: BotPlatform;
  name: string;
  appId: string;
  credentialProviderId: string;
  secret: string;
  domain: string;
  apiBase: string;
  tokenBaseUrl: string;
  botUserId: string;
  intents: string;
  enabled: boolean;
}

const EMPTY_FORM: AccountForm = {
  platform: "feishu",
  name: "",
  appId: "",
  credentialProviderId: "",
  secret: "",
  domain: "",
  apiBase: "",
  tokenBaseUrl: "",
  botUserId: "",
  intents: "",
  enabled: true,
};

interface IdentityForm {
  platform: BotPlatform;
  platformUserId: string;
  displayName: string;
  role: "admin" | "member";
}

const EMPTY_IDENTITY: IdentityForm = {
  platform: "feishu",
  platformUserId: "",
  displayName: "",
  role: "admin",
};

interface ChatForm {
  platform: BotPlatform;
  conversationId: string;
  kind: "p2p" | "group";
  title: string;
  projectId: string;
  allowed: boolean;
}

const EMPTY_CHAT: ChatForm = {
  platform: "feishu",
  conversationId: "",
  kind: "group",
  title: "",
  projectId: "",
  allowed: true,
};

export function BotManager({ bridge }: BotManagerProps): React.JSX.Element {
  const [overview, setOverview] = useState<BotOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM);
  const [identityForm, setIdentityForm] = useState<IdentityForm>(EMPTY_IDENTITY);
  const [chatForm, setChatForm] = useState<ChatForm>(EMPTY_CHAT);
  const [accessCode, setAccessCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      setOverview(await api.bots());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => subscribeTaskEvents(() => void reload(true)), [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => void reload(true), 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      await reload(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveAccount(): Promise<void> {
    const appId = form.appId.trim();
    if (!appId) {
      setError("App ID 不能为空");
      return;
    }
    const credentialProviderId =
      form.credentialProviderId.trim() || defaultCredentialId(form.platform, appId);
    const config = {
      ...(form.domain.trim() ? { domain: form.domain.trim() } : {}),
      ...(form.apiBase.trim() ? { apiBase: form.apiBase.trim() } : {}),
      ...(form.tokenBaseUrl.trim() ? { tokenBaseUrl: form.tokenBaseUrl.trim() } : {}),
      ...(form.botUserId.trim() ? { botUserId: form.botUserId.trim() } : {}),
      ...(form.intents.trim() ? { intents: Number(form.intents.trim()) } : {}),
    };
    await run(async () => {
      if (bridge && form.secret.trim()) {
        await bridge.credentials.save({
          providerId: credentialProviderId,
          secret: form.secret.trim(),
        });
      }
      const created = await api.createBotAccount({
        platform: form.platform,
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        appId,
        credentialProviderId,
        config,
        enabled: form.enabled,
      });
      setForm(EMPTY_FORM);
      setShowAccountForm(false);
      setMessage(
        bridge
          ? "机器人账号已保存。Secret 已写入系统安全存储。"
          : "机器人账号已保存。未检测到桌面凭据桥；请在开发凭据文件中提供 Secret 后再启用连接。",
      );
      if (!bridge && form.secret.trim()) {
        const tested = await api.testBotAccount(created.id, { secret: form.secret.trim() });
        setMessage(
          tested.ok
            ? "临时连接测试成功；但 Secret 未持久化，请配置开发凭据文件后再启用。"
            : `连接测试失败：${tested.lastError ?? "未知错误"}`,
        );
      }
    });
  }

  async function toggleAccount(account: BotAccountView): Promise<void> {
    await run(async () => {
      await api.updateBotAccount(account.id, { enabled: !account.enabled });
    });
  }

  async function testAccount(account: BotAccountView): Promise<void> {
    await run(async () => {
      const result = await api.testBotAccount(account.id);
      setMessage(
        result.ok
          ? `${account.name} 连接测试成功。`
          : `${account.name} 连接测试失败：${result.lastError ?? "未知错误"}`,
      );
    });
  }

  async function deleteAccount(account: BotAccountView): Promise<void> {
    if (!window.confirm(`删除机器人 ${account.name}？其事件、会话映射和待发送消息也会删除。`)) {
      return;
    }
    await run(async () => {
      await api.deleteBotAccount(account.id);
    });
  }

  async function toggleDevice(): Promise<void> {
    if (!overview) return;
    if (overview.thisDeviceActive) {
      if (!window.confirm("解除本机的活跃执行电脑绑定？机器人将停止收发消息。")) return;
    }
    await run(async () => {
      await api.setBotDevice({ active: !overview.thisDeviceActive });
    });
  }

  async function saveIdentity(): Promise<void> {
    if (!identityForm.platformUserId.trim()) {
      setError("平台用户 ID 不能为空");
      return;
    }
    await run(async () => {
      await api.upsertBotIdentity(identityForm.platform, identityForm.platformUserId.trim(), {
        platformUserId: identityForm.platformUserId.trim(),
        ...(identityForm.displayName.trim()
          ? { displayName: identityForm.displayName.trim() }
          : {}),
        role: identityForm.role,
        bound: true,
      });
      setIdentityForm(EMPTY_IDENTITY);
    });
  }

  async function removeIdentity(identity: BotIdentityRecord): Promise<void> {
    if (!window.confirm(`移除平台用户 ${identity.platformUserId} 的绑定？`)) return;
    await run(async () => {
      await api.deleteBotIdentity(identity.platform, identity.platformUserId);
    });
  }

  async function saveChat(): Promise<void> {
    if (!chatForm.conversationId.trim()) {
      setError("会话 ID 不能为空");
      return;
    }
    await run(async () => {
      await api.upsertBotChat({
        platform: chatForm.platform,
        conversationId: chatForm.conversationId.trim(),
        kind: chatForm.kind,
        ...(chatForm.title.trim() ? { title: chatForm.title.trim() } : {}),
        allowed: chatForm.allowed,
        ...(chatForm.projectId.trim() ? { projectId: chatForm.projectId.trim() } : {}),
      });
      setChatForm(EMPTY_CHAT);
    });
  }

  async function toggleChat(chat: BotChatRecord): Promise<void> {
    await run(async () => {
      await api.upsertBotChat({
        platform: chat.platform,
        conversationId: chat.conversationId,
        kind: chat.kind,
        title: chat.title,
        allowed: !chat.allowed,
      });
    });
  }

  async function removeChat(chat: BotChatRecord): Promise<void> {
    if (!window.confirm(`删除会话白名单 ${chat.conversationId}？`)) return;
    await run(async () => {
      await api.deleteBotChat(chat.platform, chat.conversationId);
    });
  }

  async function generateCode(): Promise<void> {
    await run(async () => {
      const created = await api.createBotAccessCode({ role: "admin" });
      setAccessCode({ code: created.code, expiresAt: created.expiresAt });
    });
  }

  async function sendTest(account: BotAccountView): Promise<void> {
    const conversationId = (testMessages[account.id] ?? "").trim();
    if (!conversationId) {
      setError("请先填写测试会话 ID");
      return;
    }
    await run(async () => {
      await api.sendBotTestMessage(account.id, {
        accountId: account.id,
        conversationId,
        text: "Agent-in-Box 机器人测试消息。",
      });
      setTestMessages((current) => ({ ...current, [account.id]: "" }));
      setMessage("测试消息已加入发送队列。若连接未就绪，会在连接后重试。");
    });
  }

  return (
    <section className="panel bot-manager" aria-labelledby="bot-manager-title">
      <div className="panel-heading">
        <div>
          <h2 id="bot-manager-title">飞书与 QQ 机器人</h2>
        </div>
        <div className="action-row">
          <button
            type="button"
            className="secondary"
            onClick={() => void api.reconcileBots().then(() => reload(true))}
            disabled={busy}
          >
            立即处理队列
          </button>
          <button type="button" className="primary" onClick={() => void reload()}>
            刷新
          </button>
        </div>
      </div>
      <p className="muted small">
        机器人通过与平台的本机出站长连接收发消息，不需要公网 IP。Secret
        只保存在系统安全存储中，不会进入 VM 或普通日志；AI 任务仍由本机 Router
        和任务看板统一管理，机器人不是独立任务事实源。
      </p>
      {error && <div className="notice">{error}</div>}
      {message && <div className="notice small">{message}</div>}
      {loading && !overview ? (
        <p className="muted">正在读取机器人状态…</p>
      ) : overview ? (
        <>
          <div className="bot-overview-grid">
            <article className="card">
              <div className="card-title">
                <h3>执行电脑</h3>
                <span className={`pill ${overview.thisDeviceActive ? "ok" : "warn"}`}>
                  {overview.thisDeviceActive ? "本机已绑定" : "未绑定本机"}
                </span>
              </div>
              <dl>
                <div>
                  <dt>设备名称</dt>
                  <dd>{overview.deviceName}</dd>
                </div>
                <div>
                  <dt>设备 ID</dt>
                  <dd>
                    <code>{overview.deviceId}</code>
                  </dd>
                </div>
                <div>
                  <dt>控制平面</dt>
                  <dd>{overview.computerOnline ? "在线" : "离线"}</dd>
                </div>
                <div>
                  <dt>启动时间</dt>
                  <dd>{formatDate(overview.startedAt)}</dd>
                </div>
                <div>
                  <dt>队列</dt>
                  <dd>
                    入站 {overview.pendingIngress} · 失败 {overview.failedIngress} · 出站{" "}
                    {overview.pendingOutbound} · 发送失败 {overview.failedOutbound}
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                className="secondary"
                onClick={() => void toggleDevice()}
                disabled={busy}
              >
                {overview.thisDeviceActive ? "解除本机绑定" : "绑定此电脑并启用机器人"}
              </button>
              <p className="muted small">
                同一机器人只应有一台活跃执行电脑，避免多实例随机消费平台事件。
              </p>
            </article>

            <article className="card">
              <div className="card-title">
                <h3>身份绑定</h3>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void generateCode()}
                  disabled={busy}
                >
                  生成一次性绑定码
                </button>
              </div>
              {accessCode ? (
                <div className="access-code">
                  <code>{accessCode.code}</code>
                  <span className="muted small">
                    有效期至 {formatDate(accessCode.expiresAt)}。请在与机器人的单聊中发送 /bind
                    &lt;绑定码&gt;。
                  </span>
                </div>
              ) : (
                <p className="muted small">
                  生成绑定码后在单聊中发送
                  /bind，即可把平台身份绑定到本机管理员；平台用户仍必须通过白名单或绑定码授权。
                </p>
              )}
              <div className="bot-inline-form">
                <select
                  value={identityForm.platform}
                  onChange={(event) =>
                    setIdentityForm((current) => ({
                      ...current,
                      platform: event.target.value as BotPlatform,
                    }))
                  }
                >
                  <option value="feishu">飞书</option>
                  <option value="qq">QQ</option>
                </select>
                <input
                  value={identityForm.platformUserId}
                  onChange={(event) =>
                    setIdentityForm((current) => ({
                      ...current,
                      platformUserId: event.target.value,
                    }))
                  }
                  placeholder="平台用户 ID"
                />
                <input
                  value={identityForm.displayName}
                  onChange={(event) =>
                    setIdentityForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                  placeholder="显示名称（可选）"
                />
                <select
                  value={identityForm.role}
                  onChange={(event) =>
                    setIdentityForm((current) => ({
                      ...current,
                      role: event.target.value as "admin" | "member",
                    }))
                  }
                >
                  <option value="admin">管理员</option>
                  <option value="member">只读成员</option>
                </select>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void saveIdentity()}
                  disabled={busy}
                >
                  添加用户
                </button>
              </div>
              <ul className="bot-list">
                {overview.identities.length === 0 && <li className="muted">还没有绑定平台用户</li>}
                {overview.identities.map((identity) => (
                  <li key={identity.id}>
                    <span>
                      <strong>{identity.displayName || identity.platformUserId}</strong>
                      <span className="muted small">
                        {" "}
                        · {identity.platform === "feishu" ? "飞书" : "QQ"} ·{" "}
                        {identity.role === "admin" ? "管理员" : "只读"}
                      </span>
                    </span>
                    <span className="bot-row-actions">
                      <span className={`pill ${identity.bound ? "ok" : "warn"}`}>
                        {identity.bound ? "已授权" : "未授权"}
                      </span>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void removeIdentity(identity)}
                      >
                        移除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          </div>

          <div className="panel-heading bot-subheading">
            <h3>机器人账号</h3>
            <button
              type="button"
              className="primary"
              onClick={() => setShowAccountForm((value) => !value)}
            >
              {showAccountForm ? "收起配置" : "添加机器人"}
            </button>
          </div>

          {showAccountForm && (
            <div className="bot-account-form">
              <p className="muted small">
                飞书使用官方 WebSocket；QQ 使用 Bot API v2
                Intents。首次接入请先在平台创建应用并开通消息事件与发送消息权限。
              </p>
              <div className="bot-form-grid">
                <label className="field">
                  <span>平台</span>
                  <select
                    value={form.platform}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        platform: event.target.value as BotPlatform,
                      }))
                    }
                  >
                    <option value="feishu">飞书</option>
                    <option value="qq">QQ</option>
                  </select>
                </label>
                <label className="field">
                  <span>名称</span>
                  <input
                    value={form.name}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="例如 工作助手"
                  />
                </label>
                <label className="field">
                  <span>App ID</span>
                  <input
                    value={form.appId}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, appId: event.target.value }))
                    }
                    placeholder={form.platform === "feishu" ? "cli_0123456789abcdef" : "QQ AppID"}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>凭据标识（系统安全存储）</span>
                  <input
                    value={form.credentialProviderId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        credentialProviderId: event.target.value,
                      }))
                    }
                    placeholder={defaultCredentialId(form.platform, form.appId || "app")}
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>{form.platform === "feishu" ? "App Secret" : "Client Secret"}</span>
                  <input
                    type="password"
                    value={form.secret}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, secret: event.target.value }))
                    }
                    placeholder={bridge ? "写入系统安全存储" : "需开发凭据文件"}
                    autoComplete="off"
                  />
                </label>
                {form.platform === "feishu" ? (
                  <>
                    <label className="field">
                      <span>API 域名（可选）</span>
                      <input
                        value={form.domain}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, domain: event.target.value }))
                        }
                        placeholder="https://open.feishu.cn"
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>机器人 Open ID（群聊 @ 校验）</span>
                      <input
                        value={form.botUserId}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, botUserId: event.target.value }))
                        }
                        placeholder="ou_xxx，建议填写"
                        spellCheck={false}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>API Base（可选）</span>
                      <input
                        value={form.apiBase}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, apiBase: event.target.value }))
                        }
                        placeholder="https://api.bot.qq.com"
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>Token Base（可选）</span>
                      <input
                        value={form.tokenBaseUrl}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            tokenBaseUrl: event.target.value,
                          }))
                        }
                        placeholder="https://bots.qq.com"
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>Intents（可选）</span>
                      <input
                        value={form.intents}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, intents: event.target.value }))
                        }
                        placeholder="默认群聊与单聊事件"
                        inputMode="numeric"
                      />
                    </label>
                  </>
                )}
                <label className="toggle policy-toggle">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />
                  <span>保存后立即启用连接</span>
                </label>
              </div>
              <div className="action-row">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void saveAccount()}
                  disabled={busy}
                >
                  {busy ? "保存中…" : "保存机器人"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setShowAccountForm(false)}
                >
                  取消
                </button>
                {!bridge && (
                  <span className="muted small">
                    本地 Web 无法写入系统安全存储；请设置 AGENT_IN_BOX_BOT_CREDENTIALS_FILE
                    或从桌面应用配置。
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="bot-account-list">
            {overview.accounts.length === 0 && (
              <p className="muted">还没有机器人账号。添加后会显示连接状态、队列和最近事件。</p>
            )}
            {overview.accounts.map((account) => (
              <article key={account.id} className="card bot-account-card">
                <div className="card-title">
                  <h3>
                    {account.name}{" "}
                    <span className="muted small">
                      · {account.platform === "feishu" ? "飞书" : "QQ"}
                    </span>
                  </h3>
                  <span className={`pill ${stateClass(account.state)}`}>
                    {STATE_LABELS[account.state]}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>App ID</dt>
                    <dd>
                      <code>{account.appId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>凭据标识</dt>
                    <dd>
                      <code>{account.credentialProviderId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>最近连接</dt>
                    <dd>{account.lastConnectedAt ? formatDate(account.lastConnectedAt) : "—"}</dd>
                  </div>
                  <div>
                    <dt>最近事件</dt>
                    <dd>{account.lastEventAt ? formatDate(account.lastEventAt) : "—"}</dd>
                  </div>
                  <div>
                    <dt>队列</dt>
                    <dd>
                      入站 {account.ingressPending} · 出站 {account.outboundPending} · 失败{" "}
                      {account.outboundFailed}
                    </dd>
                  </div>
                </dl>
                {account.lastError && <div className="notice small">{account.lastError}</div>}
                <div className="action-row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void testAccount(account)}
                    disabled={busy}
                  >
                    测试连接
                  </button>
                  {account.state === "connected" ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void run(async () => {
                          await api.disconnectBotAccount(account.id);
                        })
                      }
                      disabled={busy}
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        void run(async () => {
                          await api.reconnectBotAccount(account.id);
                        })
                      }
                      disabled={busy || !account.enabled || !overview.thisDeviceActive}
                    >
                      重新连接
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void toggleAccount(account)}
                    disabled={busy}
                  >
                    {account.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void deleteAccount(account)}
                    disabled={busy}
                  >
                    删除
                  </button>
                </div>
                <div className="bot-inline-form">
                  <input
                    value={testMessages[account.id] ?? ""}
                    onChange={(event) =>
                      setTestMessages((current) => ({
                        ...current,
                        [account.id]: event.target.value,
                      }))
                    }
                    placeholder={
                      account.platform === "qq"
                        ? "c2c:<openid> 或 group:<openid>"
                        : "oc_xxx chat_id"
                    }
                  />
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void sendTest(account)}
                    disabled={busy}
                  >
                    发送测试消息
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="panel-heading bot-subheading">
            <h3>群聊白名单</h3>
          </div>
          <p className="muted small">
            单聊由已绑定用户授权；群聊必须显式加入白名单。未授权群消息会被静默忽略，避免机器人在无关群中响应。
          </p>
          <div className="bot-inline-form">
            <select
              value={chatForm.platform}
              onChange={(event) =>
                setChatForm((current) => ({
                  ...current,
                  platform: event.target.value as BotPlatform,
                }))
              }
            >
              <option value="feishu">飞书</option>
              <option value="qq">QQ</option>
            </select>
            <input
              value={chatForm.conversationId}
              onChange={(event) =>
                setChatForm((current) => ({ ...current, conversationId: event.target.value }))
              }
              placeholder="会话 ID（飞书 chat_id / QQ group_openid）"
            />
            <select
              value={chatForm.kind}
              onChange={(event) =>
                setChatForm((current) => ({
                  ...current,
                  kind: event.target.value as "p2p" | "group",
                }))
              }
            >
              <option value="group">群聊</option>
              <option value="p2p">单聊</option>
            </select>
            <input
              value={chatForm.title}
              onChange={(event) =>
                setChatForm((current) => ({ ...current, title: event.target.value }))
              }
              placeholder="标题（可选）"
            />
            <input
              value={chatForm.projectId}
              onChange={(event) =>
                setChatForm((current) => ({ ...current, projectId: event.target.value }))
              }
              placeholder="默认项目 ID（可选）"
            />
            <button
              type="button"
              className="secondary"
              onClick={() => void saveChat()}
              disabled={busy}
            >
              保存白名单
            </button>
          </div>
          <ul className="bot-list">
            {overview.chats.map((chat) => (
              <li key={chat.id}>
                <span>
                  <strong>{chat.title || chat.conversationId}</strong>
                  <span className="muted small">
                    {" "}
                    · {chat.platform === "feishu" ? "飞书" : "QQ"} ·{" "}
                    {chat.kind === "group" ? "群聊" : "单聊"}
                    {chat.projectId ? ` · 默认项目 ${chat.projectId}` : ""}
                  </span>
                </span>
                <span className="bot-row-actions">
                  <span className={`pill ${chat.allowed ? "ok" : "warn"}`}>
                    {chat.kind === "p2p"
                      ? chat.allowed
                        ? "身份已授权"
                        : "等待身份绑定"
                      : chat.allowed
                        ? "已允许"
                        : "已拒绝"}
                  </span>
                  {chat.kind === "group" && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void toggleChat(chat)}
                    >
                      {chat.allowed ? "移出白名单" : "加入白名单"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void removeChat(chat)}
                  >
                    删除
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <div className="bot-capability-grid">
            {overview.platforms.map((platform) => (
              <article key={platform.platform} className="card">
                <h3>{platform.label}能力</h3>
                <ul className="mini-checks">
                  <li className={platform.longConnection ? "ok" : "error"}>
                    <span>{platform.longConnection ? "支持" : "不支持"}</span>本机长连接
                  </li>
                  <li className={platform.textTasks ? "ok" : "error"}>
                    <span>{platform.textTasks ? "支持" : "不支持"}</span>文本任务
                  </li>
                  <li className={platform.groupChat ? "ok" : "error"}>
                    <span>{platform.groupChat ? "支持" : "不支持"}</span>群聊
                  </li>
                  <li className={platform.approvals ? "ok" : "error"}>
                    <span>{platform.approvals ? "支持" : "不支持"}</span>审批通知与确认
                  </li>
                  <li className={platform.attachments ? "ok" : "warning"}>
                    <span>{platform.attachments ? "支持" : "不支持"}</span>附件
                  </li>
                </ul>
                <ul className="bot-notes">
                  {platform.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <details className="bot-diagnostics">
            <summary>最近事件与 Router 回合</summary>
            <div className="bot-diagnostics-grid">
              <div>
                <h4>最近入站事件</h4>
                <ul className="bot-list compact">
                  {overview.recentEvents.length === 0 && <li className="muted">无</li>}
                  {overview.recentEvents.map((event) => (
                    <li key={event.dedupKey}>
                      <span>
                        <strong>{event.platform === "feishu" ? "飞书" : "QQ"}</strong>{" "}
                        <span className="muted small">
                          {event.state} · 尝试 {event.attempts}
                        </span>
                        <br />
                        <span className="muted small">{event.text.slice(0, 120)}</span>
                        {event.lastError && (
                          <span className="error-line small">{event.lastError.slice(0, 200)}</span>
                        )}
                      </span>
                      <span className="muted small">{formatDate(event.receivedAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>最近 Router 回合</h4>
                <ul className="bot-list compact">
                  {overview.recentTurns.length === 0 && <li className="muted">无</li>}
                  {overview.recentTurns.map((turn) => (
                    <li key={turn.id}>
                      <span>
                        <strong>{turn.status}</strong>{" "}
                        <span className="muted small">{turn.userText.slice(0, 120)}</span>
                        {turn.errorMessage && (
                          <span className="error-line small">
                            {turn.errorMessage.slice(0, 200)}
                          </span>
                        )}
                      </span>
                      <span className="muted small">{formatDate(turn.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        </>
      ) : (
        <p className="muted">机器人状态不可用。</p>
      )}
    </section>
  );
}

function defaultCredentialId(platform: BotPlatform, appId: string): string {
  const suffix = appId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
  return `bot-${platform}-${suffix}`.slice(0, 40);
}

function stateClass(state: BotRuntimeState): string {
  if (state === "connected") return "ok";
  if (state === "degraded" || state === "connecting") return "warn";
  return "bad";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
