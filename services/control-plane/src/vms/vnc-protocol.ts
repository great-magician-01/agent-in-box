import net from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { createHash } from "node:crypto";

/**
 * RFB framing used at the trust boundary.
 *
 * The browser only ever speaks RFB 3.8 with the "None" security type to this
 * proxy. The proxy performs the real upstream negotiation itself: a plain
 * loopback no-auth handshake for legacy VMs, or VeNCrypt inside TLS with a
 * pinned per-VM certificate for current VMs. Upstream security bytes are never
 * forwarded to the renderer.
 */

const RFB_VERSION = "RFB 003.008\n";

export interface VncTlsOptions {
  ca: string;
  cert: string;
  key: string;
  /** Lowercase hex SHA-256 of the upstream server certificate. */
  fingerprint: string;
}

export interface VncUpstreamOptions {
  /** TLS is mandatory; a plain no-auth upstream is rejected. */
  requireTls: boolean;
  tls?: VncTlsOptions;
}

/**
 * Exact-length reads in paused mode.
 *
 * Reading with socket.read(n) (instead of a "data" listener) leaves every byte
 * beyond the requested count in the socket's internal buffer. That matters
 * because the upstream connection is upgraded to TLS mid-stream: a flowing
 * socket would have already drained the ServerInit or TLS bytes into user space
 * where the TLS wrapper can never see them.
 */
export class ByteStream {
  constructor(private readonly socket: net.Socket | TLSSocket) {}

  async readExactly(count: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    let collected = Buffer.alloc(0);
    while (collected.length < count) {
      const chunk = this.socket.read(count - collected.length);
      if (chunk) {
        collected = Buffer.concat([collected, chunk as Buffer]);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("RFB negotiation timed out");
      await this.waitReadable(remaining);
    }
    return collected;
  }

  private waitReadable(timeoutMs: number): Promise<void> {
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("RFB negotiation timed out"));
      }, timeoutMs);
      timer.unref();
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("RFB server closed the connection during negotiation"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("readable", onReadable);
        socket.off("close", onClose);
        socket.off("end", onClose);
        socket.off("error", onError);
      };
      socket.once("readable", onReadable);
      socket.once("close", onClose);
      socket.once("end", onClose);
      socket.once("error", onError);
    });
  }
}

export interface VncUpstreamResult {
  /** Socket carrying RFB application data (TLS socket for VeNCrypt). */
  socket: net.Socket | TLSSocket;
}

const VENCRYPT_SECURITY_TYPE = 19;
const VENCRYPT_X509_NONE = 256;
const VENCRYPT_X509_VNC = 257;

/**
 * Negotiates the upstream VNC security handshake and returns the socket that
 * carries RFB messages (the TLS socket for VeNCrypt). The caller attaches its
 * data handler only after this resolves, so no security or TLS bytes can leak
 * to the renderer.
 */
