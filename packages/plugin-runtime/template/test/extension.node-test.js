import assert from "node:assert/strict";
import test from "node:test";
import register from "../src/extension.js";

test("registers a namespaced echo tool that returns input", async () => {
  let definition;
  const pi = {
    registerTool(value) {
      definition = value;
    },
  };
  register(pi);
  assert.equal(definition.name, "{{PLUGIN_ID}}.echo");
  const result = await definition.execute("test", { text: "hello" });
  assert.equal(result.content[0].text, "hello");
});
