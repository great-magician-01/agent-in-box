/* global window, document */
// Apply the persisted theme before first paint. This is an external script so
// the control-plane's script-src 'self' Content Security Policy allows it.
try {
  var theme = window.localStorage.getItem("agent-in-box:theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // Storage unavailable; fall back to the system preference.
}
