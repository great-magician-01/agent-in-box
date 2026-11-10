import type { ImageManifest } from "@agent-in-box/protocol";

/**
 * The base artifact validated by phase 0. A deployment can replace the source
 * with AGENT_IN_BOX_IMAGE_MANIFEST; version IDs and target names are immutable.
 * NoCloud seed images are intentionally deployment-specific because they carry
 * the user's SSH public key and guest bootstrap policy.
 */
export const DEFAULT_IMAGE_MANIFEST: ImageManifest = {
  schemaVersion: 1,
  allowedHosts: ["mirrors.tuna.tsinghua.edu.cn"],
  images: [
    {
      id: "ubuntu-24.04-2026-11-10-amd64",
      name: "Ubuntu 24.04 LTS Cloud（阶段 0 基线）",
      osFamily: "linux",
      osVersion: "24.04",
      architecture: "amd64",
      version: "2026-11-10",
      url: "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/noble/current/noble-server-cloudimg-amd64.img",
      fileName: "ubuntu-24.04-2026-11-10-amd64.qcow2",
      sizeBytes: 0,
      sha256: "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94",
    },
  ],
};
