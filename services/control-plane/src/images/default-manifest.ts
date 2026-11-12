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
      id: "ubuntu-24.04-20261017-amd64",
      name: "Ubuntu 24.04 LTS Cloud（官方镜像自动初始化）",
      osFamily: "linux",
      osVersion: "24.04",
      architecture: "amd64",
      version: "20261017",
      url: "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/noble/20261017/noble-server-cloudimg-amd64.img",
      fileName: "ubuntu-24.04-20261017-amd64.qcow2",
      sizeBytes: 621284352,
      sha256: "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94",
      provisioning: "linux-desktop-worker",
    },
  ],
};
