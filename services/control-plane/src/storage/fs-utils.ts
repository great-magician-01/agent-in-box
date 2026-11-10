import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StorageError } from "./storage-errors";

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface DirectoryStats {
  bytes: number;
  files: number;
}

export interface CopyTreeResult {
  bytesCopied: number;
  filesCopied: number;
  verifiedFiles: number;
  warnings: string[];
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function nearestExistingAncestor(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    if (await pathExists(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export async function diskSpace(target: string): Promise<DiskSpace> {
  const existing = await nearestExistingAncestor(target);
  try {
    const stats = await statfs(existing);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

export async function directoryStats(root: string): Promise<DirectoryStats> {
  if (!(await pathExists(root))) {
    return { bytes: 0, files: 0 };
  }

  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await lstat(fullPath);
        bytes += link.size;
        files += 1;
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const stats = await lstat(fullPath);
        bytes += stats.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function temporarySibling(file: string): string {
  return `${file}.migrating`;
}

async function copyFileVerified(
  source: string,
  destination: string,
): Promise<{ bytes: number; verified: boolean }> {
  const sourceStats = await lstat(source);
  if (!sourceStats.isFile()) {
    throw new StorageError("validation_failed", `迁移只复制普通文件: ${source}`);
  }

  const temporary = temporarySibling(destination);
  await copyFile(source, temporary);
  await chmod(temporary, sourceStats.mode & 0o777);
  const [sourceHash, destinationHash] = await Promise.all([
    sha256File(source),
    sha256File(temporary),
  ]);
  if (sourceHash !== destinationHash) {
    await rm(temporary, { force: true });
    throw new StorageError("internal_error", `迁移校验失败，文件内容不一致: ${source}`);
  }
  const destinationStats = await lstat(temporary);
  if (destinationStats.size !== sourceStats.size) {
    await rm(temporary, { force: true });
    throw new StorageError("internal_error", `迁移校验失败，文件大小不一致: ${source}`);
  }

  try {
    await rename(temporary, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM") {
      await rm(destination, { force: true });
      await rename(temporary, destination);
    } else {
      throw error;
    }
  }
  return { bytes: sourceStats.size, verified: true };
}

/**
 * Copies a directory tree without following symlinks. Every file is hashed on
 * both sides before it is renamed into place, so a partial copy can never look
 * verified. Symbolic links are rejected rather than silently dereferenced.
 */
export async function copyTreeVerified(
  sourceRoot: string,
  destinationRoot: string,
): Promise<CopyTreeResult> {
  const result: CopyTreeResult = {
    bytesCopied: 0,
    filesCopied: 0,
    verifiedFiles: 0,
    warnings: [],
  };

  if (!(await pathExists(sourceRoot))) {
    return result;
  }
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });

  const stack: Array<{ source: string; destination: string }> = [
    { source: sourceRoot, destination: destinationRoot },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const entries = await readdir(current.source, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(current.source, entry.name);
      const destination = path.join(current.destination, entry.name);
      if (entry.isSymbolicLink()) {
        throw new StorageError(
          "validation_failed",
          `存储迁移不支持符号链接，请先处理: ${path.relative(sourceRoot, source)}`,
        );
      }
      if (entry.isDirectory()) {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        stack.push({ source, destination });
        continue;
      }
      if (entry.isFile()) {
        if (entry.name.endsWith(".migrating")) {
          result.warnings.push(`跳过上次迁移遗留的临时文件: ${entry.name}`);
          continue;
        }
        const copied = await copyFileVerified(source, destination);
        result.bytesCopied += copied.bytes;
        result.filesCopied += 1;
        result.verifiedFiles += copied.verified ? 1 : 0;
      }
    }
  }

  return result;
}

export async function removeDirectoryContents(target: string): Promise<DirectoryStats> {
  if (!(await pathExists(target))) {
    return { bytes: 0, files: 0 };
  }

  let bytes = 0;
  let files = 0;
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const stats = await lstat(fullPath);
      bytes += stats.size;
      files += 1;
      await rm(fullPath, { force: true });
    } else if (entry.isDirectory()) {
      const stats = await directoryStats(fullPath);
      bytes += stats.bytes;
      files += stats.files;
      await rm(fullPath, { recursive: true, force: true });
    } else if (entry.isFile()) {
      const stats = await lstat(fullPath);
      bytes += stats.size;
      files += 1;
      await rm(fullPath, { force: true });
    }
  }
  return { bytes, files };
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
