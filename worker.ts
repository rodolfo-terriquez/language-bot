import indexHandler from "./api/index.js";
import healthHandler from "./api/health.js";
import notifyHandler from "./api/notify.js";
import setupHandler from "./api/setup.js";
import telegramHandler from "./api/telegram.js";

type Env = Record<string, string | undefined>;

type VercelLikeRequest = {
  method: string;
  body?: unknown;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
};

type VercelLikeResponse = {
  status: (code: number) => VercelLikeResponse;
  json: (body: unknown) => void;
  send: (body: string) => void;
};

type VercelHandler = (req: VercelLikeRequest, res: VercelLikeResponse) => Promise<void> | void;

class ResponseCapture implements VercelLikeResponse {
  private statusCode = 200;
  private body: BodyInit = "";
  private headers = new Headers();

  status(code: number): VercelLikeResponse {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): void {
    this.headers.set("content-type", "application/json; charset=utf-8");
    this.body = JSON.stringify(body);
  }

  send(body: string): void {
    if (!this.headers.has("content-type")) {
      this.headers.set("content-type", "text/html; charset=utf-8");
    }
    this.body = body;
  }

  toResponse(): Response {
    return new Response(this.body, {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

function installProcessEnv(env: Env): void {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };

  globalWithProcess.process = globalWithProcess.process || {};
  globalWithProcess.process.env = {
    ...(globalWithProcess.process.env || {}),
    ...env,
  };
}

async function toVercelLikeRequest(request: Request): Promise<VercelLikeRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
    headers[key] = value;
  });
  headers.host = url.host;

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  let body: unknown;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const text = await request.text();
      body = text ? JSON.parse(text) : undefined;
    } else {
      body = await request.text();
    }
  }

  return {
    method: request.method,
    body,
    query,
    headers,
  };
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

async function runHandler(handler: VercelHandler, request: Request): Promise<Response> {
  const req = await toVercelLikeRequest(request);
  const res = new ResponseCapture();
  await handler(req, res);
  return res.toResponse();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    installProcessEnv(env);

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (path === "/" || path === "/api") {
      return runHandler(indexHandler as VercelHandler, request);
    }
    if (path === "/api/health") {
      return runHandler(healthHandler as VercelHandler, request);
    }
    if (path === "/api/notify") {
      return runHandler(notifyHandler as VercelHandler, request);
    }
    if (path === "/api/setup") {
      return runHandler(setupHandler as VercelHandler, request);
    }
    if (path === "/api/telegram") {
      return runHandler(telegramHandler as VercelHandler, request);
    }

    return new Response("Not found", { status: 404 });
  },
};
