import type { HostCheck, HostInspectionReport } from "@agent-in-box/protocol";

export function VmSetupGuidance({
  host,
}: {
  host: HostInspectionReport | null;
}): React.JSX.Element {
  const failingChecks = host?.checks.filter((check) => check.status === "error") ?? [];
  const virtualizationCheck = host?.checks.find((check) => check.id === "cpu_virtualization");
  const isWsl = virtualizationCheck?.details?.wsl2 === "true";
  const needsVirtualization = virtualizationCheck?.status === "error";

  return (
    <div className="vm-action-guide">
      <div>
        <strong>按顺序处理后，再点击“重新检查”</strong>
        <p className="muted small">
          虚拟机依赖电脑的系统能力。需要管理员授权或重启时，应用无法替你跳过这些系统步骤。
        </p>
      </div>
      {!host ? (
        <p className="muted small">正在读取这台电脑的具体检查结果…</p>
      ) : (
        <>
          {failingChecks.length > 0 && (
            <ul className="vm-host-issues">
              {failingChecks.map((check) => (
                <li key={check.id}>
                  <span aria-hidden="true">!</span>
                  <div>
                    <strong>{CHECK_LABELS[check.id] ?? "运行条件"}</strong>
                    <p>{check.message}</p>
                    <small>{recoveryHint(check)}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {isWsl ? (
            <div className="vm-system-note">
              当前服务运行在 WSL2 中，这里的检测结果不能替代 Windows 宿主机检查。请启动 Windows
              桌面版 Agent-in-Box，再执行自动准备。
            </div>
          ) : needsVirtualization && host.platform === "win32" ? (
            <ol className="vm-recovery-steps">
              <li>
                <span>1</span>
                <div>
                  <strong>先确认 BIOS / UEFI 已开启硬件虚拟化</strong>
                  <p>
                    Intel 电脑通常叫 VT-x；AMD 电脑通常叫 SVM 或 AMD-V。若已开启，直接跳到下一步。
                  </p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>启用 Windows 虚拟机功能</strong>
                  <p>
                    打开“Windows 功能”，勾选“虚拟机平台”和“Windows
                    虚拟机监控程序平台”。系统提示管理员授权时请允许。
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>重启 Windows，再回来重新检查</strong>
                  <p>重启后重新打开 Agent-in-Box，已完成的模型设置和下载进度会保留。</p>
                </div>
              </li>
            </ol>
          ) : needsVirtualization && host.platform === "linux" ? (
            <ol className="vm-recovery-steps">
              <li>
                <span>1</span>
                <div>
                  <strong>在 BIOS / UEFI 中开启 VT-x 或 AMD-V / SVM</strong>
                  <p>保存设置并重新进入系统。</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>确认当前用户可以使用 /dev/kvm</strong>
                  <p>将当前用户加入 kvm 用户组，注销并重新登录后再检查。</p>
                </div>
              </li>
            </ol>
          ) : null}
        </>
      )}
    </div>
  );
}

const CHECK_LABELS: Record<string, string> = {
  os: "操作系统",
  cpu_virtualization: "硬件虚拟化",
  memory: "可用内存",
  disk: "磁盘空间",
};

function recoveryHint(check: HostCheck): string {
  switch (check.id) {
    case "memory":
      return "关闭其他占用内存的应用；若物理内存低于最低要求，需要在更大内存的电脑上运行。";
    case "disk":
      return "清理磁盘，或在“设置 → 存储”中更换到空间充足的目录。";
    case "os":
      return "请使用受支持的 Windows 10 / 11 版本，并完成系统更新。";
    default:
      return "完成下面的系统设置后，重新检查即可从当前阶段继续。";
  }
}
