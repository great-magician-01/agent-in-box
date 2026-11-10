/**
 * Minimal RFB framing used at the trust boundary. The proxy forwards the
 * unauthenticated QEMU handshake, then understands client message boundaries so
 * keyboard, pointer and clipboard input can be checked against the VM Lease.
 */
export class VncServerHandshake {
  private buffer = Buffer.alloc(0);
  private stage: "version" | "security-count" | "security-types" | "security-result" | "init" =
    "version";
  private securityBytes = 0;
  private nameBytes = -1;
  private complete = false;

  get done(): boolean {
    return this.complete;
  }

  feed(chunk: Buffer): void {
    if (this.complete) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.complete) {
      if (this.stage === "version") {
        if (this.buffer.length < 12) return;
        if (!/^RFB \d{3}\.\d{3}\n$/.test(this.buffer.subarray(0, 12).toString("ascii"))) {
          throw new Error("Invalid RFB version");
        }
        this.consume(12);
        this.stage = "security-count";
      } else if (this.stage === "security-count") {
        if (this.buffer.length < 1) return;
        this.securityBytes = this.buffer[0] ?? 0;
        this.consume(1);
        if (this.securityBytes === 0) throw new Error("RFB server rejected the connection");
        this.stage = "security-types";
      } else if (this.stage === "security-types") {
        if (this.buffer.length < this.securityBytes) return;
        if (!this.buffer.subarray(0, this.securityBytes).includes(1)) {
          throw new Error("RFB server does not offer the loopback no-auth security type");
        }
        this.consume(this.securityBytes);
        this.stage = "security-result";
      } else if (this.stage === "security-result") {
        if (this.buffer.length < 4) return;
        if (this.buffer.readUInt32BE(0) !== 0) throw new Error("RFB security negotiation failed");
        this.consume(4);
        this.stage = "init";
      } else {
        if (this.nameBytes < 0) {
          if (this.buffer.length < 24) return;
          this.nameBytes = this.buffer.readUInt32BE(20);
          if (this.nameBytes > 64 * 1024) throw new Error("RFB desktop name is too large");
          this.consume(24);
        }
        if (this.buffer.length < this.nameBytes) return;
        this.consume(this.nameBytes);
        this.complete = true;
      }
    }
  }

  private consume(bytes: number): void {
    this.buffer = this.buffer.subarray(bytes);
  }
}

export interface VncClientFrame {
  data: Buffer;
  requiresLease: boolean;
}

export interface VncNegotiationResult {
  negotiation: Buffer[];
  pending: Buffer;
}

/** Only the three exact RFB 3.8 no-auth client negotiation messages may pass
 * before ServerInit. Everything later is buffered for Lease-aware framing. */
export class VncClientNegotiation {
  private buffer = Buffer.alloc(0);
  private stage: "version" | "security" | "init" | "done" = "version";

  feed(chunk: Buffer): VncNegotiationResult {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const negotiation: Buffer[] = [];
    while (this.stage !== "done") {
      const needed = this.stage === "version" ? 12 : 1;
      if (this.buffer.length < needed) break;
      const message = this.buffer.subarray(0, needed);
      this.buffer = this.buffer.subarray(needed);
      if (this.stage === "version" && message.toString("ascii") !== "RFB 003.008\n") {
        throw new Error("Only RFB 3.8 clients are supported");
      }
      if (this.stage === "security" && message[0] !== 1) {
        throw new Error("Only loopback no-auth RFB negotiation is supported");
      }
      negotiation.push(message);
      this.stage =
        this.stage === "version" ? "security" : this.stage === "security" ? "init" : "done";
    }
    if (this.buffer.length > 1024 * 1024) throw new Error("RFB pre-init buffer is too large");
    const pending = this.buffer;
    this.buffer = Buffer.alloc(0);
    return { negotiation, pending };
  }
}

export class VncClientFramer {
  private buffer = Buffer.alloc(0);

  feed(chunk: Buffer): VncClientFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: VncClientFrame[] = [];
    while (this.buffer.length > 0) {
      const length = clientMessageLength(this.buffer);
      if (length === null) break;
      const data = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      const type = data[0];
      frames.push({
        data,
        requiresLease: type === 4 || type === 5 || type === 6 || type === 255,
      });
    }
    return frames;
  }
}

function clientMessageLength(buffer: Buffer): number | null {
  const type = buffer[0];
  switch (type) {
    case 0: // SetPixelFormat
      return buffer.length >= 20 ? 20 : null;
    case 2: // SetEncodings
      if (buffer.length < 4) return null;
      return checkedLength(buffer, 4 + buffer.readUInt16BE(2) * 4);
    case 3: // FramebufferUpdateRequest
      return buffer.length >= 10 ? 10 : null;
    case 4: // KeyEvent
      return buffer.length >= 8 ? 8 : null;
    case 5: // PointerEvent
      return buffer.length >= 6 ? 6 : null;
    case 6: // ClientCutText
      if (buffer.length < 8) return null;
      return checkedLength(buffer, 8 + buffer.readUInt32BE(4));
    case 255: // QEMU Extended Key Event
      if (buffer.length < 2) return null;
      if (buffer[1] !== 0) throw new Error("Unsupported RFB QEMU client submessage");
      return buffer.length >= 12 ? 12 : null;
    default:
      throw new Error(`Unsupported RFB client message type: ${String(type)}`);
  }
}

function checkedLength(buffer: Buffer, length: number): number | null {
  if (length > 1024 * 1024) throw new Error("RFB client message is too large");
  return buffer.length >= length ? length : null;
}
