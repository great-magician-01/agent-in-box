import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE, parseRoute, routeFor, routeHash } from "./routes";

describe("application routes", () => {
  it("keeps the conversation as the default destination", () => {
    expect(parseRoute("")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#/unknown")).toEqual(DEFAULT_ROUTE);
  });

  it("parses legacy top-level destinations", () => {
    expect(parseRoute("#/projects").view).toBe("projects");
    expect(parseRoute("#/settings").settingsSection).toBe("models");
  });

  it.each([
    ["#/session/worker/worker-1", "workerId", "worker-1"],
    ["#/projects/project-1", "projectId", "project-1"],
    ["#/tasks/task-1", "taskId", "task-1"],
  ] as const)("parses %s", (hash, key, id) => {
    expect(parseRoute(hash)[key]).toBe(id);
  });

  it("parses settings categories and rejects unknown categories", () => {
    expect(parseRoute("#/settings/storage").settingsSection).toBe("storage");
    expect(parseRoute("#/settings/not-a-section").settingsSection).toBe("models");
  });

  it("round-trips entity ids without losing URL escaping", () => {
    const route = routeFor("projects", "项目 / 1");
    const hash = routeHash(route);
    expect(hash).toBe("#/projects/%E9%A1%B9%E7%9B%AE%20%2F%201");
    expect(parseRoute(hash)).toEqual(route);
  });

  it("does not throw for a malformed escape sequence", () => {
    expect(parseRoute("#/tasks/%E0%A4%A").taskId).toBeNull();
  });
});
