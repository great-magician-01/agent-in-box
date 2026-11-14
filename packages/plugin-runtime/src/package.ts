/**
 * Local plugin package inspection.
 *
 * Packages are treated as untrusted directory trees. This module reads and
 * hashes bytes only: plugin code is never imported, required or executed.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  isPluginTarget,
  validatePluginManifest,
  type PluginIssueCode,
  type PluginManifest,
  type PluginTarget,
  type PluginValidationIssue,
} from "./manifest";

export interface PluginPackageLimits {
  /** Maximum number of regular files, including `manifest.json`. */
  maxFiles: number;
  /** Maximum size of a single file in bytes. */
  maxFileBytes: number;
  /** Maximum total size of all package files in bytes. */
  maxTotalBytes: number;
  /** Maximum size of `manifest.json` in bytes. */
  maxManifestBytes: number;
  /** Maximum relative path length in characters. */
  maxPathLength: number;
}

export type PluginInspectionOptions = Partial<PluginPackageLimits>;

export const DEFAULT_PLUGIN_PACKAGE_LIMITS: Readonly<PluginPackageLimits> = Object.freeze({
  maxFiles: 2_048,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxPathLength: 512,
});

export interface PluginPackageFile {
  /** Normalized POSIX-style path relative to the package root. */
  path: string;
  size: number;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
}

export interface InspectedPluginPackage {
  /** Absolute, symlink-resolved package root. */
  root: string;
  /** Validated and normalized manifest. */
  manifest: PluginManifest;
  /** All regular files, sorted by relative path. */
  files: PluginPackageFile[];
  totalFiles: number;
  totalBytes: number;
  /**
   * Deterministic SHA-256 over the sorted file records (path, size and file
   * SHA-256), prefixed with a format domain. Independent of timestamps, modes
   * and the absolute package location.
   */
  packageSha256: string;
}

export class PluginPackageError extends Error {
  readonly issues: PluginValidationIssue[];

  constructor(message: string, issues: PluginValidationIssue[]) {
    super(message);
    this.name = "PluginPackageError";
    this.issues = issues;
  }
}

const PACKAGE_HASH_DOMAIN = "agent-in-box/plugin-package/v1";
const LIMIT_KEYS = [
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
  "maxManifestBytes",
  "maxPathLength",
] as const;

function issue(code: PluginIssueCode, issuePath: string, message: string): PluginValidationIssue {
  return { code, path: issuePath, message };
}

function fail(summary: string, code: PluginIssueCode, issuePath: string, message: string): never {
  throw new PluginPackageError(summary, [issue(code, issuePath, message)]);
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveLimits(options: PluginInspectionOptions | undefined): PluginPackageLimits {
  const limits: PluginPackageLimits = {
    maxFiles: options?.maxFiles ?? DEFAULT_PLUGIN_PACKAGE_LIMITS.maxFiles,
    maxFileBytes: options?.maxFileBytes ?? DEFAULT_PLUGIN_PACKAGE_LIMITS.maxFileBytes,
    maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_PLUGIN_PACKAGE_LIMITS.maxTotalBytes,
    maxManifestBytes: options?.maxManifestBytes ?? DEFAULT_PLUGIN_PACKAGE_LIMITS.maxManifestBytes,
    maxPathLength: options?.maxPathLength ?? DEFAULT_PLUGIN_PACKAGE_LIMITS.maxPathLength,
  };

  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(
        "Plugin inspection limits are invalid",
        "invalid_value",
        `options.${key}`,
        `"${key}" must be a positive safe integer`,
      );
    }
  }
  return limits;
}

async function resolvePackageRoot(root: unknown): Promise<string> {
  if (typeof root !== "string" || root.length === 0 || root.includes("\u0000")) {
    fail(
      "Plugin package root is invalid",
      "invalid_root",
      "root",
      "root must be a non-empty directory path",
    );
  }

  let resolved: string;
  try {
    resolved = await realpath(path.resolve(root));
  } catch {
    fail(
      "Plugin package root is not accessible",
      "invalid_root",
      "root",
      "root must point to an existing directory",
    );
  }

  try {
    const stats = await lstat(resolved);
    if (!stats.isDirectory()) {
      fail(
        "Plugin package root is not a directory",
        "invalid_root",
        "root",
        "root must point to a directory",
      );
    }
  } catch (error) {
    if (error instanceof PluginPackageError) throw error;
    fail(
      "Plugin package root is not accessible",
      "invalid_root",
      "root",
      "root must point to a readable directory",
    );
  }
  return resolved;
}

