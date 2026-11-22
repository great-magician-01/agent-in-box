import { rename, stat } from "node:fs/promises";
import path from "node:path";

/**
 * electron-builder excludes source directories named node_modules from
 * extraResources. package-control-plane therefore stages the deploy tree as
 * runtime_modules; restore its standard name before installers are archived so
 * both CommonJS and ESM package resolution work without relying on NODE_PATH.
 */
export default async function restoreControlPlaneNodeModules(context) {
  const resourcesDirectory = context.packager.getResourcesDir(context.appOutDir);
  const controlPlaneDirectory = path.join(resourcesDirectory, "control-plane");
  const stagedModules = path.join(controlPlaneDirectory, "runtime_modules");
  const nodeModules = path.join(controlPlaneDirectory, "node_modules");

  const details = await stat(stagedModules).catch(() => null);
  if (!details?.isDirectory()) {
    throw new Error(`Packaged control plane dependency tree is missing: ${stagedModules}`);
  }
  const existing = await stat(nodeModules).catch(() => null);
  if (existing) {
    throw new Error(`Refusing to replace an existing packaged dependency tree: ${nodeModules}`);
  }
  await rename(stagedModules, nodeModules);

  // A release artifact must be able to verify its own update feed. Local
  // packaging may omit the key, in which case the app fails closed (no update
  // checks) instead of trusting an unverified manifest.
  if (process.env.AGENT_IN_BOX_REQUIRE_RELEASE_SIGNING === "1") {
    for (const keyName of ["update-public-key.pem", "runtime-public-key.pem"]) {
      const key = await stat(path.join(resourcesDirectory, keyName)).catch(() => null);
      if (!key?.isFile()) {
        throw new Error(`Release packaging requires ${path.join(resourcesDirectory, keyName)}`);
      }
    }
    for (const required of [
      "vm-supervisor",
      "guest-runtime",
      "router-runtime",
      "control-plane",
      "web",
    ]) {
      const directory = await stat(path.join(resourcesDirectory, required)).catch(() => null);
      if (!directory?.isDirectory()) {
        throw new Error(`Release packaging is missing required resource: ${required}`);
      }
    }
  }
}
