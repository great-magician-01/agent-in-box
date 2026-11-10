import { useEffect, useState } from "react";
import type { HealthResponse } from "@agent-in-box/protocol";
import { cx } from "@agent-in-box/ui";

type Connection =
  | { state: "checking" }
  | { state: "online"; health: HealthResponse }
  | { state: "offline"; message: string };

const SCAFFOLD_ITEMS = [
  "pnpm Monorepo 与共享 TypeScript 配置",
  "协议、领域状态机、配置与 Computer Use 动作校验",
  "NestJS 本地控制平面与健康检查",
  "React 本地 Web 入口与 Electron 壳",
  "Go VM Supervisor / Guest Agent 健康服务骨架",
];

export function App(): React.JSX.Element {
  const [connection, setConnection] = useState<Connection>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function check(): Promise<void> {
      try {
        const response = await fetch("/api/v1/health", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const health = (await response.json()) as HealthResponse;
        if (!cancelled) {
          setConnection({ state: "online", health });
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setConnection({
          state: "offline",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    void check();
    const timer = window.setInterval(() => void check(), 5000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">LOCAL-FIRST AI COMPUTER</p>
          <h1>Agent-in-Box</h1>
          <p className="subtitle">Windows 宿主机运行 Linux VM 的应用骨架已经启动。</p>
        </div>
        <div className={cx("status", connection.state)}>
          <span className="dot" />
          {connection.state === "online"
            ? `控制平面在线 · ${connection.health.protocolVersion}`
            : connection.state === "offline"
              ? "控制平面离线"
              : "正在连接控制平面"}
        </div>
      </header>

      {connection.state === "offline" && (
        <section className="notice">
          <strong>无法连接本地控制平面。</strong>
          <span>{connection.message}</span>
          <code>pnpm --filter @agent-in-box/control-plane dev</code>
        </section>
      )}

      <section className="grid">
        <article className="card">
          <h2>本地控制平面</h2>
          <p>承载项目、任务、Worker 注册表、调度和机器人连接。</p>
          <dl>
            <div>
              <dt>地址</dt>
              <dd>127.0.0.1:3000</dd>
            </div>
            <div>
              <dt>协议版本</dt>
              <dd>{connection.state === "online" ? connection.health.protocolVersion : "—"}</dd>
            </div>
            <div>
              <dt>启动时间</dt>
              <dd>
                {connection.state === "online"
                  ? new Date(connection.health.startedAt).toLocaleTimeString()
                  : "—"}
              </dd>
            </div>
          </dl>
        </article>

        <article className="card muted">
          <h2>VM 运行时</h2>
          <p>镜像下载、Linux VM 生命周期和 Guest Agent 尚未接入。</p>
          <span className="tag">下一阶段</span>
        </article>

        <article className="card muted">
          <h2>Worker 运行时</h2>
          <p>Pi Worker 与 Computer Use 工具将在技术验证后接入。</p>
          <span className="tag">下一阶段</span>
        </article>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>脚手架已落地</h2>
          <span>阶段 1.1 / 1.2</span>
        </div>
        <ul className="checklist">
          {SCAFFOLD_ITEMS.map((item) => (
            <li key={item}>
              <span className="check">✓</span>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <footer className="footer">
        <span>本页面不连接模型，也不操作任何 VM。</span>
        <span>开发命令见 README.md</span>
      </footer>
    </main>
  );
}
