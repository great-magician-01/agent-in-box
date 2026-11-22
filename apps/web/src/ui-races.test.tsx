// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const openVmConsole = vi.fn();
const releaseVmLease = vi.fn(async (vmId: string, leaseId: string) => {
  void vmId;
  void leaseId;
  return undefined;
});
const notifications = vi.fn();
const listVms = vi.fn();

vi.mock("./api", () => ({
  api: {
    vms: () => listVms(),
    openVmConsole: (vmId: string, options?: unknown) => openVmConsole(vmId, options),
    releaseVmLease: (vmId: string, leaseId: string) => releaseVmLease(vmId, leaseId),
    notifications: (options?: unknown) => notifications(options),
    markNotificationRead: vi.fn(),
    dismissNotification: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    router: vi.fn(async () => null),
    routerTools: vi.fn(async () => []),
    routerToolCalls: vi.fn(async () => []),
    worker: vi.fn(async () => null),
  },
  ApiRequestError: class ApiRequestError extends Error {},
  subscribeTaskEvents: vi.fn(() => () => undefined),
}));

vi.mock("@novnc/novnc/lib/rfb.js", () => ({
  default: class FakeRfb {
    scaleViewport = false;
    viewOnly = false;
    resizeSession = false;
    showDotCursor = false;
    focusOnClick = false;
    listeners = new Map<string, Array<(event: { detail?: unknown }) => void>>();
    addEventListener(type: string, listener: (event: { detail?: unknown }) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    disconnect(): void {}
    sendCtrlAltDel(): void {}
  },
}));

beforeAll(() => {
  // jsdom does not implement scrollIntoView, which the listbox uses.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function vmInstance(id: string) {
  return {
    vm: {
      id,
      name: id,
      powerState: "running",
      guestHealth: "healthy",
      osFamily: "linux",
      cpuCount: 2,
      memoryMb: 2048,
      diskSizeGb: 20,
      desktop: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function consoleSession(vmId: string, leaseId: string) {
  return {
    vmId,
    webSocketUrl: `/api/v1/vms/${vmId}/console/ws?ticket=t`,
    lease: {
      id: leaseId,
      vmId,
      owner: "human",
      taskId: null,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      renewedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:15.000Z",
      preemptible: true,
    },
    viewOnly: false,
    ticketExpiresAt: "2026-01-01T00:01:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("console Lease cleanup", () => {
  it("releases a console Lease that arrives after the sidebar closed", async () => {
    listVms.mockResolvedValue({ items: [vmInstance("vm-1")] });
    const pending = deferred<unknown>();
    openVmConsole.mockReturnValue(pending.promise);
    const { ObserverSidebar } = await import("./ObserverSidebar");
    const view = render(
      <ObserverSidebar
        open
        tab="vm"
        workerId={null}
        preferredVmId={null}
        revision={0}
        modal={false}
        onTabChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(openVmConsole).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      pending.resolve(consoleSession("vm-1", "lease-late"));
      await pending.promise;
    });
    await waitFor(() => expect(releaseVmLease).toHaveBeenCalledWith("vm-1", "lease-late"));
  });

  it("releases the previous session when switching to another VM", async () => {
    listVms.mockResolvedValue({ items: [vmInstance("vm-1"), vmInstance("vm-2")] });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    openVmConsole.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { ObserverSidebar } = await import("./ObserverSidebar");
    const view = render(
      <ObserverSidebar
        open
        tab="vm"
        workerId={null}
        preferredVmId="vm-1"
        revision={0}
        modal={false}
        onTabChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(openVmConsole).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(consoleSession("vm-1", "lease-a"));
      await first.promise;
    });
    await waitFor(() => expect(screen.getByText("关闭并释放 Lease")).toBeTruthy());

    view.rerender(
      <ObserverSidebar
        open
        tab="vm"
        workerId={null}
        preferredVmId="vm-2"
        revision={1}
        modal={false}
        onTabChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(openVmConsole).toHaveBeenCalledTimes(2));
    expect(openVmConsole.mock.calls[1]?.[0]).toBe("vm-2");
    await waitFor(() => expect(releaseVmLease).toHaveBeenCalledWith("vm-1", "lease-a"));
  });

  it("releases the Lease when a console unmounts before the RFB connection exists", async () => {
    vi.useFakeTimers();
    try {
      const { VmConsole } = await import("./VmConsole");
      const view = render(
        <VmConsole
          session={consoleSession("vm-1", "lease-early") as never}
          vmName="vm-1"
          onClose={() => undefined}
          onReconnect={() => undefined}
        />,
      );
      // No timer has run yet, so the RFB object was never created.
      view.unmount();
      await act(async () => {
        vi.runOnlyPendingTimers();
      });
      expect(releaseVmLease).toHaveBeenCalledWith("vm-1", "lease-early");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notification refresh", () => {
  it("runs a refresh requested while another request is in flight", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    notifications.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { useNotificationCenter } = await import("./NotificationCenter");
    const { result } = renderHook(() => useNotificationCenter(null, () => undefined));
    await waitFor(() => expect(notifications).toHaveBeenCalledTimes(1));
    await act(async () => {
      void result.current.reload();
    });
    expect(notifications).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ items: [], unread: 0 });
      await first.promise;
    });
    await waitFor(() => expect(notifications).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve({ items: [], unread: 0 });
      await second.promise;
    });
  });

  it("surfaces a failed refresh", async () => {
    notifications.mockRejectedValueOnce(new Error("network down"));
    const { useNotificationCenter } = await import("./NotificationCenter");
    const { result } = renderHook(() => useNotificationCenter(null, () => undefined));
    await waitFor(() => expect(result.current.error).toContain("network down"));
  });
});

describe("Select inside a modal", () => {
  it("closes only the listbox on Escape and restores focus to the trigger", async () => {
    const { Select } = await import("./Select");
    const { useModalFocus } = await import("./useModalFocus");
    const onClose = vi.fn();
    function Dialog(): React.JSX.Element {
      const ref = useModalFocus<HTMLDivElement>(true, onClose);
      return (
        <div ref={ref} tabIndex={-1}>
          <button type="button" data-dialog-close>
            close
          </button>
          <Select value="a" onChange={() => undefined} aria-label="choice">
            <option value="a">Alpha</option>
            <option value="b">Beta</option>
          </Select>
        </div>
      );
    }
    render(<Dialog />);
    const trigger = screen.getByRole("button", { name: "choice" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    // The modal's initial focus runs in requestAnimationFrame; wait for it to
    // settle, then reopen so the listbox owns focus.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Close and reopen so the open-transition focus effect runs after the
    // modal's own requestAnimationFrame focus pass.
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox")));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
