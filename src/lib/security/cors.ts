export type CorsOptions = {
  /**
   * Allowed origin value.
   * Use "*" for a fully public GET endpoint.
   */
  allowOrigin: string;
  /**
   * Comma-separated methods (e.g. "GET, OPTIONS").
   */
  allowMethods?: string;
  /**
   * Comma-separated request headers accepted during preflight.
   */
  allowHeaders?: string;
  /**
   * Comma-separated response headers clients may read.
   */
  exposeHeaders?: string;
  /**
   * Preflight cache lifetime.
   */
  maxAgeSec?: number;
};

export function publicCorsHeaders(opts: CorsOptions): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", opts.allowOrigin);
  h.set("Access-Control-Allow-Methods", opts.allowMethods ?? "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", opts.allowHeaders ?? "Accept, Content-Type");
  if (opts.exposeHeaders) h.set("Access-Control-Expose-Headers", opts.exposeHeaders);
  if (typeof opts.maxAgeSec === "number") h.set("Access-Control-Max-Age", String(Math.max(0, opts.maxAgeSec)));
  return h;
}

export function withCors(res: Response, cors: Headers): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of cors.entries()) headers.set(k, v);
  // Preserve body/status/statusText.
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

