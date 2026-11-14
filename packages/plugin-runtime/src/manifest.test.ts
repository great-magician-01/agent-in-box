import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PLUGIN_SCHEMA_VERSION,
  isPluginTarget,
  isSafeRelativeEntryPath,
  validatePluginManifest,
  type PluginManifest,
  type PluginValidationIssue,
} from "./index";

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: "com.example.plugin",
    version: "1.0.0",
    displayName: "Example Plugin",
    apiVersion: PLUGIN_API_VERSION,
    targets: ["worker"],
    entrypoints: { worker: "dist/extension.js" },
    runtime: { kind: "pi-extension", minPiVersion: "1.5.1", minAppVersion: "0.1.0" },
    permissions: [],
    tools: [],
    dependencies: [],
    ...overrides,
  };
}

function without(manifest: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...manifest };
  delete copy[key];
  return copy;
}

function expectValid(input: unknown): PluginManifest {
  const result = validatePluginManifest(input);
  if (!result.ok) {
    throw new Error(`Expected a valid manifest, got: ${JSON.stringify(result.issues)}`);
  }
  return result.manifest;
}

function expectInvalid(input: unknown): PluginValidationIssue[] {
  const result = validatePluginManifest(input);
  if (result.ok) {
    throw new Error("Expected manifest validation to fail");
  }
  return result.issues;
}

function expectIssue(
  issues: readonly PluginValidationIssue[],
  code: PluginValidationIssue["code"],
  issuePath?: string,
): void {
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        ...(issuePath === undefined ? {} : { path: issuePath }),
      }),
    ]),
  );
}

