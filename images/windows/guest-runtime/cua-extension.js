import { Type } from "typebox";

// Guest-side Pi extension for phase 7. Every call goes to the host Computer Use
// Broker; this file never talks to the Guest Agent token or the VM Supervisor.
// The broker enforces task binding, leases, policy, approvals and trace.

function cuaUrl() {
  const value = (process.env.AGENT_IN_BOX_CUA_URL || "").trim();
  if (!value) throw new Error("AGENT_IN_BOX_CUA_URL is not configured for this Worker session");
  return value.replace(/\/$/, "");
}

function cuaToken() {
  const value = (process.env.AGENT_IN_BOX_CUA_TOKEN || "").trim();
  if (!value) throw new Error("AGENT_IN_BOX_CUA_TOKEN is not configured for this Worker session");
  return value;
}

async function broker(path, body, signal) {
  const response = await fetch(cuaUrl() + path, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${cuaToken()}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Computer Use Broker returned HTTP ${response.status} without JSON`);
  }
  if (!response.ok || payload?.ok !== true) {
    const message = payload?.error?.message || `Computer Use Broker HTTP ${response.status}`;
    const code = payload?.error?.code ? ` [${payload.error.code}]` : "";
    throw new Error(message + code);
  }
  return payload;
}

function screenshotContent(result, prefix) {
  return {
    content: [
      {
        type: "text",
        text: `${prefix} screenshotId=${result.screenshotId} ${result.width}x${result.height} dpi=${result.dpi} scale=${result.scaleFactor}`,
      },
      { type: "image", data: result.image.dataBase64, mimeType: result.image.mimeType },
    ],
    details: {
      screenshotId: result.screenshotId,
      width: result.width,
      height: result.height,
      dpi: result.dpi,
      scaleFactor: result.scaleFactor,
    },
  };
}

function actionResultContent(result) {
  return {
    content: [
      {
        type: "text",
        text: `Action ${result.actionId} ${result.status}; screenshotId=${result.screenshotId} ${result.display.width}x${result.display.height}`,
      },
      { type: "image", data: result.image.dataBase64, mimeType: result.image.mimeType },
    ],
    details: {
      actionId: result.actionId,
      status: result.status,
      screenshotId: result.screenshotId,
      display: result.display,
    },
  };
}

function actionTool(name, label, description, parameters, buildAction) {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_id, params, signal) {
      const screenshotId = params.screenshotId;
      if (!screenshotId) throw new Error("screenshotId is required; call vm_screenshot first");
      const result = await broker(
        "/v1/actions",
        { action: buildAction(params), screenshotId },
        signal,
      );
      return actionResultContent(result);
    },
  };
}

const coordinateSpace = Type.Optional(
  Type.String({ description: "pixels (default) or normalized (0..1)" }),
);

export default function registerComputerUse(pi) {
  pi.registerTool({
    name: "vm_screenshot",
    label: "VM Screenshot",
    description:
      "Capture the current Linux VM desktop and return its screenshotId. Always observe before acting, and use the latest screenshotId.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return screenshotContent(await broker("/v1/observe", {}, signal), "Current VM");
    },
  });

  pi.registerTool(
    actionTool(
      "vm_click",
      "VM Click",
      "Click an absolute or normalized desktop coordinate in the Linux VM. Use this screenshotId from the most recent observation.",
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        screenshotId: Type.String(),
        button: Type.Optional(Type.String({ description: "left (default), right or middle" })),
        count: Type.Optional(Type.Number({ description: "1 or 2" })),
        coordinateSpace,
      }),
      (params) => ({
        type: "click",
        point: { x: params.x, y: params.y },
        ...(params.button ? { button: params.button } : {}),
        ...(params.count ? { count: params.count } : {}),
        ...(params.coordinateSpace ? { coordinateSpace: params.coordinateSpace } : {}),
      }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_double_click",
      "VM Double Click",
      "Double-click a desktop coordinate in the Linux VM using the latest screenshotId.",
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        screenshotId: Type.String(),
        coordinateSpace,
      }),
      (params) => ({
        type: "click",
        point: { x: params.x, y: params.y },
        count: 2,
        ...(params.coordinateSpace ? { coordinateSpace: params.coordinateSpace } : {}),
      }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_move",
      "VM Move",
      "Move the VM pointer to a desktop coordinate using the latest screenshotId.",
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        screenshotId: Type.String(),
        coordinateSpace,
      }),
      (params) => ({
        type: "move",
        point: { x: params.x, y: params.y },
        ...(params.coordinateSpace ? { coordinateSpace: params.coordinateSpace } : {}),
      }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_type_text",
      "VM Type Text",
      "Type UTF-8 text, including Chinese, into the focused VM window. Sensitive by default: the host may require approval before execution.",
      Type.Object({ text: Type.String(), screenshotId: Type.String() }),
      (params) => ({ type: "type_text", text: params.text }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_keypress",
      "VM Keypress",
      "Press a key chord such as enter, ctrl+s or alt+tab in the VM. Sensitive by default: the host may require approval.",
      Type.Object({ keys: Type.Array(Type.String()), screenshotId: Type.String() }),
      (params) => ({ type: "keypress", keys: params.keys }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_scroll",
      "VM Scroll",
      "Scroll at an optional desktop coordinate using the latest screenshotId.",
      Type.Object({
        deltaX: Type.Number(),
        deltaY: Type.Number(),
        screenshotId: Type.String(),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        coordinateSpace,
      }),
      (params) => ({
        type: "scroll",
        deltaX: params.deltaX,
        deltaY: params.deltaY,
        ...(params.x !== undefined && params.y !== undefined
          ? { point: { x: params.x, y: params.y } }
          : {}),
        ...(params.coordinateSpace ? { coordinateSpace: params.coordinateSpace } : {}),
      }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_drag",
      "VM Drag",
      "Drag between two desktop coordinates in the VM using the latest screenshotId. Sensitive by default: the host may require approval.",
      Type.Object({
        fromX: Type.Number(),
        fromY: Type.Number(),
        toX: Type.Number(),
        toY: Type.Number(),
        screenshotId: Type.String(),
        coordinateSpace,
      }),
      (params) => ({
        type: "drag",
        from: { x: params.fromX, y: params.fromY },
        to: { x: params.toX, y: params.toY },
        ...(params.coordinateSpace ? { coordinateSpace: params.coordinateSpace } : {}),
      }),
    ),
  );

  pi.registerTool(
    actionTool(
      "vm_wait",
      "VM Wait",
      "Wait before observing the VM again.",
      Type.Object({ milliseconds: Type.Number(), screenshotId: Type.Optional(Type.String()) }),
      (params) => ({ type: "wait", milliseconds: params.milliseconds }),
    ),
  );

  pi.registerTool({
    name: "vm_task_complete",
    label: "Complete Task",
    description:
      "Declare the task complete. The host independently verifies the evidence; a model statement alone never completes a task. Provide at least one evidence item: a file path (optionally SHA-256/size), a live process name, or a screenshotId.",
    parameters: Type.Object({
      summary: Type.String({ description: "What was accomplished" }),
      evidence: Type.Array(
        Type.Object({
          type: Type.String({ description: "screenshot, file or process" }),
          screenshotId: Type.Optional(Type.String()),
          path: Type.Optional(Type.String({ description: "absolute guest path" })),
          sha256: Type.Optional(Type.String()),
          sizeBytes: Type.Optional(Type.Number()),
          name: Type.Optional(Type.String({ description: "exact process name" })),
        }),
        { minItems: 1, maxItems: 8 },
      ),
    }),
    async execute(_id, params, signal) {
      const result = await broker(
        "/v1/complete",
        { summary: params.summary, evidence: params.evidence },
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Task ${result.taskId} completed; verified evidence: ${result.evidence
              .map((item) => item.type)
              .join(", ")}`,
          },
        ],
        details: result,
      };
    },
  });
}