function prefixManifestIssue(entry: PluginValidationIssue): PluginValidationIssue {
  return {
    ...entry,
    path: entry.path === "" || entry.path === "manifest" ? "manifest" : `manifest.${entry.path}`,
  };
}

async function loadManifest(root: string, maxManifestBytes: number): Promise<PluginManifest> {
  const manifestPath = path.join(root, "manifest.json");
  const manifestIssuePath = "manifest.json";

  let stats;
  try {
    stats = await lstat(manifestPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(
        "Plugin package is missing manifest.json",
        "missing_manifest",
        manifestIssuePath,
        "Every plugin package must contain manifest.json at its root",
      );
    }
    fail(
      "Plugin manifest could not be read",
      "io_error",
      manifestIssuePath,
      "manifest.json could not be read",
    );
  }

  if (stats.isSymbolicLink()) {
    fail(
      "Plugin manifest must not be a symlink",
      "symlink",
      manifestIssuePath,
      "manifest.json must be a regular file inside the package",
    );
  }
  if (!stats.isFile()) {
    fail(
      "Plugin manifest is not a regular file",
      "unsupported_file",
      manifestIssuePath,
      "manifest.json must be a regular file",
    );
  }
  if (stats.size > maxManifestBytes) {
    fail(
      "Plugin manifest is too large",
      "manifest_too_large",
      manifestIssuePath,
      `manifest.json must be at most ${maxManifestBytes} bytes`,
    );
  }

  let content: Buffer;
  try {
    content = await readFile(manifestPath);
  } catch {
    fail(
      "Plugin manifest could not be read",
      "io_error",
      manifestIssuePath,
      "manifest.json could not be read",
    );
  }
  if (content.byteLength > maxManifestBytes) {
    fail(
      "Plugin manifest is too large",
      "manifest_too_large",
      manifestIssuePath,
      `manifest.json must be at most ${maxManifestBytes} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    fail(
      "Plugin manifest is not valid JSON",
      "invalid_json",
      manifestIssuePath,
      "manifest.json must contain valid JSON",
    );
  }

  const validation = validatePluginManifest(parsed);
  if (!validation.ok) {
    throw new PluginPackageError(
      "Plugin manifest failed validation",
      validation.issues.map(prefixManifestIssue),
    );
  }
  return validation.manifest;
}

interface WalkResult {
  files: PluginPackageFile[];
  directories: Set<string>;
  totalBytes: number;
  issues: PluginValidationIssue[];
}

async function hashPackageFiles(root: string, limits: PluginPackageLimits): Promise<WalkResult> {
  const files: PluginPackageFile[] = [];
  const directories = new Set<string>();
  const issues: PluginValidationIssue[] = [];
  let totalBytes = 0;
  let stopped = false;

  const visit = async (relativeDirectory: string): Promise<void> => {
    if (stopped) return;

    const absoluteDirectory =
      relativeDirectory.length === 0 ? root : path.join(root, ...relativeDirectory.split("/"));

    let names: string[];
    try {
      names = await readdir(absoluteDirectory);
    } catch {
      issues.push(
        issue(
          "io_error",
          relativeDirectory.length === 0 ? "root" : relativeDirectory,
          "Directory could not be read",
        ),
      );
      return;
    }

    for (const name of names.sort(comparePaths)) {
      if (stopped) return;

      const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const absolutePath = path.join(absoluteDirectory, name);

      if (relativePath.length > limits.maxPathLength) {
        issues.push(
          issue(
            "too_long",
            relativePath,
            `Path exceeds the ${limits.maxPathLength} character limit`,
          ),
        );
        continue;
      }
      if (!isPathInside(root, absolutePath)) {
        issues.push(issue("path_escape", relativePath, "Path escapes the package root"));
        continue;
      }

      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch {
        issues.push(issue("io_error", relativePath, "Path could not be inspected"));
        continue;
      }

      if (stats.isSymbolicLink()) {
        issues.push(
          issue("symlink", relativePath, "Symbolic links are not allowed in plugin packages"),
        );
        continue;
      }
      if (stats.isDirectory()) {
        directories.add(relativePath);
        await visit(relativePath);
        continue;
      }
      if (!stats.isFile()) {
        issues.push(
          issue(
            "unsupported_file",
            relativePath,
            "Only regular files and directories are allowed in plugin packages",
          ),
        );
        continue;
      }
      if (stats.size > limits.maxFileBytes) {
        issues.push(
          issue(
            "file_too_large",
            relativePath,
            `File exceeds the ${limits.maxFileBytes} byte limit`,
          ),
        );
        continue;
      }
      if (files.length >= limits.maxFiles) {
        issues.push(
          issue("too_many_files", "files", `Package exceeds the ${limits.maxFiles} file limit`),
        );
        stopped = true;
        return;
      }
      if (totalBytes + stats.size > limits.maxTotalBytes) {
        issues.push(
          issue(
            "package_too_large",
            "files",
            `Package exceeds the ${limits.maxTotalBytes} byte limit`,
          ),
        );
        stopped = true;
        return;
      }

      let content: Buffer;
      try {
        content = await readFile(absolutePath);
      } catch {
        issues.push(issue("io_error", relativePath, "File could not be read"));
        continue;
      }
      if (content.byteLength > limits.maxFileBytes) {
        issues.push(
          issue(
            "file_too_large",
            relativePath,
            `File exceeds the ${limits.maxFileBytes} byte limit`,
          ),
        );
        continue;
      }
      if (totalBytes + content.byteLength > limits.maxTotalBytes) {
        issues.push(
          issue(
            "package_too_large",
            "files",
            `Package exceeds the ${limits.maxTotalBytes} byte limit`,
          ),
        );
        stopped = true;
        return;
      }

      totalBytes += content.byteLength;
      files.push({
        path: relativePath,
        size: content.byteLength,
        sha256: sha256(content),
      });
    }
  };

  await visit("");
  files.sort((left, right) => comparePaths(left.path, right.path));
  return { files, directories, totalBytes, issues };
}

function hashPackage(files: readonly PluginPackageFile[]): string {
  const digest = createHash("sha256");
  digest.update(PACKAGE_HASH_DOMAIN, "utf8");
  digest.update("\0");
  for (const file of files) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(String(file.size), "utf8");
    digest.update("\0");
    digest.update(file.sha256, "utf8");
    digest.update("\n");
  }
  return digest.digest("hex");
}

function verifyEntrypoints(
  manifest: PluginManifest,
  files: readonly PluginPackageFile[],
  directories: ReadonlySet<string>,
): PluginValidationIssue[] {
  const issues: PluginValidationIssue[] = [];
  const filePaths = new Set(files.map((file) => file.path));

  for (const target of manifest.targets) {
    const entry = manifest.entrypoints[target];
    const issuePath = `entrypoints.${target}`;
    if (entry === undefined) {
      issues.push(
        issue(
          "missing_entrypoint",
          issuePath,
          `Manifest does not declare an entrypoint for target "${target}"`,
        ),
      );
      continue;
    }
    if (directories.has(entry)) {
      issues.push(
        issue(
          "entrypoint_not_file",
          issuePath,
          `Entrypoint "${entry}" must be a regular file, not a directory`,
        ),
      );
      continue;
    }
    if (!filePaths.has(entry)) {
      issues.push(
        issue(
          "missing_entrypoint",
          issuePath,
          `Entrypoint "${entry}" does not exist in the package`,
        ),
      );
    }
  }
  return issues;
}

/**
 * Validate a local package directory without executing any plugin code.
 *
 * The root is symlink-resolved. Every entry inside it is inspected with
 * `lstat`, symlinks and non-regular files are rejected, file count and sizes
 * are bounded, declared entrypoints must exist, and every file is hashed. The
 * returned `packageSha256` depends only on relative paths, sizes and contents.
 */
export async function inspectPluginPackage(
  root: string,
  options: PluginInspectionOptions = {},
): Promise<InspectedPluginPackage> {
  const limits = resolveLimits(options);
  const resolvedRoot = await resolvePackageRoot(root);
  const manifest = await loadManifest(resolvedRoot, limits.maxManifestBytes);
  const walked = await hashPackageFiles(resolvedRoot, limits);

  if (walked.issues.length > 0) {
    throw new PluginPackageError(
      "Plugin package contains unsafe or oversized files",
      walked.issues,
    );
  }

  if (!walked.files.some((file) => file.path === "manifest.json")) {
    fail(
      "Plugin package is missing manifest.json",
      "missing_manifest",
      "manifest.json",
      "manifest.json must be a regular file at the package root",
    );
  }

  const entrypointIssues = verifyEntrypoints(manifest, walked.files, walked.directories);
  if (entrypointIssues.length > 0) {
    throw new PluginPackageError("Plugin package entrypoints are invalid", entrypointIssues);
  }

  return {
    root: resolvedRoot,
    manifest,
    files: walked.files,
    totalFiles: walked.files.length,
    totalBytes: walked.totalBytes,
    packageSha256: hashPackage(walked.files),
  };
}

/**
 * Resolve a declared entrypoint to an absolute path confined to the package.
 *
 * The manifest is re-read and validated. Every path component is checked with
 * `lstat`, symlinks are rejected, and the final real path must remain inside
 * the resolved package root. The plugin file is not imported or executed.
 */
export async function resolvePluginEntry(root: string, target: PluginTarget): Promise<string> {
  if (!isPluginTarget(target)) {
    fail(
      "Unsupported plugin target",
      "unsupported_target",
      "target",
      `Target must be one of the declared plugin targets`,
    );
  }

  const resolvedRoot = await resolvePackageRoot(root);
  const manifest = await loadManifest(resolvedRoot, DEFAULT_PLUGIN_PACKAGE_LIMITS.maxManifestBytes);

  const entry = manifest.entrypoints[target];
  const issuePath = `entrypoints.${target}`;
  if (entry === undefined) {
    fail(
      "Plugin package has no entrypoint for the requested target",
      "missing_entrypoint",
      issuePath,
      `Manifest does not declare an entrypoint for target "${target}"`,
    );
  }

  const segments = entry.split("/");
  let candidate = resolvedRoot;

  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    if (!isPathInside(resolvedRoot, candidate)) {
      fail(
        "Plugin entrypoint escapes the package root",
        "path_escape",
        issuePath,
        `Entrypoint "${entry}" escapes the package root`,
      );
    }

    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        fail(
          "Plugin entrypoint does not exist",
          "missing_entrypoint",
          issuePath,
          `Entrypoint "${entry}" does not exist in the package`,
        );
      }
      fail(
        "Plugin entrypoint could not be inspected",
        "io_error",
        issuePath,
        `Entrypoint "${entry}" could not be inspected`,
      );
    }

    if (stats.isSymbolicLink()) {
      fail(
        "Plugin entrypoint must not contain symlinks",
        "symlink",
        issuePath,
        `Entrypoint "${entry}" must not use symbolic links`,
      );
    }

    const isLastSegment = index === segments.length - 1;
    if (!isLastSegment && !stats.isDirectory()) {
      fail(
        "Plugin entrypoint does not exist",
        "missing_entrypoint",
        issuePath,
        `Entrypoint "${entry}" does not exist in the package`,
      );
    }
    if (isLastSegment && !stats.isFile()) {
      fail(
        "Plugin entrypoint is not a regular file",
        "entrypoint_not_file",
        issuePath,
        `Entrypoint "${entry}" must be a regular file`,
      );
    }
  }

  let resolvedEntry: string;
  try {
    resolvedEntry = await realpath(candidate);
  } catch {
    fail(
      "Plugin entrypoint could not be resolved",
      "io_error",
      issuePath,
      `Entrypoint "${entry}" could not be resolved`,
    );
  }
  if (!isPathInside(resolvedRoot, resolvedEntry)) {
    fail(
      "Plugin entrypoint escapes the package root",
      "path_escape",
      issuePath,
      `Entrypoint "${entry}" escapes the package root`,
    );
  }

  return resolvedEntry;
}
