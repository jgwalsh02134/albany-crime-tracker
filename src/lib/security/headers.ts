/**
 * Shared security header values for Nitro middleware / route responses.
 * Honest defense-in-depth: CSP allows Map tiles, Google Fonts, Broadcastify HLS, HTTPS images.
 */

export const SECURITY_HEADER_NAMES = [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "X-Frame-Options",
  "Cross-Origin-Opener-Policy",
  "Strict-Transport-Security",
] as const;

/** CSP tuned for Map (Esri), fonts, Broadcastify, and HTTPS news thumbs — not "unhackable". */
export function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    // Vite/TanStack Start often needs inline for boot; avoid unsafe-eval.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // https: for publisher thumbs (News10/CBS6/etc); scripts/connect stay locked down.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https://*.broadcastify.com https://hls-o1.broadcastify.com https://hls-o2.broadcastify.com",
    "connect-src 'self' https://*.broadcastify.com https://server.arcgisonline.com https://*.arcgisonline.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

export function permissionsPolicy(): string {
  return [
    "camera=()",
    "microphone=()",
    "geolocation=(self)",
    "payment=()",
    "usb=()",
    "interest-cohort=()",
    "accelerometer=()",
    "gyroscope=()",
    "magnetometer=()",
    "display-capture=()",
  ].join(", ");
}

export type HeaderTarget = {
  set(name: string, value: string): void;
  get(name: string): string | null;
};

/** Apply baseline security headers. HSTS only when the request arrived over HTTPS. */
export function applySecurityHeaders(
  headers: HeaderTarget,
  opts: { https: boolean; isDocument?: boolean } = { https: false },
): void {
  if (!headers.get("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", contentSecurityPolicy());
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", permissionsPolicy());
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (opts.https) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

/** Paths like /.env, /.git/config, /foo/.bar — deny probing of dotfiles. */
export function isDeniedDotfilePath(pathname: string): boolean {
  const path = pathname || "/";
  if (path === "/." || path === "/..") return true;
  const parts = path.split("/");
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith(".") && part !== "." && part !== "..") return true;
  }
  return false;
}

export function requestIsHttps(headers: Headers, url?: URL): boolean {
  const xf = headers.get("x-forwarded-proto");
  if (xf) return xf.split(",")[0]!.trim().toLowerCase() === "https";
  if (url?.protocol === "https:") return true;
  return false;
}
