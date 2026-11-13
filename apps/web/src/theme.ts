export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "agent-in-box:theme";

export function getThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Applies the preference to <html data-theme>; "system" removes the override. */
export function applyThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = preference;
    }
  } catch {
    // Non-browser environment; nothing to apply.
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // Storage unavailable; the override still applies for this session.
  }
}

export function cycleThemePreference(preference: ThemePreference): ThemePreference {
  return preference === "system" ? "light" : preference === "light" ? "dark" : "system";
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "亮色",
  dark: "暗色",
};
