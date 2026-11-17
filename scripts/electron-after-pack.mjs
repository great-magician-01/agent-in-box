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
}
