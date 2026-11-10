import type { DesktopBridge } from "@agent-in-box/protocol";

declare global {
  interface Window {
    agentInBox?: DesktopBridge;
  }
}

export {};
