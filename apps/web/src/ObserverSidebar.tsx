/* eslint-disable react-hooks/set-state-in-effect -- VM/worker snapshots refresh from server events */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type {
  RouterToolCallRecord,
  RouterToolDefinition,
  RouterView,
  VmConsoleSession,
  VmInstanceView,
  WorkerView,
} from "@agent-in-box/protocol";
import { api } from "./api";
import { Select } from "./Select";
import { useModalFocus } from "./useModalFocus";

const VmConsole = lazy(() =>
  import("./VmConsole").then((module) => ({ default: module.VmConsole })),
);

export type ObserverTab = "vm" | "activity";

interface ObserverSidebarProps {
  open: boolean;
  tab: ObserverTab;
  workerId: string | null;
  preferredVmId: string | null;
  revision: number;
  modal: boolean;
  onTabChange(tab: ObserverTab): void;
  onClose(): void;
  onChanged?(): void;
}

export function ObserverSidebar({
  open,
  tab,
  workerId,
  preferredVmId,
  revision,
  modal,
  onTabChange,
  onClose,
}: ObserverSidebarProps): React.JSX.Element | null {
  const [vms, setVms] = useState<VmInstanceView[]>([]);
  const [selectedVmId, setSelectedVmId] = useState("");
  const [session, setSession] = useState<VmConsoleSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const [takeoverMode, setTakeoverMode] = useState(false);
  const [router, setRouter] = useState<RouterView | null>(null);
  const [worker, setWorker] = useState<WorkerView | null>(null);
  const [tools, setTools] = useState<RouterToolDefinition[]>([]);
  const [toolCalls, setToolCalls] = useState<RouterToolCallRecord[]>([]);
  const sidebarRef = useModalFocus<HTMLElement>(open && modal, onClose);
  const activeSessionRef = useRef<VmConsoleSession | null>(null);

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "activity" ? "vm" : "activity";
    onTabChange(next);
    requestAnimationFrame(() => document.getElementById(`observer-tab-${next}`)?.focus());
  }

  const loadVms = useCallback(async (): Promise<void> => {
    try {
      const response = await api.vms();
      setVms(response.items);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const loadActivity = useCallback(async (): Promise<void> => {
    try {
      const [nextRouter, nextTools, nextCalls, nextWorker] = await Promise.all([
        api.router(),
        api.routerTools(),
        api.routerToolCalls(50),
        workerId ? api.worker(workerId) : Promise.resolve(null),
      ]);
      setRouter(nextRouter);
      setTools(nextTools);
      setToolCalls(nextCalls);
      setWorker(nextWorker);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [workerId]);

  useEffect(() => {
    if (!open || tab !== "vm") return;
    void loadVms();
  }, [open, tab, revision, loadVms]);

  useEffect(() => {
    if (!open || tab !== "activity") return;
    void loadActivity();
  }, [open, tab, revision, loadActivity]);

  useEffect(() => {
    if (!open || tab !== "vm") return;
    setSelectedVmId((current) => {
      if (preferredVmId && vms.some((item) => item.vm.id === preferredVmId)) {
        return preferredVmId;
      }
      if (current && vms.some((item) => item.vm.id === current)) return current;
      return vms.find((item) => item.vm.powerState === "running")?.vm.id ?? vms[0]?.vm.id ?? "";
    });
  }, [open, tab, preferredVmId, vms]);

  useEffect(() => {
    setTakeoverMode(false);
  }, [open, tab, selectedVmId]);

  const releaseActiveSession = useCallback((): void => {
    const active = activeSessionRef.current;
    activeSessionRef.current = null;
    if (active?.lease) {
      void api.releaseVmLease(active.vmId, active.lease.id).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!open || tab !== "vm" || !selectedVmId) {
      releaseActiveSession();
      setSession(null);
      return;
    }
    let cancelled = false;
    // Replacing a console session must release the previous human Lease
    // immediately; dropping the object alone would leave it until the TTL.
    releaseActiveSession();
    setConnecting(true);
    setError(null);
    setSession(null);
    void api
      .openVmConsole(selectedVmId, { viewOnly: !takeoverMode })
      .then((next) => {
        if (cancelled) {
          // The effect was replaced or the sidebar closed while the request was
          // in flight. The one-time ticket is ours, so its Lease is too.
          if (next.lease) {
            void api.releaseVmLease(next.vmId, next.lease.id).catch(() => undefined);
          }
          return;
        }
        activeSessionRef.current = next;
        setSession(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setConnecting(false);
      });
    return () => {
      cancelled = true;
      // Unmounting while a session is active must not leave its Lease to the
      // TTL; releasing is idempotent, so the console's own cleanup may repeat it.
      releaseActiveSession();
    };
  }, [open, tab, selectedVmId, connectNonce, takeoverMode, releaseActiveSession]);

  async function takeover(): Promise<void> {
    if (!selectedVmId) return;
    const confirmed = window.confirm(
      "人工接管会立即撤销 AI 当前 Lease，后续 AI 桌面动作会被拒绝。确定进入交互控制台吗？",
    );
    if (!confirmed) return;
    setConnecting(true);
    setError(null);
    setTakeoverMode(true);
    setConnectNonce((value) => value + 1);
  }

  if (!open) return null;

  const selected = vms.find((item) => item.vm.id === selectedVmId) ?? null;
  const status = worker?.worker.status ?? router?.status;

  return (
    <aside
      className="observer-sidebar"
      aria-label="执行观察栏"
      id="observer-sidebar"
      ref={sidebarRef}
      role={modal ? "dialog" : undefined}
      aria-modal={modal || undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <div className="observer-header">
        <h2>执行详情</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="收起观察栏"
          data-dialog-close
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="observer-tabs" role="tablist" aria-label="观察内容">
        <button
          type="button"
          role="tab"
          id="observer-tab-activity"
          aria-controls="observer-panel-activity"
          aria-selected={tab === "activity"}
          tabIndex={tab === "activity" ? 0 : -1}
          onKeyDown={onTabKeyDown}
          className={tab === "activity" ? "active" : ""}
          onClick={() => onTabChange("activity")}
        >
          执行记录
        </button>
        <button
          type="button"
          role="tab"
          id="observer-tab-vm"
          aria-controls="observer-panel-vm"
          aria-selected={tab === "vm"}
          tabIndex={tab === "vm" ? 0 : -1}
          onKeyDown={onTabKeyDown}
          className={tab === "vm" ? "active" : ""}
          onClick={() => onTabChange("vm")}
        >
          VM 画面
        </button>
      </div>

      {tab === "activity" ? (
        <div
          className="observer-body"
          role="tabpanel"
          id="observer-panel-activity"
          aria-labelledby="observer-tab-activity"
        >
          {error && <div className="notice">{error}</div>}
          <div className="activity-summary">
            <strong>
              {status === "running" ? "正在执行" : status === "failed" ? "执行失败" : "当前空闲"}
            </strong>
            <span className="muted small">
              {worker
                ? `${worker.worker.providerId ?? "默认模型"} / ${worker.worker.modelId ?? "默认"}`
                : `${router?.providerId ?? "未配置"} / ${router?.modelId ?? "未配置"}`}
            </span>
          </div>
          <h3>最近工具调用</h3>
          {toolCalls.length === 0 ? (
            <p className="muted small">暂无执行记录</p>
          ) : (
            <ul className="activity-list">
              {toolCalls
                .slice()
                .reverse()
                .map((call) => (
                  <li key={call.id}>
                    <div>
                      <strong>{call.toolName}</strong>
                      <span className="muted small">
                        {new Date(call.createdAt).toLocaleTimeString("zh-CN")}
                      </span>
                    </div>
                    <span className={call.status === "error" ? "error-line" : "muted small"}>
                      {call.status === "error" ? "失败" : "完成"}
                    </span>
                    {call.errorMessage && <p className="error-line">{call.errorMessage}</p>}
                  </li>
                ))}
            </ul>
          )}
          <details className="advanced-details">
            <summary>技术详情</summary>
            {worker && (
              <dl className="runtime-list">
                <div>
                  <dt>RPC</dt>
                  <dd>{worker.runtime.connected ? "已连接" : "未连接"}</dd>
                </div>
                <div>
                  <dt>会话恢复</dt>
                  <dd>{worker.runtime.restoreMode ?? "—"}</dd>
                </div>
              </dl>
            )}
            <h4>可用工具（{tools.length}）</h4>
            <ul className="activity-list">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <div>
                    <strong>{tool.name}</strong>
                    <span className="muted small">{tool.description}</span>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : (
        <div
          className="observer-body"
          role="tabpanel"
          id="observer-panel-vm"
          aria-labelledby="observer-tab-vm"
        >
          {error && <div className="notice">{error}</div>}
          <label className="field">
            <span>虚拟机</span>
            <Select value={selectedVmId} onChange={(event) => setSelectedVmId(event.target.value)}>
              <option value="">未选择</option>
              {vms.map((item) => (
                <option key={item.vm.id} value={item.vm.id}>
                  {item.vm.name} · {item.vm.powerState === "running" ? "运行中" : "已停止"}
                </option>
              ))}
            </Select>
          </label>
          {connecting && <p className="muted small">正在连接只读画面…</p>}
          {session && selected && (
            <>
              <Suspense fallback={<p className="muted small">正在加载控制台组件…</p>}>
                <VmConsole
                  key={`${selected.vm.id}-${session.viewOnly ? "view" : "takeover"}`}
                  session={session}
                  vmName={selected.vm.name}
                  onClose={() => setSession(null)}
                  onReconnect={() => setConnectNonce((value) => value + 1)}
                />
              </Suspense>
              {session.viewOnly && (
                <button type="button" className="secondary" onClick={() => void takeover()}>
                  人工接管
                </button>
              )}
            </>
          )}
          {!connecting && !session && selected && (
            <button
              type="button"
              className="primary"
              onClick={() => setConnectNonce((value) => value + 1)}
            >
              重新连接
            </button>
          )}
          {!selected && !connecting && <p className="muted small">暂无可用虚拟机。</p>}
        </div>
      )}
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
