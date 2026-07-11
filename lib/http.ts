export type HttpRequest = {
  method: string;
  body?: unknown;
  rawBody?: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
};

export type HttpResponse = {
  status: (code: number) => HttpResponse;
  json: (body: unknown) => void;
  send: (body: string) => void;
};
