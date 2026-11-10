import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageArtifactManifest } from "@agent-in-box/protocol";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 200;

export class ImageDownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ImageDownloadError";
  }
}

export interface ImageDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  resumedFrom: number;
  rangeIgnored: boolean;
}

export interface ImageDownloadResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  alreadyPresent: boolean;
  resumedFrom: number;
  rangeIgnored: boolean;
}

export interface ImageDownloaderOptions {
  allowedHosts: string[];
  maxBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function validateDescriptor(
  descriptor: ImageArtifactManifest,
  allowedHosts: Set<string>,
  maxBytes: number,
): URL {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(descriptor.fileName)) {
    throw new ImageDownloadError("invalid_manifest", `不安全的镜像文件名：${descriptor.fileName}`);
  }
  if (
    descriptor.fileName === "." ||
    descriptor.fileName === ".." ||
    descriptor.fileName.endsWith(".")
  ) {
    throw new ImageDownloadError("invalid_manifest", `不安全的镜像文件名：${descriptor.fileName}`);
  }
  if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 0) {
    throw new ImageDownloadError("invalid_manifest", "镜像大小必须是非负安全整数");
  }
  if (descriptor.sizeBytes > maxBytes) {
    throw new ImageDownloadError("size_exceeded", "镜像超过允许的大小上限");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(descriptor.sha256)) {
    throw new ImageDownloadError("invalid_manifest", "镜像必须提供 64 位 SHA-256");
  }

  let parsed: URL;
  try {
    parsed = new URL(descriptor.url);
  } catch {
    throw new ImageDownloadError("invalid_manifest", "镜像 URL 无效");
  }
  validateSource(parsed, allowedHosts);
  return parsed;
}

function validateSource(url: URL, allowedHosts: Set<string>): void {
  const hostname = normalizeHost(url.hostname);
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    !allowedHosts.has(hostname)
  ) {
    throw new ImageDownloadError(
      "source_forbidden",
      `镜像来源不在白名单或协议不安全：${url.hostname}`,
    );
  }
  if (url.username || url.password) {
    throw new ImageDownloadError("source_forbidden", "镜像 URL 不得包含内嵌凭据");
  }
}

