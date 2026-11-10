declare module "@novnc/novnc/lib/rfb.js" {
  interface RfbDisconnectDetail {
    clean: boolean;
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
    scaleViewport: boolean;
    viewOnly: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    focusOnClick: boolean;
    addEventListener(type: "connect", listener: () => void): void;
    addEventListener(
      type: "disconnect",
      listener: (event: CustomEvent<RfbDisconnectDetail>) => void,
    ): void;
    addEventListener(
      type: "desktopname",
      listener: (event: CustomEvent<{ name: string }>) => void,
    ): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    focus(): void;
  }
}
