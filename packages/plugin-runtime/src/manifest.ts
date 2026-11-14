/**
 * Versioned plugin manifest contracts and strict validation.
 *
 * Manifest input is untrusted JSON. Validation never performs I/O and never
 * imports plugin code; it only produces a normalized, JSON-serializable value.
 */

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_SCHEMA_VERSION = 1 as const;

export const PLUGIN_TARGETS = ["worker", "router"] as const;
export type PluginTarget = (typeof PLUGIN_TARGETS)[number];

export const PLUGIN_RUNTIME_KINDS = ["pi-extension"] as const;
export type PluginRuntimeKind = (typeof PLUGIN_RUNTIME_KINDS)[number];

export const PLUGIN_MANIFEST_LIMITS = Object.freeze({
  maxIdLength: 128,
  maxTargets: PLUGIN_TARGETS.length,
  maxPermissions: 64,
  maxPermissionLength: 96,
  maxTools: 128,
  maxToolNameLength: 160,
  maxToolDescriptionLength: 500,
  maxDependencies: 32,
  maxDisplayNameLength: 120,
  maxDescriptionLength: 2_000,
  maxEntryPathLength: 512,
} as const);

export type PluginIssueCode =
  | "invalid_type"
  | "missing_field"
  | "unknown_field"
  | "invalid_value"
  | "invalid_id"
  | "invalid_version"
  | "invalid_target"
  | "duplicate_value"
  | "too_many"
  | "too_long"
  | "unsafe_path"
  | "entrypoint_target_mismatch"
  | "invalid_root"
  | "missing_manifest"
  | "manifest_too_large"
  | "invalid_json"
  | "symlink"
  | "unsupported_file"
  | "path_escape"
  | "file_too_large"
  | "too_many_files"
  | "package_too_large"
  | "missing_entrypoint"
  | "entrypoint_not_file"
  | "io_error"
  | "unsupported_target";

export interface PluginValidationIssue {
  code: PluginIssueCode;
  /** JSON-path-like location, for example `entrypoints.worker` or `tools[1].name`. */
  path: string;
  message: string;
}

export interface PluginRuntimeManifest {
  kind: PluginRuntimeKind;
  minPiVersion: string;
  minAppVersion: string;
}

export type PluginEntrypoints = Partial<Record<PluginTarget, string>>;

export interface PluginToolManifest {
  /** Namespaced tool name, always prefixed with `<manifest id>.`. */
  name: string;
  description?: string;
}

export interface PluginDependencyManifest {
  /** Reverse-domain plugin id. */
  id: string;
  /** Exact semantic version. */
  version: string;
}

/**
 * Normalized manifest returned by {@link validatePluginManifest}.
 *
 * Optional collections are materialized as empty arrays, targets use canonical
 * order (`worker`, then `router`), and permissions, tools and dependencies are
 * sorted so downstream snapshots and hashes are stable.
 */
export interface PluginManifest {
  schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  id: string;
  version: string;
  displayName: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  targets: PluginTarget[];
  entrypoints: PluginEntrypoints;
  runtime: PluginRuntimeManifest;
  permissions: string[];
  tools: PluginToolManifest[];
  dependencies: PluginDependencyManifest[];
  description?: string;
}

export type NormalizedPluginManifest = PluginManifest;

export interface PluginManifestValidationSuccess {
  ok: true;
  manifest: PluginManifest;
}

export interface PluginManifestValidationFailure {
  ok: false;
  issues: PluginValidationIssue[];
}

export type PluginManifestValidationResult =
  PluginManifestValidationSuccess | PluginManifestValidationFailure;

const ID_LABEL_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const TOOL_SUFFIX_PATTERN = /^[a-z][a-z0-9_-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_SEMVER_LENGTH = 128;

const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "displayName",
  "apiVersion",
  "targets",
  "entrypoints",
  "runtime",
  "permissions",
  "tools",
  "dependencies",
  "description",
]);
const RUNTIME_KEYS = new Set(["kind", "minPiVersion", "minAppVersion"]);
const TOOL_KEYS = new Set(["name", "description"]);
const DEPENDENCY_KEYS = new Set(["id", "version"]);

