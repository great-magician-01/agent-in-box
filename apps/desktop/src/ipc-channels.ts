export const IPC_CHANNELS = {
  appStatus: "agent-in-box:app-status",
  appStatusEvent: "agent-in-box:app-status-event",
  restartControlPlane: "agent-in-box:restart-control-plane",
  quit: "agent-in-box:quit",
  openLogs: "agent-in-box:open-logs",
  chooseDirectory: "agent-in-box:choose-directory",
  getCloseBehavior: "agent-in-box:get-close-behavior",
  setCloseBehavior: "agent-in-box:set-close-behavior",
  credentialsStatus: "agent-in-box:credentials-status",
  credentialsSave: "agent-in-box:credentials-save",
  credentialsRemove: "agent-in-box:credentials-remove",
  rendererLog: "agent-in-box:renderer-log",
} as const;
