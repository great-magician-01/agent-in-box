import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageManifest } from "@agent-in-box/protocol";
import { storageLayout } from "@agent-in-box/config";
import { AppDatabase } from "../persistence/database";
import type { DatabaseService } from "../persistence/database.service";
import { ImageService } from "./image.service";

function bytes(size: number): Buffer {
  return Buffer.alloc(size, 0).map((_, index) => (index * 131 + 17) % 251);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before timeout");
}

describe("ImageService", () => {
  let directory: string;
  let database: AppDatabase;
  let manifestPath: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-images-"));
    database = AppDatabase.open({ filename: path.join(directory, "test.sqlite") });
    await database.migrate();
    manifestPath = path.join(directory, "manifest.json");
  });

  afterEach(async () => {
    await database.close();
    await Promise.all(servers.splice(0).map(close));
    await rm(directory, { recursive: true, force: true });
  });

  function service(options: { autoResume?: boolean } = {}): ImageService {
    return new ImageService({ layout: storageLayout(directory) } as DatabaseService, database.db, {
      manifestPath,
      autoResume: options.autoResume ?? false,
    });
  }

  async function writeManifest(url: string, data: Buffer, suffix = "v1"): Promise<ImageManifest> {
    const manifest: ImageManifest = {
      schemaVersion: 1,
      allowedHosts: ["127.0.0.1"],
      images: [
        {
          id: `linux-${suffix}`,
          name: `Linux ${suffix}`,
          osFamily: "linux",
          osVersion: "24.04",
          architecture: "amd64",
          version: suffix,
          url: `${url}/image-${suffix}`,
          fileName: `linux-${suffix}.qcow2`,
          sizeBytes: data.length,
          sha256: sha256(data),
        },
      ],
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    return manifest;
  }

  it("deduplicates concurrent downloads and emits progress before Available", async () => {
    const data = bytes(512 * 1024);
    let requests = 0;
    const server = createServer(async (_request, response) => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      response.writeHead(200, { "content-length": data.length });
      response.end(data);
    });
    servers.push(server);
    const url = await listen(server);
    await writeManifest(url, data);
    const images = service();
    await images.onModuleInit();
    const events: string[] = [];
    const subscription = images.events.subscribe((event) => events.push(event.status));

    const [first, second] = await Promise.all([
      images.download("linux-v1"),
      images.download("linux-v1"),
    ]);
    expect(first.status).toBe("available");
    expect(second.id).toBe(first.id);
    expect(requests).toBe(1);
    expect(first.downloadedBytes).toBe(data.length);
    expect(first.localPath).toBe(path.join(directory, "images", "linux-v1.qcow2"));
    expect(await readFile(first.localPath!)).toEqual(data);
    expect(events).toContain("downloading");
    expect(events).toContain("verifying");
    expect(events.at(-1)).toBe("available");
    subscription.unsubscribe();
    await images.onModuleDestroy();
  });

  it("resumes retained bytes with a new service after process interruption", async () => {
    const data = bytes(1024 * 1024);
    let requests = 0;
    let resumeRange = "";
    const server = createServer((request, response) => {
      requests++;
      if (requests === 1) {
        response.writeHead(200, { "content-length": data.length });
        response.write(data.subarray(0, 384 * 1024));
        response.socket?.destroySoon();
        return;
      }
      resumeRange = request.headers.range ?? "";
      const offset = Number(resumeRange.match(/^bytes=(\d+)-$/)?.[1]);
      response.writeHead(206, {
        "content-length": data.length - offset,
        "content-range": `bytes ${offset}-${data.length - 1}/${data.length}`,
      });
      response.end(data.subarray(offset));
    });
    servers.push(server);
    const url = await listen(server);
    await writeManifest(url, data);

    const first = service();
    await first.onModuleInit();
    await expect(first.download("linux-v1")).rejects.toThrow();
    const partial = path.join(directory, "images", "linux-v1.qcow2.partial");
    const partialSize = (await stat(partial)).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(data.length);
    await first.onModuleDestroy();

    // A killed process cannot write a terminal status; reproduce its persisted row.
    await database.db
      .updateTable("images")
      .set({ status: "downloading" })
      .where("id", "=", "linux-v1")
      .execute();
    const restarted = service({ autoResume: true });
    await restarted.onModuleInit();
    const image = await eventually(
      () => restarted.get("linux-v1"),
      (value) => value.status === "available",
    );
    expect(resumeRange).toBe(`bytes=${partialSize}-`);
    expect(requests).toBe(2);
    expect(image.downloadedBytes).toBe(data.length);
    expect(await exists(partial)).toBe(false);
    await restarted.onModuleDestroy();
  });

  it("cancels an active transfer without exposing a final file", async () => {
    const data = bytes(2 * 1024 * 1024);
    const server = createServer(async (_request, response) => {
      response.writeHead(200, { "content-length": data.length });
      for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        if (response.destroyed) {
          return;
        }
        response.write(data.subarray(offset, offset + 64 * 1024));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      response.end();
    });
    servers.push(server);
    const url = await listen(server);
    await writeManifest(url, data);
    const images = service();
    await images.onModuleInit();
    const downloading = images.download("linux-v1");
    await eventually(
      () => images.get("linux-v1"),
      (image) => image.downloadedBytes > 0,
    );
    const cancelled = await images.cancel("linux-v1");
    await expect(downloading).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.downloadedBytes).toBeGreaterThan(0);
    expect(await exists(path.join(directory, "images", "linux-v1.qcow2"))).toBe(false);
    expect(await exists(path.join(directory, "images", "linux-v1.qcow2.partial"))).toBe(true);
    await images.onModuleDestroy();
  });

  it("never marks a checksum mismatch Available", async () => {
    const data = bytes(128 * 1024);
    const server = createServer((_request, response) => response.end(data));
    servers.push(server);
    const url = await listen(server);
    const manifest = await writeManifest(url, data);
    manifest.images[0]!.sha256 = sha256(Buffer.from("different"));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const images = service();
    await images.onModuleInit();
    await expect(images.download("linux-v1")).rejects.toThrow(/SHA-256/);
    const failed = await images.get("linux-v1");
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("checksum_mismatch");
    expect(failed.localPath).toBeNull();
    expect(await exists(path.join(directory, "images", "linux-v1.qcow2"))).toBe(false);
    expect(await exists(path.join(directory, "images", "linux-v1.qcow2.partial"))).toBe(false);
    await images.onModuleDestroy();
  });

  it("rejects in-place version mutation and retains the old verified artifact", async () => {
    const data = bytes(64 * 1024);
    const server = createServer((_request, response) => response.end(data));
    servers.push(server);
    const url = await listen(server);
    const manifest = await writeManifest(url, data);
    const images = service();
    await images.onModuleInit();
    const available = await images.download("linux-v1");
    const oldPath = available.localPath!;

    manifest.images[0]!.fileName = "replacement.qcow2";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(images.refresh()).rejects.toThrow(/新的版本 ID/);
    expect(await readFile(oldPath)).toEqual(data);
    expect((await images.get("linux-v1")).status).toBe("available");
    await images.onModuleDestroy();
  });
});
