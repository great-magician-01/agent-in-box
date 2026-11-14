import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPluginPackage } from "@agent-in-box/plugin-runtime";

interface ToolDefinition {
  execute(
    id: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ details: Record<string, unknown> }>;
}

const extensionPath = fileURLToPath(
  new URL("../extensions/plugin-development-extension.js", import.meta.url),
);
const templatePath = fileURLToPath(new URL("../../plugin-runtime/template", import.meta.url));

let temporaryRoot = "";
let server: Server | null = null;
let tools: Record<string, ToolDefinition>;
let previousEnvironment: Record<string, string | undefined>;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aib-plugin-development-"));
  previousEnvironment = Object.fromEntries(
    [
      "AGENT_IN_BOX_PLUGIN_TEMPLATE",
      "AGENT_IN_BOX_PLUGIN_DEV_URL",
      "AGENT_IN_BOX_PLUGIN_DEV_TOKEN",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.AGENT_IN_BOX_PLUGIN_TEMPLATE = templatePath;
  const { default: register } = await import(pathToFileURL(extensionPath).href);
  tools = {};
  register({
    registerTool(definition: ToolDefinition) {
      tools[definitionName(definition)] = definition;
    },
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("plugin development extension", () => {
  it("scaffolds, actually tests, registers and conditionally enables the exact package", async () => {
    const root = path.join(temporaryRoot, "new-plugin");
    const scaffold = await tools.plugin_development_scaffold!.execute("test", {
      targetPath: root,
      pluginId: "local.example",
      displayName: "Example",
    });
    expect(scaffold.details.ok).toBe(true);
    const inspected = await inspectPluginPackage(root);
    expect(inspected.manifest.id).toBe("local.example");

    let registeredReport: Record<string, unknown> | null = null;
    let enabled = false;
    await startBroker((body, url) => {
      if (url === "/v1/inspect") {
        return { ok: true, packageSha256: inspected.packageSha256, manifest: inspected.manifest };
      }
      if (url === "/v1/register") {
        registeredReport = body.testReport as Record<string, unknown>;
        return {
          ok: true,
          plugin: { pluginId: "local.example", version: "0.1.0" },
          autoEnableAllowed: true,
        };
      }
      if (url === "/v1/enable") {
        enabled = true;
        return { ok: true, enablement: { enabled: true } };
      }
      return null;
    });

    const result = await tools.plugin_development_register!.execute("test", { root });
    expect(result.details.ok).toBe(true);
    expect(result.details.enablement).toEqual({ enabled: true });
    expect(registeredReport).toMatchObject({
      status: "passed",
      packageSha256: inspected.packageSha256,
      exitCode: 0,
    });
    expect(enabled).toBe(true);
  });

  it("does not register when the real package tests fail", async () => {
    const root = path.join(temporaryRoot, "broken-plugin");
    await tools.plugin_development_scaffold!.execute("test", {
      targetPath: root,
      pluginId: "local.broken",
      displayName: "Broken",
    });
    await writeFile(
      path.join(root, "test", "extension.node-test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("fail", () => assert.fail("broken"));\n',
    );
    const inspected = await inspectPluginPackage(root);
    let registerCalls = 0;
    await startBroker((_body, url) => {
      if (url === "/v1/inspect") {
        return { ok: true, packageSha256: inspected.packageSha256, manifest: inspected.manifest };
      }
      if (url === "/v1/register") registerCalls += 1;
      return null;
    });

    const result = await tools.plugin_development_register!.execute("test", { root });
    expect(result.details.ok).toBe(false);
    expect(result.details.stage).toBe("tests");
    expect(registerCalls).toBe(0);
  });
});

async function startBroker(
  handler: (body: Record<string, unknown>, url: string) => unknown,
): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const result = handler(body, request.url ?? "");
      response.writeHead(result ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? { ok: false, error: { message: "not found" } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  process.env.AGENT_IN_BOX_PLUGIN_DEV_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AGENT_IN_BOX_PLUGIN_DEV_TOKEN = "test-only-development-token";
}

function definitionName(definition: ToolDefinition): string {
  return (definition as unknown as { name: string }).name;
}
