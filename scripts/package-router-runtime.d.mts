/** Types for the packaging helper, which is executed directly by Node. */
export interface PinnedPiPackage {
  version: string;
  integrity?: string;
  [key: string]: unknown;
}

export function readPinnedPiVersion(source: string): string;
export function validatePiPackageManifest(manifest: unknown, expectedVersion: string): unknown;
export function assertSafeArchivePath(name: string): void;
export function parsePiTarball(gzipBytes: Uint8Array, expectedVersion: string): unknown;
export function mergeRuntimeTree(source: string, target: string): Promise<void>;
