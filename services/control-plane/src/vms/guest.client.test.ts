import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuestClient } from "./guest.client";

describe("GuestClient session boundary errors", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "agent-in-box-guest-client-"));
    await writeFile(path.join(directory, "guest-agent.token"), "test-guest-token", { mode: 0o600 });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves the Guest error code for a locked Windows input action", async () => {
    const client = new GuestClient({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            actionId: "locked-action",
            ok: false,
            error: "Windows secure desktop is active",
            errorCode: "secure_desktop",
          }),
          { status: 423, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      client.input(
        { hostPort: 17611, storageRoot: directory },
        { type: "move", point: { x: 10, y: 10 } },
        "locked-action",
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { guestCode: "secure_desktop" },
    });
  });

  it("preserves the Guest error code for a locked screenshot", async () => {
    const client = new GuestClient({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "session_locked", message: "Windows session is locked" },
          }),
          { status: 423, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      client.screenshot({ hostPort: 17611, storageRoot: directory }),
    ).rejects.toMatchObject({
      code: "conflict",
      details: { guestCode: "session_locked" },
    });
  });
});
