export default function register(pi) {
  pi.registerTool({
    name: "{{PLUGIN_ID}}.echo",
    label: "Echo",
    description: "Return the supplied text without side effects",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: params.text }],
        details: { echoed: true },
      };
    },
  });
}
