import type { CloseBehavior } from "@agent-in-box/protocol";

export interface CloseDecisionInput {
  isQuitting: boolean;
  closeBehavior: CloseBehavior;
  hasTray: boolean;
}

/**
 * Closing the window only keeps the background service alive when the user
 * chose that behavior AND there is a tray entry to reopen the window. Without
 * a tray the process would become unreachable, so closing quits instead.
 */
export function shouldHideWindowOnClose(input: CloseDecisionInput): boolean {
  return !input.isQuitting && input.closeBehavior === "keep_running" && input.hasTray;
}

export function shouldQuitWhenAllWindowsClosed(input: {
  platform: NodeJS.Platform;
  closeBehavior: CloseBehavior;
  hasTray: boolean;
}): boolean {
  if (input.closeBehavior === "quit") {
    return true;
  }
  // macOS keeps the app alive in the dock; Windows/Linux would become an
  // unreachable background process without a tray entry.
  return input.platform !== "darwin" && !input.hasTray;
}
