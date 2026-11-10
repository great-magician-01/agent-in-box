import { describe, expect, it } from "vitest";
import { controlPlaneConfigFromEnv, defaultDataRoot, storageLayout, vmDirectory } from "./index";

describe("control plane config", () => {
  it("defaults to loopback", () => {
    expect(controlPlaneConfigFromEnv({})).toEqual({ host: "127.0.0.1", port: 3000 });
  });

  it("rejects invalid ports", () => {
    expect(() => controlPlaneConfigFromEnv({ CONTROL_PLANE_PORT: "0" })).toThrow();
    expect(() => controlPlaneConfigFromEnv({ CONTROL_PLANE_PORT: "abc" })).toThrow();
  });
});

describe("storage layout", () => {
  it("keeps large files under the selected root", () => {
    const layout = storageLayout("/data/agent-in-box");
    expect(layout.images).toBe("/data/agent-in-box/images");
    expect(layout.vms).toBe("/data/agent-in-box/vms");
    expect(layout.database).toBe("/data/agent-in-box/agent-in-box.sqlite");
  });

  it("honors the explicit data root override", () => {
    expect(defaultDataRoot("linux", "/home/user", { AGENT_IN_BOX_DATA_ROOT: "/mnt/vm" })).toBe(
      "/mnt/vm",
    );
  });

  it("rejects VM ids that could escape the storage root", () => {
    const layout = storageLayout("/data");
    expect(vmDirectory(layout, "vm-1")).toBe("/data/vms/vm-1");
    expect(() => vmDirectory(layout, "../escape")).toThrow("Invalid VM id");
  });
});
