import { Type } from "typebox";

const guestUrl = process.env.AGENT_IN_BOX_GUEST_URL || "http://127.0.0.1:7611";
const guestToken = process.env.AGENT_IN_BOX_GUEST_TOKEN || "";

async function guestRpc(path, body, signal) {
  const response = await fetch(guestUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${guestToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`guest agent ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function inputResult(body, signal) {
  const response = await guestRpc("/v1/input", body, signal);
  const result = await response.json();
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
}

export default function registerComputerUse(pi) {
  pi.registerTool({
    name: "vm_screenshot",
    label: "VM Screenshot",
    description: "Capture the current Linux VM desktop. Always observe before choosing coordinates.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const response = await guestRpc("/v1/screenshot", undefined, signal);
      const png = Buffer.from(await response.arrayBuffer()).toString("base64");
      const width = response.headers.get("x-agent-in-box-width");
      const height = response.headers.get("x-agent-in-box-height");
      return {
        content: [
          { type: "text", text: `Screenshot ${width}x${height}` },
          { type: "image", data: png, mimeType: "image/png" },
        ],
        details: { width: Number(width), height: Number(height) },
      };
    },
  });

  pi.registerTool({
    name: "vm_click",
    label: "VM Click",
    description: "Click an absolute desktop coordinate in the Linux VM.",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      button: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      return inputResult({ type: "click", point: { x: params.x, y: params.y }, button: params.button }, signal);
    },
  });

  pi.registerTool({
    name: "vm_type_text",
    label: "VM Type Text",
    description: "Type UTF-8 text, including Chinese, into the focused VM window.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params, signal) {
      return inputResult({ type: "type_text", text: params.text }, signal);
    },
  });

  pi.registerTool({
    name: "vm_keypress",
    label: "VM Keypress",
    description: "Press a key chord such as enter, ctrl+s or alt+tab in the VM.",
    parameters: Type.Object({ keys: Type.Array(Type.String()) }),
    async execute(_id, params, signal) {
      return inputResult({ type: "keypress", keys: params.keys }, signal);
    },
  });

  pi.registerTool({
    name: "vm_wait",
    label: "VM Wait",
    description: "Wait before observing the VM again.",
    parameters: Type.Object({ milliseconds: Type.Number() }),
    async execute(_id, params, signal) {
      return inputResult({ type: "wait", milliseconds: params.milliseconds }, signal);
    },
  });
}
