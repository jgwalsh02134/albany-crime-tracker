/**
 * Global Nitro middleware: security headers + deny dotfile probes.
 * Auto-registered via vite.config.ts `serverDir: "./server"`.
 */
import {
  applySecurityHeaders,
  isDeniedDotfilePath,
  requestIsHttps,
} from "../../src/lib/security/headers";

interface SecurityEvent {
  url: URL;
  req: { method: string; headers: Headers };
}

function withSecurityHeaders(response: Response, event: SecurityEvent): Response {
  const https = requestIsHttps(event.req.headers, event.url);
  const headers = new Headers(response.headers);
  applySecurityHeaders(
    {
      get: (name) => headers.get(name),
      set: (name, value) => {
        headers.set(name, value);
      },
    },
    { https },
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default async function securityHeadersMiddleware(
  event: SecurityEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const path = event.url.pathname || "/";
  if (isDeniedDotfilePath(path)) {
    const https = requestIsHttps(event.req.headers, event.url);
    const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
    applySecurityHeaders(
      {
        get: (name) => headers.get(name),
        set: (name, value) => {
          headers.set(name, value);
        },
      },
      { https },
    );
    return new Response("Not Found", { status: 404, headers });
  }

  const result = await next();
  if (result instanceof Response) {
    return withSecurityHeaders(result, event);
  }
  return result;
}
