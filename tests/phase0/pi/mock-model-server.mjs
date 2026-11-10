// Script-driven OpenAI-compatible model for validating the Pi Computer Use loop
// without spending model tokens. It is not an LLM and is never used in production.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.MOCK_MODEL_PORT || 4000);
const logPath = process.env.MOCK_MODEL_LOG || "/tmp/aib-mock-model.jsonl";
let requestCounter = 0;

function toolCall(name, args) {
  requestCounter += 1;
  return {
    id: `call_mock_${requestCounter}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function decide(body) {
  const messages = body.messages || [];
  // Pi may place tool-result images in a synthetic user message, so counting
  // messages after the last user is not a reliable run counter. Count actual
  // assistant tool-call messages instead.
  const assistantToolCalls = messages.filter(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
  ).length;
  let slowIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    if (text.includes("slow")) {
      slowIndex = index;
      break;
    }
  }
  const slow = slowIndex >= 0;

  if (slow) {
    const waitIssued = messages.slice(slowIndex + 1).some(
      (message) => message.role === "assistant" && (message.tool_calls || []).some(
        (call) => call.function?.name === "vm_wait",
      ),
    );
    return waitIssued ? { text: "slow run finished" } : { tool: toolCall("vm_wait", { milliseconds: 30000 }) };
  }
  if (assistantToolCalls === 0) {
    return { tool: toolCall("vm_screenshot", {}) };
  }
  if (assistantToolCalls === 1) {
    return { tool: toolCall("vm_click", { x: 640, y: 400 }) };
  }
  if (assistantToolCalls === 2) {
    return { tool: toolCall("vm_type_text", { text: "echo 你好-pi > /tmp/aib-pi-cua-ok" }) };
  }
  if (assistantToolCalls === 3) {
    return { tool: toolCall("vm_keypress", { keys: ["enter"] }) };
  }
  return { text: "mock task complete" };
}

function sendJson(res, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(data);
}

function sendStream(res, decision, model) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const write = (delta, finishReason) => {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  };
  write({ role: "assistant" }, null);
  if (decision.tool) {
    write({ tool_calls: [{ index: 0, ...decision.tool, function: { name: decision.tool.function.name, arguments: "" } }] }, null);
    write({ tool_calls: [{ index: 0, function: { arguments: decision.tool.function.arguments } }] }, null);
    write({}, "tool_calls");
  } else {
    write({ content: decision.text }, null);
    write({}, "stop");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const decision = decide(body);
    const serialized = JSON.stringify(body);
    const record = {
      at: new Date().toISOString(),
      stream: Boolean(body.stream),
      toolResults: (body.messages || []).filter((message) => message.role === "tool").length,
      decision,
      sawImage: serialized.includes("image_url") || serialized.includes('"type":"image"'),
      sawPngBase64: serialized.includes("iVBORw0KGgo"),
      tools: (body.tools || []).map((tool) => tool.function?.name),
    };
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n");

    if (body.stream) {
      sendStream(res, decision, body.model);
    } else {
      const message = decision.tool
        ? { role: "assistant", content: null, tool_calls: [decision.tool] }
        : { role: "assistant", content: decision.text };
      sendJson(res, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message, finish_reason: decision.tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock model listening on 127.0.0.1:${port}`);
});
