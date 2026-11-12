import { once } from "node:events";
import { createServer } from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import { installBodyParsers, RAW_UPLOAD_PATH } from "./body-parsers";

async function startApp() {
  const app = express();
  installBodyParsers(app);
  app.post(RAW_UPLOAD_PATH, async (request, response) => {
    let bytes = 0;
    for await (const chunk of request) {
      bytes += (chunk as Buffer).byteLength;
    }
    response.json({ bytes });
  });
  app.post("/api/v1/echo", (request, response) => {
    response.json({ body: request.body });
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("control-plane body parsers", () => {
  it("leaves an application/json inbox upload readable as a raw stream", async () => {
    const { server, url } = await startApp();
    try {
      const payload = JSON.stringify({ hello: "world" });
      const response = await fetch(`${url}${RAW_UPLOAD_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(await response.json()).toEqual({ bytes: Buffer.byteLength(payload) });
    } finally {
      server.close();
    }
  });

  it("still parses JSON for every other route", async () => {
    const { server, url } = await startApp();
    try {
      const response = await fetch(`${url}/api/v1/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 42 }),
      });
      expect(await response.json()).toEqual({ body: { value: 42 } });
    } finally {
      server.close();
    }
  });
});
