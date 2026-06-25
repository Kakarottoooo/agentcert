import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleActionGatewayRequest, type ActionGatewayApiOptions } from "./api.js";

export function startActionGatewayServer(port: number, options: ActionGatewayApiOptions = {}): void {
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    const result = handleActionGatewayRequest(
      {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        body,
      },
      options,
    );

    response.statusCode = result.status;
    response.setHeader("content-type", result.contentType ?? "application/json; charset=utf-8");
    response.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
  });

  server.listen(port, () => {
    process.stdout.write(`AgentCert Onegent Runtime demo listening on http://localhost:${port}\n`);
    process.stdout.write(`Open http://localhost:${port}/action-gateway/walkthrough/procurement\n`);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (rawBody.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

export function writeJsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body, null, 2));
}
