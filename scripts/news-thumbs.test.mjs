import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function buildNewsThumbs() {
  const out = mkdtempSync(join(tmpdir(), "act-thumbs-"));
  const entry = join(ROOT, "src/lib/news-thumbs.ts");
  const r = spawnSync(
    "npx",
    ["--yes", "esbuild", entry, `--outfile=${join(out, "news-thumbs.js")}`, "--format=esm", "--platform=node"],
    { encoding: "utf8", cwd: ROOT },
  );
  if (r.status !== 0) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(r.stderr || r.stdout || "esbuild failed");
  }
  return out;
}

test("CSP img-src allows https for publisher thumbs without gutting other directives", () => {
  const src = readFileSync(join(ROOT, "src/lib/security/headers.ts"), "utf8");
  assert.match(src, /img-src[^"]*https:/);
  assert.match(src, /script-src 'self' 'unsafe-inline'/);
  assert.match(src, /object-src 'none'/);
  assert.match(src, /frame-ancestors 'none'/);
  // Still not a wildcard default-src.
  assert.match(src, /default-src 'self'/);
  assert.doesNotMatch(src, /default-src \*/);
});

test("live-sources enriches thumbs and prefers pickBestImage", () => {
  const src = readFileSync(join(ROOT, "src/lib/live-sources.ts"), "utf8");
  assert.match(src, /enrichStoryImages/);
  assert.match(src, /pickBestImage/);
  assert.match(src, /from "\.\/news-thumbs"/);
});

test("NewsView keeps ShareButton on stories", () => {
  const src = readFileSync(join(ROOT, "src/components/views/news-view.tsx"), "utf8");
  assert.match(src, /ShareButton/);
  assert.match(src, /newsSharePayload/);
  assert.match(src, /function Thumb/);
});

test("generic detection, OG parse, and pickBestImage", async () => {
  const out = buildNewsThumbs();
  try {
    const mod = await import(pathToFileURL(join(out, "news-thumbs.js")).href);
    const {
      isGenericOutletImage,
      isUsableStoryImage,
      pickBestImage,
      parseOgImageFromHtml,
    } = mod;

    assert.equal(
      isGenericOutletImage(
        "https://www.news10.com/wp-content/uploads/sites/64/2022/10/cropped-NEWS-10-SITE-ICON_512X512.jpg?w=32",
      ),
      true,
    );
    assert.equal(
      isGenericOutletImage(
        "https://cbs6albany.com/resources/media2/16x9/981/986/3x0/90/93a98149-6cfa-4587-8cb0-5b558a0bb359-Firegeneric.jpg",
      ),
      true,
    );
    assert.equal(
      isUsableStoryImage(
        "https://www.news10.com/wp-content/uploads/sites/64/2026/09/Pablo-Ortiz-still.jpg?w=900",
      ),
      true,
    );

    const best = pickBestImage([
      "https://www.news10.com/wp-content/uploads/sites/64/2022/10/cropped-NEWS-10-SITE-ICON_512X512.jpg?w=32",
      "https://www.news10.com/wp-content/uploads/sites/64/2026/09/real-story-photo.jpg",
    ]);
    assert.match(best, /real-story-photo/);

    const html = `
      <html><head>
        <meta property="og:image" content="https://cdn.example.com/story/hero.jpg" />
        <meta name="twitter:image" content="https://cdn.example.com/logo.png" />
      </head></html>
    `;
    assert.equal(parseOgImageFromHtml(html), "https://cdn.example.com/story/hero.jpg");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