describe("validatePluginManifest", () => {
  it("accepts and normalizes a fully populated manifest", () => {
    const manifest = expectValid(
      baseManifest({
        targets: ["router", "worker"],
        entrypoints: {
          worker: "dist/worker.js",
          router: "dist/router.js",
        },
        permissions: ["network.fetch", "filesystem.read"],
        tools: [
          { name: "com.example.plugin.zeta", description: "Zeta tool" },
          { name: "com.example.plugin.alpha" },
        ],
        dependencies: [
          { id: "org.example.zeta", version: "2.0.0" },
          { id: "org.example.alpha", version: "1.0.0" },
        ],
        description: "Example local extension",
      }),
    );

    expect(manifest).toEqual({
      schemaVersion: 1,
      id: "com.example.plugin",
      version: "1.0.0",
      displayName: "Example Plugin",
      apiVersion: 1,
      targets: ["worker", "router"],
      entrypoints: { worker: "dist/worker.js", router: "dist/router.js" },
      runtime: { kind: "pi-extension", minPiVersion: "1.5.1", minAppVersion: "0.1.0" },
      permissions: ["filesystem.read", "network.fetch"],
      tools: [
        { name: "com.example.plugin.alpha" },
        { name: "com.example.plugin.zeta", description: "Zeta tool" },
      ],
      dependencies: [
        { id: "org.example.alpha", version: "1.0.0" },
        { id: "org.example.zeta", version: "2.0.0" },
      ],
      description: "Example local extension",
    });
  });

  it("materializes optional collections and accepts prerelease/build versions", () => {
    const input = baseManifest({ version: "1.0.0-beta.1+build.5" });
    delete input.permissions;
    delete input.tools;
    delete input.dependencies;
    delete input.description;

    const manifest = expectValid(input);
    expect(manifest.permissions).toEqual([]);
    expect(manifest.tools).toEqual([]);
    expect(manifest.dependencies).toEqual([]);
    expect(manifest).not.toHaveProperty("description");
  });

  it("rejects non-object manifests", () => {
    for (const input of [null, undefined, [], "manifest", 42, true]) {
      const issues = expectInvalid(input);
      expectIssue(issues, "invalid_type", "manifest");
    }
  });

  it("rejects unknown fields at every level", () => {
    expectIssue(expectInvalid(baseManifest({ extra: true })), "unknown_field", "extra");
    expectIssue(
      expectInvalid(
        baseManifest({
          runtime: {
            kind: "pi-extension",
            minPiVersion: "1.5.1",
            minAppVersion: "0.1.0",
            sandbox: true,
          },
        }),
      ),
      "unknown_field",
      "runtime.sandbox",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          tools: [{ name: "com.example.plugin.echo", inputSchema: {} }],
        }),
      ),
      "unknown_field",
      "tools[0].inputSchema",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          dependencies: [{ id: "org.example.lib", version: "1.0.0", optional: true }],
        }),
      ),
      "unknown_field",
      "dependencies[0].optional",
    );
  });

  it("requires a lowercase reverse-domain id", () => {
    for (const id of [
      "com.example.plugin",
      "io.agent-in-box.plugin",
      "a.b",
      "com.example.plugin.name.with.many.labels",
    ]) {
      expect(expectValid(baseManifest({ id })).id).toBe(id);
    }

    for (const id of [
      "plugin",
      "com..plugin",
      "Com.example.plugin",
      "com.Example.plugin",
      "com.example.plugin-",
      "-com.example.plugin",
      "com.example.plug_in",
      `com.${"a".repeat(64)}.plugin`,
    ]) {
      expectIssue(expectInvalid(baseManifest({ id })), "invalid_id", "id");
    }
  });

  it("requires exact semantic versions", () => {
    for (const version of [
      "0.0.0",
      "1.2.3",
      "1.0.0-beta.1",
      "1.0.0-beta.1+build.5",
      "10.20.30-rc.1",
    ]) {
      expect(expectValid(baseManifest({ version })).version).toBe(version);
    }

    for (const version of [
      "1",
      "1.0",
      "01.0.0",
      "1.00.0",
      "1.0.0.0",
      "v1.0.0",
      "^1.0.0",
      "1.0.0-",
      "1.0.0+",
      " 1.0.0",
    ]) {
      expectIssue(expectInvalid(baseManifest({ version })), "invalid_version", "version");
    }

    expectIssue(
      expectInvalid(
        baseManifest({
          runtime: { kind: "pi-extension", minPiVersion: "1.5", minAppVersion: "0.1.0" },
        }),
      ),
      "invalid_version",
      "runtime.minPiVersion",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          runtime: { kind: "pi-extension", minPiVersion: "1.5.1", minAppVersion: "latest" },
        }),
      ),
      "invalid_version",
      "runtime.minAppVersion",
    );
  });

  it("enforces schemaVersion and apiVersion", () => {
    expectIssue(
      expectInvalid(baseManifest({ schemaVersion: 2 })),
      "invalid_value",
      "schemaVersion",
    );
    expectIssue(
      expectInvalid(baseManifest({ schemaVersion: "1" })),
      "invalid_value",
      "schemaVersion",
    );
    expectIssue(
      expectInvalid(without(baseManifest(), "schemaVersion")),
      "missing_field",
      "schemaVersion",
    );
    expectIssue(expectInvalid(baseManifest({ apiVersion: 2 })), "invalid_value", "apiVersion");
    expectIssue(
      expectInvalid(without(baseManifest(), "apiVersion")),
      "missing_field",
      "apiVersion",
    );
  });

  it("limits targets to unique worker/router values", () => {
    expectIssue(expectInvalid(baseManifest({ targets: [] })), "invalid_value", "targets");
    expectIssue(expectInvalid(baseManifest({ targets: "worker" })), "invalid_type", "targets");
    expectIssue(
      expectInvalid(baseManifest({ targets: ["desktop"] })),
      "invalid_target",
      "targets[0]",
    );
    expectIssue(
      expectInvalid(baseManifest({ targets: ["worker", "worker"] })),
      "duplicate_value",
      "targets[1]",
    );
    expectIssue(
      expectInvalid(baseManifest({ targets: ["worker", "router", "worker"] })),
      "too_many",
      "targets",
    );
    expectIssue(expectInvalid(without(baseManifest(), "targets")), "missing_field", "targets");
  });

  it("requires one entrypoint per declared target", () => {
    expectIssue(
      expectInvalid(baseManifest({ entrypoints: {} })),
      "entrypoint_target_mismatch",
      "entrypoints.worker",
    );
    expectIssue(
      expectInvalid(baseManifest({ entrypoints: "dist/extension.js" })),
      "invalid_type",
      "entrypoints",
    );
    expectIssue(
      expectInvalid(without(baseManifest(), "entrypoints")),
      "missing_field",
      "entrypoints",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          targets: ["worker", "router"],
          entrypoints: { worker: "dist/worker.js" },
        }),
      ),
      "entrypoint_target_mismatch",
      "entrypoints.router",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          entrypoints: { worker: "dist/extension.js", router: "dist/router.js" },
        }),
      ),
      "entrypoint_target_mismatch",
      "entrypoints.router",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          entrypoints: { worker: "dist/extension.js", desktop: "dist/desktop.js" },
        }),
      ),
      "invalid_target",
      "entrypoints.desktop",
    );
  });

  it("rejects absolute and escaping entrypoint paths", () => {
    const unsafePaths = [
      "../outside.js",
      "dist/../../outside.js",
      "/absolute.js",
      "C:/outside.js",
      "C:\\outside.js",
      "dist\\outside.js",
      "./dist/extension.js",
      "dist//extension.js",
      "dist/",
      "",
      "dist/\u0000extension.js",
    ];

    for (const entry of unsafePaths) {
      const issues = expectInvalid(baseManifest({ entrypoints: { worker: entry } }));
      expectIssue(issues, "unsafe_path", "entrypoints.worker");
    }

    expect(
      expectValid(
        baseManifest({
          entrypoints: { worker: "dist/nested/extension.mjs" },
        }),
      ).entrypoints.worker,
    ).toBe("dist/nested/extension.mjs");
  });

  it("requires a pi-extension runtime with minimum Pi and app versions", () => {
    expectIssue(expectInvalid(without(baseManifest(), "runtime")), "missing_field", "runtime");
    expectIssue(
      expectInvalid(baseManifest({ runtime: "pi-extension" })),
      "invalid_type",
      "runtime",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          runtime: { kind: "node", minPiVersion: "1.5.1", minAppVersion: "0.1.0" },
        }),
      ),
      "invalid_value",
      "runtime.kind",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          runtime: { minPiVersion: "1.5.1", minAppVersion: "0.1.0" },
        }),
      ),
      "missing_field",
      "runtime.kind",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          runtime: { kind: "pi-extension", minAppVersion: "0.1.0" },
        }),
      ),
      "missing_field",
      "runtime.minPiVersion",
    );
  });

  it("bounds and validates permissions", () => {
    const manifest = expectValid(
      baseManifest({
        permissions: ["network.fetch", "filesystem.read", "worker:exec"],
      }),
    );
    expect(manifest.permissions).toEqual(["filesystem.read", "network.fetch", "worker:exec"]);

    for (const permission of [
      "Network.Fetch",
      "filesystem..read",
      "filesystem read",
      "",
      "a".repeat(97),
    ]) {
      expectIssue(
        expectInvalid(baseManifest({ permissions: [permission] })),
        "invalid_value",
        "permissions[0]",
      );
    }
    expectIssue(
      expectInvalid(baseManifest({ permissions: [true] })),
      "invalid_type",
      "permissions[0]",
    );
    expectIssue(
      expectInvalid(baseManifest({ permissions: ["filesystem.read", "filesystem.read"] })),
      "duplicate_value",
      "permissions[1]",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          permissions: Array.from({ length: 65 }, (_, index) => `permission.${index}`),
        }),
      ),
      "too_many",
      "permissions",
    );
    expectIssue(
      expectInvalid(baseManifest({ permissions: "filesystem.read" })),
      "invalid_type",
      "permissions",
    );
  });

  it("requires unique, namespaced tool names", () => {
    const manifest = expectValid(
      baseManifest({
        tools: [
          { name: "com.example.plugin.zeta" },
          { name: "com.example.plugin.advanced-tool", description: "Advanced" },
          { name: "com.example.plugin.tool_2" },
        ],
      }),
    );
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "com.example.plugin.advanced-tool",
      "com.example.plugin.tool_2",
      "com.example.plugin.zeta",
    ]);

    for (const name of [
      "echo",
      "com.example.other.echo",
      "com.example.plugin.",
      "com.example.plugin.Echo",
      "com.example.plugin.echo/extra",
      "com.example.plugin.9lives",
    ]) {
      expectIssue(
        expectInvalid(baseManifest({ tools: [{ name }] })),
        "invalid_value",
        "tools[0].name",
      );
    }
    expectIssue(
      expectInvalid(
        baseManifest({
          tools: [{ name: `com.example.plugin.${"a".repeat(200)}` }],
        }),
      ),
      "too_long",
      "tools[0].name",
    );

    expectIssue(expectInvalid(baseManifest({ tools: [{}] })), "missing_field", "tools[0].name");
    expectIssue(
      expectInvalid(baseManifest({ tools: [{ name: 123 }] })),
      "invalid_type",
      "tools[0].name",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          tools: [
            { name: "com.example.plugin.echo" },
            { name: "com.example.plugin.echo", description: "Duplicate" },
          ],
        }),
      ),
      "duplicate_value",
      "tools[1].name",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          tools: [{ name: "com.example.plugin.echo", description: 1 }],
        }),
      ),
      "invalid_type",
      "tools[0].description",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          tools: [{ name: "com.example.plugin.echo", description: "a".repeat(501) }],
        }),
      ),
      "too_long",
      "tools[0].description",
    );
    expectIssue(
      expectInvalid(baseManifest({ tools: "com.example.plugin.echo" })),
      "invalid_type",
      "tools",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          tools: Array.from({ length: 129 }, (_, index) => ({
            name: `com.example.plugin.tool${index}`,
          })),
        }),
      ),
      "too_many",
      "tools",
    );
  });

  it("bounds and validates plugin dependencies", () => {
    const manifest = expectValid(
      baseManifest({
        dependencies: [
          { id: "org.example.zeta", version: "2.0.0" },
          { id: "org.example.alpha", version: "1.0.0" },
        ],
      }),
    );
    expect(manifest.dependencies.map((dependency) => dependency.id)).toEqual([
      "org.example.alpha",
      "org.example.zeta",
    ]);

    expectIssue(
      expectInvalid(
        baseManifest({
          dependencies: [
            { id: "org.example.lib", version: "1.0.0" },
            { id: "org.example.lib", version: "1.0.0" },
          ],
        }),
      ),
      "duplicate_value",
      "dependencies[1].id",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          dependencies: [{ id: "com.example.plugin", version: "1.0.0" }],
        }),
      ),
      "invalid_value",
      "dependencies[0].id",
    );
    expectIssue(
      expectInvalid(baseManifest({ dependencies: [{ id: "Not-A-Domain", version: "1.0.0" }] })),
      "invalid_id",
      "dependencies[0].id",
    );
    expectIssue(
      expectInvalid(baseManifest({ dependencies: [{ id: "org.example.lib", version: "1.0" }] })),
      "invalid_version",
      "dependencies[0].version",
    );
    expectIssue(
      expectInvalid(baseManifest({ dependencies: [null] })),
      "invalid_type",
      "dependencies[0]",
    );
    expectIssue(
      expectInvalid(
        baseManifest({
          dependencies: Array.from({ length: 33 }, (_, index) => ({
            id: `org.example.dep${index}`,
            version: "1.0.0",
          })),
        }),
      ),
      "too_many",
      "dependencies",
    );
  });

  it("bounds display names and descriptions", () => {
    expectIssue(expectInvalid(baseManifest({ displayName: "" })), "invalid_value", "displayName");
    expectIssue(
      expectInvalid(baseManifest({ displayName: "   " })),
      "invalid_value",
      "displayName",
    );
    expectIssue(
      expectInvalid(baseManifest({ displayName: "a".repeat(121) })),
      "too_long",
      "displayName",
    );
    expectIssue(expectInvalid(baseManifest({ description: 123 })), "invalid_type", "description");
    expectIssue(
      expectInvalid(baseManifest({ description: "   " })),
      "invalid_value",
      "description",
    );
    expectIssue(
      expectInvalid(baseManifest({ description: "a".repeat(2_001) })),
      "too_long",
      "description",
    );
  });
});

describe("manifest guards", () => {
  it("recognizes only worker and router targets", () => {
    expect(isPluginTarget("worker")).toBe(true);
    expect(isPluginTarget("router")).toBe(true);
    expect(isPluginTarget("desktop")).toBe(false);
    expect(isPluginTarget(null)).toBe(false);
  });

  it("recognizes safe relative entrypoint paths", () => {
    expect(isSafeRelativeEntryPath("dist/extension.js")).toBe(true);
    expect(isSafeRelativeEntryPath("extension.js")).toBe(true);
    for (const value of [
      "../extension.js",
      "/extension.js",
      "dist\\extension.js",
      "C:/extension.js",
      "./extension.js",
      "dist//extension.js",
      "dist/",
      "",
      null,
    ]) {
      expect(isSafeRelativeEntryPath(value)).toBe(false);
    }
  });
});
