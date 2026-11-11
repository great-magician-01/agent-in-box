/* eslint-disable react-hooks/set-state-in-effect -- server snapshots refresh from events and timers */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopBridge,
  NotificationCenterView,
  NotificationRecord,
} from "@agent-in-box/protocol";
import { api, subscribeTaskEvents } from "./api";
import { formatDate } from "./format";

export interface NotificationCenterState {
  view: NotificationCenterView | null;
  error: string | null;
  reload(): Promise<void>;
  markRead(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

const NOTIFIED_STORAGE_KEY = "agent-in-box:notified-notifications";

function readNotified(): Set<string> {
  try {
    const raw = window.localStorage.getItem(NOTIFIED_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeNotified(ids: Set<string>): void {
  try {
    window.localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify([...ids].slice(-400)));
  } catch {
    // Notification de-duplication is best-effort when storage is unavailable.
  }
}

export function useNotificationCenter(
  bridge: DesktopBridge | null,
  onOpen: () => void,
): NotificationCenterState {
  const [view, setView] = useState<NotificationCenterView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notifiedRef = useRef<Set<string>>(readNotified());
  const onOpenRef = useRef(onOpen);
  const inFlight = useRef(false);
  const initialLoad = useRef(true);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  const reload = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.notifications({ limit: 80 });
      setView(next);
      setError(null);
      if (initialLoad.current) {
        // Do not replay historical unread items as native notifications when
        // the UI starts; only events observed after this first snapshot alert.
        initialLoad.current = false;
        for (const item of next.items) notifiedRef.current.add(item.id);
        writeNotified(notifiedRef.current);
      } else {
        maybeNotify(bridge, next.items, notifiedRef.current);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
    }
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => subscribeTaskEvents(() => void reload()), [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.notifications.onClick(() => onOpenRef.current());
  }, [bridge]);

  const markRead = useCallback(
    async (id: string): Promise<void> => {
      await api.markNotificationRead(id);
      await reload();
    },
    [reload],
  );

  const dismiss = useCallback(
    async (id: string): Promise<void> => {
      await api.dismissNotification(id);
      await reload();
    },
    [reload],
  );

  const markAllRead = useCallback(async (): Promise<void> => {
    await api.markAllNotificationsRead();
    await reload();
  }, [reload]);

  return { view, error, reload, markRead, dismiss, markAllRead };
}

function maybeNotify(
  bridge: DesktopBridge | null,
  items: NotificationRecord[],
  notified: Set<string>,
): void {
  if (!bridge) return;
  const unread = items
    .filter((item) => item.readAt === null)
    .slice(0, 3)
    .reverse();
  let changed = false;
  for (const item of unread) {
    if (notified.has(item.id)) continue;
    notified.add(item.id);
    changed = true;
    void bridge.notifications
      .show({ notificationId: item.id, title: item.title, body: item.body })
      .catch(() => undefined);
  }
  if (changed) {
    for (const id of [...notified].slice(0, Math.max(0, notified.size - 400))) {
      notified.delete(id);
    }
    try {
      window.localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify([...notified]));
    } catch {
      // Ignore storage failures.
    }
  }
}

const KIND_LABELS: Record<NotificationRecord["kind"], string> = {
  task: "任务",
  approval: "审批",
  worker: "Worker",
  vm: "虚拟机",
  resource: "资源",
  router: "Router",
  bot: "机器人",
  system: "系统",
};

interface NotificationCenterProps {
  state: NotificationCenterState;
  onNavigate(view: string): void;
}

export function NotificationCenter({
  state,
  onNavigate,
}: NotificationCenterProps): React.JSX.Element {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = state.view?.items ?? [];
  const visible = unreadOnly ? items.filter((item) => item.readAt === null) : items;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch {
      // The hook surfaces the error in state.error.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel notifications-panel" aria-labelledby="notifications-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">UNIFIED NOTIFICATIONS</p>
          <h2 id="notifications-title">通知中心</h2>
        </div>
        <div className="action-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            <span>只看未读</span>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || (state.view?.unreadCount ?? 0) === 0}
            onClick={() => void run(state.markAllRead)}
          >
            全部标为已读
          </button>
        </div>
      </div>
      <p className="muted small">
        任务、审批、Worker、VM、资源、Router 和机器人事件统一在此汇总；通知只是 Outbox
        的投影，不改变任务状态。
      </p>
      {state.error && <div className="notice">{state.error}</div>}
      {visible.length === 0 ? (
        <p className="muted">暂无通知。</p>
      ) : (
        <ul className="notification-list" aria-live="polite">
          {visible.map((item) => (
            <li
              key={item.id}
              className={`notification-item ${item.severity} ${item.readAt ? "read" : ""}`}
            >
              <div className="notification-title">
                <span className={`pill ${severityTone(item.severity)}`}>
                  {KIND_LABELS[item.kind]}
                </span>
                <strong>{item.title}</strong>
                {!item.readAt && <span className="dot live" aria-label="未读" />}
              </div>
              <p>{item.body}</p>
              <div className="notification-meta">
                <span className="muted small">{formatDate(item.createdAt)}</span>
                <div className="action-row">
                  {item.taskId && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onNavigate("tasks")}
                    >
                      查看任务
                    </button>
                  )}
                  {item.projectId && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onNavigate("projects")}
                    >
                      查看项目
                    </button>
                  )}
                  {item.vmId && (
                    <button type="button" className="link-button" onClick={() => onNavigate("vms")}>
                      查看 VM
                    </button>
                  )}
                  {item.workerId && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onNavigate("archive")}
                    >
                      查看 Worker
                    </button>
                  )}
                  {!item.readAt && (
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      onClick={() => void run(() => state.markRead(item.id))}
                    >
                      标为已读
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => void run(() => state.dismiss(item.id))}
                  >
                    移除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function severityTone(severity: NotificationRecord["severity"]): "ok" | "warn" | "live" {
  switch (severity) {
    case "success":
      return "ok";
    case "warning":
    case "danger":
      return "warn";
    default:
      return "live";
  }
}
