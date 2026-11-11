import { useEffect, useState } from "react";
import type {
  CloseBehavior,
  DesktopAppStatus,
  DesktopBridge,
  DesktopCredentialStatus,
  DesktopPreferences,
  DesktopPreferencesPatch,
} from "@agent-in-box/protocol";

export function desktopBridge(): DesktopBridge | null {
  return typeof window !== "undefined" ? (window.agentInBox ?? null) : null;
}

export interface DesktopState {
  bridge: DesktopBridge | null;
  status: DesktopAppStatus | null;
  error: string | null;
}

export function useDesktop(): DesktopState {
  const [bridge] = useState<DesktopBridge | null>(() => desktopBridge());
  const [status, setStatus] = useState<DesktopAppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    const unsubscribe = bridge.app.onStatus((next) => {
      if (!cancelled) {
        setStatus(next);
        setError(null);
      }
    });
    void bridge.app
      .status()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  return { bridge, status, error };
}

export async function chooseDirectory(
  bridge: DesktopBridge | null,
  input?: { title?: string; defaultPath?: string },
): Promise<string | null> {
  if (!bridge) {
    return null;
  }
  return bridge.dialog.chooseDirectory(input);
}

export async function readPreferences(
  bridge: DesktopBridge | null,
): Promise<DesktopPreferences | null> {
  if (!bridge) {
    return null;
  }
  return bridge.config.getPreferences();
}

export async function savePreferences(
  bridge: DesktopBridge | null,
  patch: DesktopPreferencesPatch,
): Promise<DesktopPreferences | null> {
  if (!bridge) {
    return null;
  }
  return bridge.config.setPreferences(patch);
}

export async function saveCloseBehavior(
  bridge: DesktopBridge | null,
  value: CloseBehavior,
): Promise<void> {
  await savePreferences(bridge, { closeBehavior: value });
}

export async function credentialStatus(
  bridge: DesktopBridge | null,
): Promise<DesktopCredentialStatus | null> {
  if (!bridge) {
    return null;
  }
  return bridge.credentials.status();
}