export async function negotiateVncUpstream(
  socket: net.Socket,
  options: VncUpstreamOptions,
  timeoutMs = 15_000,
): Promise<VncUpstreamResult> {
  const stream = new ByteStream(socket);
  // Paused mode is the whole point: bytes past the security result must stay in
  // the socket so the TLS wrapper (or the caller's data handler) sees them.
  socket.pause();
  const version = await stream.readExactly(12, timeoutMs);
  if (!/^RFB \d{3}\.\d{3}\n$/.test(version.toString("ascii"))) {
    throw new Error("Invalid RFB version from VNC server");
  }
  socket.write(RFB_VERSION);

  const count = (await stream.readExactly(1, timeoutMs))[0] ?? 0;
  if (count === 0) throw new Error("VNC server rejected the connection");
  const types = await stream.readExactly(count, timeoutMs);

  if (types.includes(VENCRYPT_SECURITY_TYPE)) {
    if (!options.tls) {
      throw new Error("VNC server requires VeNCrypt but no certificate was configured");
    }
    socket.write(Buffer.from([VENCRYPT_SECURITY_TYPE]));
    const major = (await stream.readExactly(1, timeoutMs))[0] ?? 0;
    const minor = (await stream.readExactly(1, timeoutMs))[0] ?? 0;
    if (major !== 0 || minor > 2) {
      throw new Error(`Unsupported VeNCrypt version ${major}.${minor}`);
    }
    const subtypeCount = (await stream.readExactly(1, timeoutMs))[0] ?? 0;
    if (subtypeCount === 0) throw new Error("VeNCrypt offered no subtypes");
    const raw = await stream.readExactly(subtypeCount * 4, timeoutMs);
    const subtypes: number[] = [];
    for (let index = 0; index < subtypeCount; index += 1) {
      subtypes.push(raw.readUInt32BE(index * 4));
    }
    const subtype = subtypes.includes(VENCRYPT_X509_VNC)
      ? VENCRYPT_X509_VNC
      : subtypes.includes(VENCRYPT_X509_NONE)
        ? VENCRYPT_X509_NONE
        : -1;
    if (subtype < 0) {
      throw new Error("VeNCrypt offered no X509 subtype");
    }
    const choice = Buffer.alloc(4);
    choice.writeUInt32BE(subtype, 0);
    socket.write(choice);

    // The TLS handshake starts immediately after the subtype selection; the
    // client speaks first, so no server bytes can be pending here.
    const secure = tls.connect({
      socket,
      ca: [options.tls.ca],
      cert: options.tls.cert,
      key: options.tls.key,
      servername: "agent-in-box-qemu",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    await onceSecure(secure, timeoutMs);
    const peer = secure.getPeerCertificate();
    if (!peer || !peer.raw || peer.raw.length === 0) {
      throw new Error("VNC server presented no certificate");
    }
    const fingerprint = createHash("sha256").update(peer.raw).digest("hex");
    if (fingerprint !== options.tls.fingerprint.toLowerCase()) {
      throw new Error("VNC server certificate fingerprint mismatch");
    }
    const secureStream = new ByteStream(secure);
    const result = await secureStream.readExactly(4, timeoutMs);
    if (result.readUInt32BE(0) !== 0) {
      throw new Error("VeNCrypt authentication failed");
    }
    return { socket: secure };
  }

  if (types.includes(1) && !options.requireTls) {
    socket.write(Buffer.from([1]));
    const result = await stream.readExactly(4, timeoutMs);
    if (result.readUInt32BE(0) !== 0) {
      throw new Error("RFB security negotiation failed");
    }
    return { socket };
  }

  throw new Error(
    options.requireTls
      ? "VNC server did not offer TLS"
      : "VNC server does not offer the loopback no-auth security type",
  );
}

function onceSecure(socket: tls.TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("VNC TLS handshake timed out"));
    }, timeoutMs);
    timer.unref();
    const onSecure = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("secureConnect", onSecure);
      socket.off("error", onError);
    };
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
  });
}

export interface VncDownstreamResult {
  /** Bytes the proxy must send to the browser for this chunk. */
  reply: Buffer | null;
  /** Client bytes that follow the security choice (forwarded after ServerInit). */
  pending: Buffer;
  done: boolean;
}

/**
 * Consumes the browser's no-auth RFB 3.8 negotiation. The proxy sends the
 * server version and the single "None" security type itself; the client's
 * version and security selection are consumed rather than forwarded upstream.
 */
export class VncDownstreamHandshake {
  private buffer = Buffer.alloc(0);
  private stage: "version" | "security" | "done" = "version";

  feed(chunk: Buffer): VncDownstreamResult {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let reply: Buffer | null = null;
    while (this.stage !== "done") {
      if (this.stage === "version") {
        if (this.buffer.length < 12) break;
        const version = this.buffer.subarray(0, 12);
        if (version.toString("ascii") !== RFB_VERSION) {
          throw new Error("Only RFB 3.8 clients are supported");
        }
        this.buffer = this.buffer.subarray(12);
        reply = Buffer.concat([reply ?? Buffer.alloc(0), Buffer.from([1, 1])]);
        this.stage = "security";
        continue;
      }
      if (this.buffer.length < 1) break;
      const choice = this.buffer[0];
      this.buffer = this.buffer.subarray(1);
      if (choice !== 1) {
        throw new Error("Only the no-auth security type is offered to the client");
      }
      // RFB 3.8 still expects a SecurityResult even for the None type.
      reply = Buffer.concat([reply ?? Buffer.alloc(0), Buffer.alloc(4)]);
      this.stage = "done";
    }
    if (this.buffer.length > 1024 * 1024) throw new Error("RFB pre-init buffer is too large");
    const pending = this.buffer;
    this.buffer = Buffer.alloc(0);
    return { reply, pending, done: this.stage === "done" };
  }
}

export interface VncClientFrame {
  data: Buffer;
  requiresLease: boolean;
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
