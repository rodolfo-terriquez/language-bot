import indexHandler from "./api/index.js";
import healthHandler from "./api/health.js";
import notifyHandler from "./api/notify.js";
import setupHandler from "./api/setup.js";
import telegramHandler from "./api/telegram.js";
import type { HttpRequest, HttpResponse } from "./lib/http.js";

type SimpleKVNamespace = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

type Env = Record<string, string | SimpleKVNamespace | undefined> & {
  LANGUAGE_BOT_KV?: SimpleKVNamespace;
};

type HttpHandler = (req: HttpRequest, res: HttpResponse) => Promise<void> | void;

class ResponseCapture implements HttpResponse {
  private statusCode = 200;
  private body: BodyInit = "";
  private headers = new Headers();

  status(code: number): HttpResponse {
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
    __LANGUAGE_BOT_KV?: SimpleKVNamespace;
    process?: { env?: Record<string, string | undefined> };
  };

  globalWithProcess.__LANGUAGE_BOT_KV = env.LANGUAGE_BOT_KV;
  globalWithProcess.process = globalWithProcess.process || {};
  globalWithProcess.process.env = {
    ...(globalWithProcess.process.env || {}),
  };

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      globalWithProcess.process.env[key] = value;
    }
  }
}

async function toHttpRequest(request: Request): Promise<HttpRequest> {
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
  let rawBody: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    rawBody = await request.text();
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } else {
      body = rawBody;
    }
  }

  return {
    method: request.method,
    body,
    rawBody,
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

async function runHandler(handler: HttpHandler, request: Request): Promise<Response> {
  const req = await toHttpRequest(request);
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
      return runHandler(indexHandler as HttpHandler, request);
    }
    if (path === "/api/health") {
      return runHandler(healthHandler as HttpHandler, request);
    }
    if (path === "/api/notify") {
      return runHandler(notifyHandler as HttpHandler, request);
    }
    if (path === "/api/setup") {
      return runHandler(setupHandler as HttpHandler, request);
    }
    if (path === "/api/telegram") {
      return runHandler(telegramHandler as HttpHandler, request);
    }

    return new Response("Not found", { status: 404 });
  },
};