export function isPluginTarget(value: unknown): value is PluginTarget {
  return typeof value === "string" && (PLUGIN_TARGETS as readonly string[]).includes(value);
}

export function isSafeRelativeEntryPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > PLUGIN_MANIFEST_LIMITS.maxEntryPathLength) return false;
  if (value.includes("\\") || value.includes(":")) return false;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return false;
  if (value.startsWith("/")) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function joinPath(base: string, key: string): string {
  return base.length === 0 ? key : `${base}.${key}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addIssue(
  issues: PluginValidationIssue[],
  code: PluginIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  base: string,
  issues: PluginValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addIssue(
        issues,
        "unknown_field",
        joinPath(base, key),
        `Unknown field "${key}" is not part of plugin schema version ${PLUGIN_SCHEMA_VERSION}`,
      );
    }
  }
}

function readLiteral<T extends number>(
  record: Record<string, unknown>,
  key: string,
  expected: T,
  base: string,
  issues: PluginValidationIssue[],
): T {
  const path = joinPath(base, key);
  if (!hasOwn(record, key)) {
    addIssue(issues, "missing_field", path, `Missing required field "${key}"`);
    return expected;
  }
  if (record[key] !== expected) {
    addIssue(issues, "invalid_value", path, `"${key}" must be ${expected}`);
  }
  return expected;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  base: string,
  maxLength: number,
  issues: PluginValidationIssue[],
): string {
  const path = joinPath(base, key);
  if (!hasOwn(record, key)) {
    addIssue(issues, "missing_field", path, `Missing required field "${key}"`);
    return "";
  }
  const value = record[key];
  if (typeof value !== "string") {
    addIssue(issues, "invalid_type", path, `"${key}" must be a string`);
    return "";
  }
  if (value.trim().length === 0) {
    addIssue(issues, "invalid_value", path, `"${key}" must not be empty`);
    return "";
  }
  if (value.length > maxLength) {
    addIssue(issues, "too_long", path, `"${key}" must be at most ${maxLength} characters`);
    return "";
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  base: string,
  maxLength: number,
  issues: PluginValidationIssue[],
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  const path = joinPath(base, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    addIssue(issues, "invalid_type", path, `"${key}" must be a string when present`);
    return undefined;
  }
  if (value.trim().length === 0) {
    addIssue(issues, "invalid_value", path, `"${key}" must not be empty when present`);
    return undefined;
  }
  if (value.length > maxLength) {
    addIssue(issues, "too_long", path, `"${key}" must be at most ${maxLength} characters`);
    return undefined;
  }
  return value;
}

function isPluginId(value: string): boolean {
  if (value.length < 3 || value.length > PLUGIN_MANIFEST_LIMITS.maxIdLength) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && ID_LABEL_PATTERN.test(label),
  );
}

function isSemver(value: string): boolean {
  return value.length <= MAX_SEMVER_LENGTH && SEMVER_PATTERN.test(value);
}

function readPluginId(
  record: Record<string, unknown>,
  key: string,
  base: string,
  issues: PluginValidationIssue[],
): string {
  const value = readRequiredString(record, key, base, PLUGIN_MANIFEST_LIMITS.maxIdLength, issues);
  if (value.length > 0 && !isPluginId(value)) {
    addIssue(
      issues,
      "invalid_id",
      joinPath(base, key),
      `"${key}" must be a lowercase reverse-domain identifier such as "com.example.plugin"`,
    );
    return "";
  }
  return value;
}

function readSemver(
  record: Record<string, unknown>,
  key: string,
  base: string,
  issues: PluginValidationIssue[],
): string {
  const value = readRequiredString(record, key, base, MAX_SEMVER_LENGTH, issues);
  if (value.length > 0 && !isSemver(value)) {
    addIssue(
      issues,
      "invalid_version",
      joinPath(base, key),
      `"${key}" must be an exact semantic version such as "1.0.0"`,
    );
    return "";
  }
  return value;
}

function readTargets(
  record: Record<string, unknown>,
  issues: PluginValidationIssue[],
): PluginTarget[] {
  if (!hasOwn(record, "targets")) {
    addIssue(issues, "missing_field", "targets", 'Missing required field "targets"');
    return [];
  }
  const value = record.targets;
  if (!Array.isArray(value)) {
    addIssue(issues, "invalid_type", "targets", '"targets" must be an array');
    return [];
  }
  if (value.length === 0) {
    addIssue(issues, "invalid_value", "targets", '"targets" must declare at least one target');
    return [];
  }
  if (value.length > PLUGIN_MANIFEST_LIMITS.maxTargets) {
    addIssue(
      issues,
      "too_many",
      "targets",
      `"targets" must contain at most ${PLUGIN_MANIFEST_LIMITS.maxTargets} entries`,
    );
  }

  const seen = new Set<PluginTarget>();
  for (const [index, entry] of value.entries()) {
    const path = `targets[${index}]`;
    if (!isPluginTarget(entry)) {
      addIssue(
        issues,
        "invalid_target",
        path,
        `Target must be one of: ${PLUGIN_TARGETS.join(", ")}`,
      );
      continue;
    }
    if (seen.has(entry)) {
      addIssue(issues, "duplicate_value", path, `Duplicate target "${entry}"`);
      continue;
    }
    seen.add(entry);
  }
  return PLUGIN_TARGETS.filter((target) => seen.has(target));
}

function readEntrypoints(
  record: Record<string, unknown>,
  targets: readonly PluginTarget[],
  issues: PluginValidationIssue[],
): PluginEntrypoints {
  const base = "entrypoints";
  if (!hasOwn(record, base)) {
    addIssue(issues, "missing_field", base, 'Missing required field "entrypoints"');
    return {};
  }
  const value = record[base];
  if (!isRecord(value)) {
    addIssue(issues, "invalid_type", base, '"entrypoints" must be an object');
    return {};
  }

  const entrypoints: PluginEntrypoints = {};
  for (const target of targets) {
    if (!hasOwn(value, target)) {
      addIssue(
        issues,
        "entrypoint_target_mismatch",
        joinPath(base, target),
        `Missing entrypoint for declared target "${target}"`,
      );
    }
  }

  for (const key of Object.keys(value)) {
    if (!isPluginTarget(key)) {
      addIssue(
        issues,
        "invalid_target",
        joinPath(base, key),
        `Entrypoint target must be one of: ${PLUGIN_TARGETS.join(", ")}`,
      );
      continue;
    }
    if (!targets.includes(key)) {
      addIssue(
        issues,
        "entrypoint_target_mismatch",
        joinPath(base, key),
        `Entrypoint "${key}" is not listed in "targets"`,
      );
    }
    const entry = value[key];
    if (typeof entry !== "string") {
      addIssue(issues, "invalid_type", joinPath(base, key), `Entrypoint "${key}" must be a string`);
      continue;
    }
    if (!isSafeRelativeEntryPath(entry)) {
      addIssue(
        issues,
        "unsafe_path",
        joinPath(base, key),
        `Entrypoint "${key}" must be a safe relative path without "..", absolute segments, backslashes or drive letters`,
      );
      continue;
    }
    entrypoints[key] = entry;
  }

  const ordered: PluginEntrypoints = {};
  for (const target of targets) {
    const entry = entrypoints[target];
    if (entry !== undefined) ordered[target] = entry;
  }
  return ordered;
}

function readRuntime(
  record: Record<string, unknown>,
  issues: PluginValidationIssue[],
): PluginRuntimeManifest {
  const base = "runtime";
  if (!hasOwn(record, base)) {
    addIssue(issues, "missing_field", base, 'Missing required field "runtime"');
    return { kind: "pi-extension", minPiVersion: "", minAppVersion: "" };
  }
  const value = record[base];
  if (!isRecord(value)) {
    addIssue(issues, "invalid_type", base, '"runtime" must be an object');
    return { kind: "pi-extension", minPiVersion: "", minAppVersion: "" };
  }

  rejectUnknownKeys(value, RUNTIME_KEYS, base, issues);

  if (!hasOwn(value, "kind")) {
    addIssue(issues, "missing_field", joinPath(base, "kind"), 'Missing required field "kind"');
  } else if (value.kind !== "pi-extension") {
    addIssue(
      issues,
      "invalid_value",
      joinPath(base, "kind"),
      `"runtime.kind" must be "${PLUGIN_RUNTIME_KINDS[0]}"`,
    );
  }

  return {
    kind: "pi-extension",
    minPiVersion: readSemver(value, "minPiVersion", base, issues),
    minAppVersion: readSemver(value, "minAppVersion", base, issues),
  };
}

function readPermissions(
  record: Record<string, unknown>,
  issues: PluginValidationIssue[],
): string[] {
  const base = "permissions";
  if (!hasOwn(record, base)) return [];
  const value = record[base];
  if (!Array.isArray(value)) {
    addIssue(issues, "invalid_type", base, '"permissions" must be an array');
    return [];
  }
  if (value.length > PLUGIN_MANIFEST_LIMITS.maxPermissions) {
    addIssue(
      issues,
      "too_many",
      base,
      `"permissions" must contain at most ${PLUGIN_MANIFEST_LIMITS.maxPermissions} entries`,
    );
  }

  const seen = new Set<string>();
  const permissions: string[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `${base}[${index}]`;
    if (typeof entry !== "string") {
      addIssue(issues, "invalid_type", path, "Permission must be a string");
      continue;
    }
    if (
      entry.length > PLUGIN_MANIFEST_LIMITS.maxPermissionLength ||
      !PERMISSION_PATTERN.test(entry)
    ) {
      addIssue(
        issues,
        "invalid_value",
        path,
        `Permission "${entry}" must be a lowercase dotted identifier of at most ${PLUGIN_MANIFEST_LIMITS.maxPermissionLength} characters`,
      );
      continue;
    }
    if (seen.has(entry)) {
      addIssue(issues, "duplicate_value", path, `Duplicate permission "${entry}"`);
      continue;
    }
    seen.add(entry);
    permissions.push(entry);
  }
  return permissions.sort(compareStrings);
}

function isNamespacedToolName(pluginId: string, value: string): boolean {
  if (pluginId.length === 0) return false;
  const prefix = `${pluginId}.`;
  if (!value.startsWith(prefix)) return false;
  return value.length > prefix.length && TOOL_SUFFIX_PATTERN.test(value.slice(prefix.length));
}

function readTools(
  record: Record<string, unknown>,
  pluginId: string,
  issues: PluginValidationIssue[],
): PluginToolManifest[] {
  const base = "tools";
  if (!hasOwn(record, base)) return [];
  const value = record[base];
  if (!Array.isArray(value)) {
    addIssue(issues, "invalid_type", base, '"tools" must be an array');
    return [];
  }
  if (value.length > PLUGIN_MANIFEST_LIMITS.maxTools) {
    addIssue(
      issues,
      "too_many",
      base,
      `"tools" must contain at most ${PLUGIN_MANIFEST_LIMITS.maxTools} entries`,
    );
  }

  const seen = new Set<string>();
  const tools: PluginToolManifest[] = [];
  for (const [index, entry] of value.entries()) {
    const itemPath = `${base}[${index}]`;
    if (!isRecord(entry)) {
      addIssue(issues, "invalid_type", itemPath, "Tool entry must be an object");
      continue;
    }
    rejectUnknownKeys(entry, TOOL_KEYS, itemPath, issues);

    const namePath = joinPath(itemPath, "name");
    let name = "";
    if (!hasOwn(entry, "name")) {
      addIssue(issues, "missing_field", namePath, 'Missing required field "name"');
    } else if (typeof entry.name !== "string") {
      addIssue(issues, "invalid_type", namePath, '"name" must be a string');
    } else if (entry.name.length > PLUGIN_MANIFEST_LIMITS.maxToolNameLength) {
      addIssue(
        issues,
        "too_long",
        namePath,
        `Tool name must be at most ${PLUGIN_MANIFEST_LIMITS.maxToolNameLength} characters`,
      );
    } else if (!isNamespacedToolName(pluginId, entry.name)) {
      addIssue(
        issues,
        "invalid_value",
        namePath,
        `Tool name must be namespaced as "${pluginId}.<tool>" using lowercase letters, digits, "_" or "-"`,
      );
    } else {
      name = entry.name;
    }

    if (name.length > 0) {
      if (seen.has(name)) {
        addIssue(issues, "duplicate_value", namePath, `Duplicate tool name "${name}"`);
      } else {
        seen.add(name);
      }
    }

    const description = readOptionalString(
      entry,
      "description",
      itemPath,
      PLUGIN_MANIFEST_LIMITS.maxToolDescriptionLength,
      issues,
    );
    tools.push(description === undefined ? { name } : { name, description });
  }

  return tools.sort((left, right) => compareStrings(left.name, right.name));
}

function readDependencies(
  record: Record<string, unknown>,
  pluginId: string,
  issues: PluginValidationIssue[],
): PluginDependencyManifest[] {
  const base = "dependencies";
  if (!hasOwn(record, base)) return [];
  const value = record[base];
  if (!Array.isArray(value)) {
    addIssue(issues, "invalid_type", base, '"dependencies" must be an array');
    return [];
  }
  if (value.length > PLUGIN_MANIFEST_LIMITS.maxDependencies) {
    addIssue(
      issues,
      "too_many",
      base,
      `"dependencies" must contain at most ${PLUGIN_MANIFEST_LIMITS.maxDependencies} entries`,
    );
  }

  const seen = new Set<string>();
  const dependencies: PluginDependencyManifest[] = [];
  for (const [index, entry] of value.entries()) {
    const itemPath = `${base}[${index}]`;
    if (!isRecord(entry)) {
      addIssue(issues, "invalid_type", itemPath, "Dependency entry must be an object");
      continue;
    }
    rejectUnknownKeys(entry, DEPENDENCY_KEYS, itemPath, issues);

    const id = readPluginId(entry, "id", itemPath, issues);
    const version = readSemver(entry, "version", itemPath, issues);
    if (id.length > 0) {
      if (id === pluginId) {
        addIssue(
          issues,
          "invalid_value",
          joinPath(itemPath, "id"),
          "A plugin must not depend on itself",
        );
      } else if (seen.has(id)) {
        addIssue(
          issues,
          "duplicate_value",
          joinPath(itemPath, "id"),
          `Duplicate dependency "${id}"`,
        );
      } else {
        seen.add(id);
      }
    }
    dependencies.push({ id, version });
  }

  return dependencies.sort((left, right) => compareStrings(left.id, right.id));
}

/**
 * Validate untrusted manifest JSON and return a normalized manifest.
 *
 * The validator is strict: unknown fields are rejected, collection sizes and
 * string lengths are bounded, ids are lowercase reverse-domain identifiers,
 * versions are exact semver, targets and entrypoint keys must match, and entry
 * paths cannot escape the package root.
 */
export function validatePluginManifest(input: unknown): PluginManifestValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_type",
          path: "manifest",
          message: "Plugin manifest must be a JSON object",
        },
      ],
    };
  }

  const issues: PluginValidationIssue[] = [];
  rejectUnknownKeys(input, MANIFEST_KEYS, "", issues);

  const schemaVersion = readLiteral(input, "schemaVersion", PLUGIN_SCHEMA_VERSION, "", issues);
  const id = readPluginId(input, "id", "", issues);
  const version = readSemver(input, "version", "", issues);
  const displayName = readRequiredString(
    input,
    "displayName",
    "",
    PLUGIN_MANIFEST_LIMITS.maxDisplayNameLength,
    issues,
  );
  const apiVersion = readLiteral(input, "apiVersion", PLUGIN_API_VERSION, "", issues);
  const targets = readTargets(input, issues);
  const entrypoints = readEntrypoints(input, targets, issues);
  const runtime = readRuntime(input, issues);
  const permissions = readPermissions(input, issues);
  const tools = readTools(input, id, issues);
  const dependencies = readDependencies(input, id, issues);
  const description = readOptionalString(
    input,
    "description",
    "",
    PLUGIN_MANIFEST_LIMITS.maxDescriptionLength,
    issues,
  );

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    manifest: {
      schemaVersion,
      id,
      version,
      displayName,
      apiVersion,
      targets,
      entrypoints,
      runtime,
      permissions,
      tools,
      dependencies,
      ...(description === undefined ? {} : { description }),
    },
  };
}
