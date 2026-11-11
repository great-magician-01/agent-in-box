// Minimal phase-0 Model Broker: holds the real provider credential outside the
// VM and forwards OpenAI-compatible streaming requests after authenticating a
// local, VM-scoped token. No request/response content or secrets are logged.
import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";

const upstreamConfig = process.env.AIB_UPSTREAM_MODELS_JSON;
const upstreamProvider = process.env.AIB_UPSTREAM_PROVIDER || "any-llm";
const listenPort = Number(process.env.AIB_BROKER_PORT || 6719);
const tokenFile = process.env.AIB_BROKER_TOKEN_FILE;

if (!upstreamConfig || !tokenFile) {
  throw new Error("AIB_UPSTREAM_MODELS_JSON and AIB_BROKER_TOKEN_FILE are required");
}
const config = JSON.parse(fs.readFileSync(upstreamConfig, "utf8"));
const provider = config.providers?.[upstreamProvider];
if (!provider?.baseUrl || !provider?.apiKey) {
  throw new Error(`provider ${upstreamProvider} needs baseUrl and apiKey`);
}
const brokerToken = fs.readFileSync(tokenFile, "utf8").trim();
const upstreamBase = provider.baseUrl.replace(/\/$/, "");

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${brokerToken}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid broker token" } }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const parsed = JSON.parse(body.toString("utf8"));
    const started = Date.now();
    const upstream = await fetch(upstreamBase + req.url.replace(/^\/v1/, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body,
    });
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        model: parsed.model,
        stream: Boolean(parsed.stream),
        status: upstream.status,
        requestBytes: body.length,
      }),
    );
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    });
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
    res.on("finish", () => {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          durationMs: Date.now() - started,
          done: true,
        }),
      );
    });
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(error) }));
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: "model broker upstream failure" } }));
  }
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`model broker listening on 127.0.0.1:${listenPort}`);
});