async function assertRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ImageDownloadError("unsafe_target", `镜像目标不是普通文件：${filePath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk: Buffer) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

async function matches(filePath: string, descriptor: ImageArtifactManifest): Promise<boolean> {
  if (!(await assertRegularFile(filePath))) {
    return false;
  }
  const info = await stat(filePath);
  if (descriptor.sizeBytes > 0 && info.size !== descriptor.sizeBytes) {
    return false;
  }
  return (await hashFile(filePath)) === descriptor.sha256.toLowerCase();
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) {
    throw new ImageDownloadError("invalid_response", "服务器缺少有效的 Content-Range");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? 0 : Number(match[3]);
  if (
    ![start, end, total].every(Number.isSafeInteger) ||
    end < start ||
    (total > 0 && end >= total)
  ) {
    throw new ImageDownloadError("invalid_response", "服务器返回了无效的 Content-Range");
  }
  return { start, end, total };
}

export interface DownloadRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ImageDownloadProgress) => void | Promise<void>;
  onVerifying?: () => void | Promise<void>;
}

/**
 * Downloads one immutable artifact. The final path never exists until its size
 * and SHA-256 have both been verified. Partial bytes survive cancellation and
 * process termination; integrity failures remove them instead of resuming bad data.
 */
export class ResumableImageDownloader {
  private readonly allowedHosts: Set<string>;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly imagesDirectory: string,
    options: ImageDownloaderOptions,
  ) {
    this.allowedHosts = new Set(options.allowedHosts.map(normalizeHost).filter(Boolean));
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async download(
    descriptor: ImageArtifactManifest,
    options: DownloadRunOptions = {},
  ): Promise<ImageDownloadResult> {
    const source = validateDescriptor(descriptor, this.allowedHosts, this.maxBytes);
    await mkdir(this.imagesDirectory, { recursive: true, mode: 0o700 });
    const finalPath = path.join(this.imagesDirectory, descriptor.fileName);
    const partialPath = `${finalPath}.partial`;

    await options.onVerifying?.();
    if (await matches(finalPath, descriptor)) {
      const info = await stat(finalPath);
      return {
        path: finalPath,
        sizeBytes: info.size,
        sha256: descriptor.sha256.toLowerCase(),
        alreadyPresent: true,
        resumedFrom: 0,
        rangeIgnored: false,
      };
    }
    if (await assertRegularFile(finalPath)) {
      await rm(finalPath);
    }

    let offset = 0;
    if (await assertRegularFile(partialPath)) {
      offset = (await stat(partialPath)).size;
      if (offset > this.maxBytes || (descriptor.sizeBytes > 0 && offset > descriptor.sizeBytes)) {
        await rm(partialPath);
        offset = 0;
      }
    }
    if (offset > 0 && offset === descriptor.sizeBytes) {
      if (await matches(partialPath, descriptor)) {
        await rename(partialPath, finalPath);
        return {
          path: finalPath,
          sizeBytes: offset,
          sha256: descriptor.sha256.toLowerCase(),
          alreadyPresent: false,
          resumedFrom: offset,
          rangeIgnored: false,
        };
      }
      await rm(partialPath, { force: true });
      offset = 0;
    }

    try {
      return await this.fetchToDisk(source, descriptor, finalPath, partialPath, offset, options);
    } catch (error) {
      if (error instanceof ImageDownloadError) {
        throw error;
      }
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ImageDownloadError("download_cancelled", "下载已取消，可稍后从断点继续", true);
      }
      throw new ImageDownloadError(
        "network_error",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  private async fetchToDisk(
    source: URL,
    descriptor: ImageArtifactManifest,
    finalPath: string,
    partialPath: string,
    initialOffset: number,
    options: DownloadRunOptions,
  ): Promise<ImageDownloadResult> {
    const response = await this.openResponse(source, initialOffset, options.signal);
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      await response.body?.cancel();
      throw new ImageDownloadError("invalid_response", "镜像响应不得使用内容压缩");
    }

    let writeOffset = initialOffset;
    let totalBytes = descriptor.sizeBytes;
    let rangeIgnored = false;
    let integrityFailure = false;
    if (response.status === 200) {
      if (initialOffset > 0) {
        writeOffset = 0;
        rangeIgnored = true;
      }
      const declared = Number(response.headers.get("content-length") ?? -1);
      if (declared >= 0) {
        if (
          declared > this.maxBytes ||
          (descriptor.sizeBytes > 0 && declared !== descriptor.sizeBytes)
        ) {
          await response.body?.cancel();
          await rm(partialPath, { force: true });
          throw new ImageDownloadError("size_mismatch", "服务器声明的镜像大小与 Manifest 不一致");
        }
        totalBytes ||= declared;
      }
    } else if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (range.start !== initialOffset) {
        await response.body?.cancel();
        await rm(partialPath, { force: true });
        throw new ImageDownloadError("invalid_response", "服务器续传起点与本地文件不一致");
      }
      if (descriptor.sizeBytes > 0 && range.total !== descriptor.sizeBytes) {
        await response.body?.cancel();
        await rm(partialPath, { force: true });
        throw new ImageDownloadError("size_mismatch", "服务器续传总大小与 Manifest 不一致");
      }
      totalBytes ||= range.total;
    } else {
      await response.body?.cancel();
      if (response.status === 416) {
        await rm(partialPath, { force: true });
        throw new ImageDownloadError("range_rejected", "服务器拒绝续传范围，请从头重试", true);
      }
      throw new ImageDownloadError(
        "http_status",
        `镜像服务器返回 HTTP ${response.status}`,
        response.status >= 500,
      );
    }

    let lastProgress = 0;
    const report = async (force = false): Promise<void> => {
      const now = this.now();
      if (options.onProgress && (force || now - lastProgress >= PROGRESS_INTERVAL_MS)) {
        lastProgress = now;
        await options.onProgress({
          downloadedBytes: writeOffset,
          totalBytes,
          resumedFrom: rangeIgnored ? 0 : initialOffset,
          rangeIgnored,
        });
      }
    };

    const file = await open(partialPath, writeOffset > 0 ? "r+" : "w", 0o600);
    try {
      await report(true);
      if (!response.body) {
        throw new ImageDownloadError("invalid_response", "镜像响应没有正文");
      }
      const reader = response.body.getReader();
      while (true) {
        if (options.signal?.aborted) {
          throw new ImageDownloadError("download_cancelled", "下载已取消，可稍后从断点继续", true);
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value.byteLength === 0) {
          continue;
        }
        const nextOffset = writeOffset + value.byteLength;
        if (
          nextOffset > this.maxBytes ||
          (descriptor.sizeBytes > 0 && nextOffset > descriptor.sizeBytes)
        ) {
          integrityFailure = true;
          throw new ImageDownloadError("size_exceeded", "镜像数据超过 Manifest 或大小上限");
        }
        let written = 0;
        while (written < value.byteLength) {
          const result = await file.write(
            value,
            written,
            value.byteLength - written,
            writeOffset + written,
          );
          written += result.bytesWritten;
        }
        writeOffset = nextOffset;
        await report();
      }
      await file.sync();
      await report(true);
    } catch (error) {
      if (
        integrityFailure ||
        (error instanceof ImageDownloadError && error.code === "size_exceeded")
      ) {
        await rm(partialPath, { force: true });
      }
      throw error;
    } finally {
      await file.close();
    }

    if (descriptor.sizeBytes > 0 && writeOffset !== descriptor.sizeBytes) {
      await rm(partialPath, { force: true });
      throw new ImageDownloadError(
        "size_mismatch",
        `镜像只有 ${writeOffset} 字节，预期 ${descriptor.sizeBytes} 字节`,
      );
    }
    await options.onVerifying?.();
    const actualChecksum = await hashFile(partialPath);
    if (actualChecksum !== descriptor.sha256.toLowerCase()) {
      await rm(partialPath, { force: true });
      throw new ImageDownloadError("checksum_mismatch", "镜像 SHA-256 校验失败，未启用该文件");
    }
    await rename(partialPath, finalPath);
    return {
      path: finalPath,
      sizeBytes: writeOffset,
      sha256: actualChecksum,
      alreadyPresent: false,
      resumedFrom: rangeIgnored ? 0 : initialOffset,
      rangeIgnored,
    };
  }

  private async openResponse(source: URL, offset: number, signal?: AbortSignal): Promise<Response> {
    let current = source;
    for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
      const headers = new Headers({
        "accept-encoding": "identity",
        "user-agent": "agent-in-box/0.1",
      });
      if (offset > 0) {
        headers.set("range", `bytes=${offset}-`);
      }
      const response = await this.fetchImpl(current, {
        headers,
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === this.maxRedirects) {
        throw new ImageDownloadError("too_many_redirects", "镜像重定向次数超过上限");
      }
      current = new URL(location, current);
      validateSource(current, this.allowedHosts);
    }
    throw new ImageDownloadError("too_many_redirects", "镜像重定向次数超过上限");
  }
}
