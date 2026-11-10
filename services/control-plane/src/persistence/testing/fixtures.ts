import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppDatabase } from "../database";
import { CatalogRepository } from "../repositories/catalog-repository";

export interface TestContext {
  app: AppDatabase;
  dir: string;
  projectId: string;
  vmId: string;
  conversationId: string;
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-in-box-test-"));
  const app = AppDatabase.open({ filename: path.join(dir, "test.sqlite") });
  await app.migrate();

  const catalog = new CatalogRepository(app.db);
  const image = await catalog.createImage({
    name: "Test Linux image",
    osFamily: "linux",
    osVersion: "24.04",
    architecture: "amd64",
    version: "test-1",
    sizeBytes: 1_000_000,
    checksum: "test-checksum",
    localPath: path.join(dir, "images", "linux.qcow2"),
  });
  const project = await catalog.createProject({
    name: "Test project",
    description: "Persistence test project",
  });
  const vm = await catalog.createVm({
    name: "Test Linux VM",
    imageId: image.id,
    osFamily: "linux",
    cpuCount: 2,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    diskBytes: 20 * 1024 * 1024 * 1024,
    storageRoot: dir,
  });
  const conversation = await catalog.createConversation({
    kind: "project",
    projectId: project.id,
    title: "Test conversation",
  });

  return {
    app,
    dir,
    projectId: project.id,
    vmId: vm.id,
    conversationId: conversation.id,
    async close() {
      await this.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
