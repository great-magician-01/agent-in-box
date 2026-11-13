/* eslint-disable react-hooks/set-state-in-effect -- VM/worker snapshots refresh from server events */
import { useCallback, useEffect, useState } from "react";
import type { VmConsoleSession, VmInstanceView } from "@agent-in-box/protocol";
import { api } from "./api";
import { VmConsole } from "./VmConsole";
import { WorkerConversation } from "./WorkerConversation";

export type ObserverTab = "vm" | "worker";

interface ObserverSidebarProps {
  open: boolean;
  tab: ObserverTab;
  workerId: string | null;
  preferredVmId: string | null;
  revision: number;
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
  onTabChange,
  onClose,
  onChanged,
}: ObserverSidebarProps): React.JSX.Element | null {
  const [vms, setVms] = useState<VmInstanceView[]>([]);
  const [selectedVmId, setSelectedVmId] = useState("");
  const [session, setSession] = useState<VmConsoleSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);

  const loadVms = useCallback(async (): Promise<void> => {
    try {
      const response = await api.vms();
      setVms(response.items);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    if (!open || tab !== "vm") return;
    void loadVms();
  }, [open, tab, revision, loadVms]);

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
    if (!open || tab !== "vm" || !selectedVmId) {
      setSession(null);
      return;
    }
    let cancelled = false;
    setConnecting(true);
    setError(null);
    setSession(null);
    void api
      .openVmConsole(selectedVmId, { viewOnly: true })
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setConnecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, selectedVmId, connectNonce]);

  async function takeover(): Promise<void> {
    if (!selectedVmId) return;
    const confirmed = window.confirm(
      "人工接管会立即撤销 AI 当前 Lease，后续 AI 桌面动作会被拒绝。确定进入交互控制台吗？",
    );
    if (!confirmed) return;
    setConnecting(true);
    setError(null);
    try {
      setSession(await api.openVmConsole(selectedVmId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setConnecting(false);
    }
  }

  if (!open) return null;

  const selected = vms.find((item) => item.vm.id === selectedVmId) ?? null;

  return (
    <aside className="observer-sidebar" aria-label="Agent 观察栏">
      <div className="observer-header">
        <div>
          <h2>观察</h2>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="observer-tabs" role="tablist" aria-label="观察内容">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "vm"}
          className={tab === "vm" ? "active" : ""}
          onClick={() => onTabChange("vm")}
        >
          VM 画面
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "worker"}
          className={tab === "worker" ? "active" : ""}
          onClick={() => onTabChange("worker")}
        >
          Worker 会话
        </button>
      </div>

      {tab === "worker" ? (
        <div className="observer-body">
          <WorkerConversation
            workerId={workerId}
            revision={revision}
            compact
            {...(onChanged ? { onChanged } : {})}
          />
        </div>
      ) : (
        <div className="observer-body">
          {error && <div className="notice">{error}</div>}
          <label className="field">
            <span>观察 VM</span>
            <select value={selectedVmId} onChange={(event) => setSelectedVmId(event.target.value)}>
              <option value="">未选择</option>
              {vms.map((item) => (
                <option key={item.vm.id} value={item.vm.id}>
                  {item.vm.name} · {item.vm.powerState}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            只读观察不会获取 Execution Lease，也不会向虚拟机发送键盘、鼠标或剪贴板输入。
          </p>
          {connecting && <p className="muted small">正在建立只读观察连接…</p>}
          {session && selected && (
            <>
              <VmConsole
                key={`${selected.vm.id}-${session.viewOnly ? "view" : "takeover"}`}
                session={session}
                vmName={selected.vm.name}
                onClose={() => setSession(null)}
                onReconnect={() => setConnectNonce((value) => value + 1)}
              />
              {session.viewOnly && (
                <button type="button" className="secondary" onClick={() => void takeover()}>
                  人工接管（会撤销 AI Lease）
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
              连接观察
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
