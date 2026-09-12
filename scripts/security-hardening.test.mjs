import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function buildSecurityModules() {
  const out = mkdtempSync(join(tmpdir(), "act-sec-"));
  const entrypoints = [
    join(ROOT, "src/lib/security/sanitize.ts"),
    join(ROOT, "src/lib/security/headers.ts"),
    join(ROOT, "src/lib/security/admin-token.server.ts"),
  ];
  const r = spawnSync(
    "npx",
    ["--yes", "esbuild", ...entrypoints, `--outdir=${out}`, "--format=esm", "--platform=node"],
    { encoding: "utf8", cwd: ROOT },
  );
  if (r.status !== 0) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(r.stderr || r.stdout || "esbuild failed");
  }
  return out;
}

test("nitro security middleware exists and denies dotfiles", () => {
  const mw = readFileSync(join(ROOT, "server/middleware/security-headers.ts"), "utf8");
  assert.match(mw, /isDeniedDotfilePath/);
  assert.match(mw, /applySecurityHeaders/);
});

test("ready route keeps public body minimal and gates subscribe", () => {
  const src = readFileSync(join(ROOT, "src/routes/ready.ts"), "utf8");
  assert.match(src, /isAdminAuthorized/);
  assert.match(src, /Response\.json\(\{\s*ok:\s*true\s*\}\)/);
  // Call site (not the import) must be after the auth gate.
  const afterAuth = src.split("isAdminAuthorized")[2] || src.split("isAdminAuthorized")[1] || "";
  assert.match(afterAuth, /ensureSuperfeedrSubscriptions/);
  const publicReturn = src.indexOf("return Response.json({ ok: true })");
  const callSite = src.lastIndexOf("ensureSuperfeedrSubscriptions");
  assert.ok(publicReturn > 0, "public minimal return present");
  assert.ok(callSite > publicReturn, "subscribe kick only after public early-return");
});

test("webhook keeps HMAC and adds body/content-type/rate limits", () => {
  const src = readFileSync(join(ROOT, "src/routes/api.superfeedr.webhook.ts"), "utf8");
  assert.match(src, /verifySuperfeedrSignature/);
  assert.match(src, /MAX_WEBHOOK_BODY_BYTES/);
  assert.match(src, /isAllowedWebhookContentType/);
  assert.match(src, /share-ingest/);
});

test("SECURITY.md documents threat model and residual risk", () => {
  const md = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
  assert.match(md, /Threat model/i);
  assert.match(md, /Residual risk/i);
  assert.match(md, /not.*unhackable/i);
});

test("VITE_ example does not carry API secrets", () => {
  const env = readFileSync(join(ROOT, ".env.example"), "utf8");
  assert.match(env, /VITE_AUTH_ENABLED/);
  assert.doesNotMatch(env, /VITE_XAI|VITE_SUPERFEEDR|VITE_OPENAI/);
  assert.match(env, /never put API secrets in VITE_/i);
});

test("sanitize/headers/admin-token behavior", async () => {
  const out = buildSecurityModules();
  try {
    const { stripHtml, isAllowedWebhookContentType } = await import(
      pathToFileURL(join(out, "sanitize.js")).href
    );
    const { contentSecurityPolicy, isDeniedDotfilePath, applySecurityHeaders } = await import(
      pathToFileURL(join(out, "headers.js")).href
    );
    const { safeEqualString, isAdminAuthorized } = await import(
      pathToFileURL(join(out, "admin-token.server.js")).href
    );

    assert.equal(stripHtml("<b>Hi</b> there", 80), "Hi there");
    assert.equal(isAllowedWebhookContentType("application/json"), true);
    assert.equal(isAllowedWebhookContentType("text/html"), false);
    assert.equal(isDeniedDotfilePath("/.env"), true);
    assert.equal(isDeniedDotfilePath("/ready"), false);

    const csp = contentSecurityPolicy();
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /fonts\.googleapis\.com/);
    assert.match(csp, /broadcastify/);
    assert.match(csp, /img-src[^;]*https:/);
    assert.match(csp, /default-src 'self'/);

    const store = new Map();
    applySecurityHeaders(
      { get: (n) => store.get(n) ?? null, set: (n, v) => store.set(n, v) },
      { https: true },
    );
    assert.equal(store.get("X-Content-Type-Options"), "nosniff");
    assert.match(String(store.get("Strict-Transport-Security")), /max-age=/);

    assert.equal(safeEqualString("abc", "abc"), true);
    assert.equal(safeEqualString("abc", "abd"), false);

    const prev = process.env.SUPERFEEDR_ADMIN_TOKEN;
    try {
      process.env.SUPERFEEDR_ADMIN_TOKEN = "tok-xyz";
      const good = new Request("https://example.test/ready", {
        headers: { authorization: "Bearer tok-xyz" },
      });
      const bad = new Request("https://example.test/ready", {
        headers: { authorization: "Bearer no" },
      });
      assert.equal(isAdminAuthorized(good, false), true);
      assert.equal(isAdminAuthorized(bad, false), false);
    } finally {
      if (prev === undefined) delete process.env.SUPERFEEDR_ADMIN_TOKEN;
      else process.env.SUPERFEEDR_ADMIN_TOKEN = prev;
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
