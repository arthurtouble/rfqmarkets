import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { COLORS } from "../packages/design-system/colors.js";
import { MASCOT_MOODS, mascotShapes, mascotSvg } from "../packages/design-system/mascot.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every mood draws Tick with brand colors only", () => {
  const palette = new Set<string>(Object.values(COLORS.dark));
  for (const mood of MASCOT_MOODS) {
    const shapes = mascotShapes(mood);
    assert.ok(shapes.length >= 5, mood);
    for (const shape of shapes) {
      assert.notEqual(
        Boolean(shape.fill),
        Boolean(shape.stroke),
        `${mood}: ${shape.d} needs a fill or a stroke`,
      );
      assert.ok(
        palette.has(shape.fill ?? shape.stroke!),
        `${mood}: ${shape.d} uses a color outside the tokens`,
      );
      if (shape.stroke) assert.ok(shape.width! > 0, `${mood}: ${shape.d} needs a stroke width`);
    }
  }
  // Tick's antenna points up when idle or winning and down when losing.
  const up = COLORS.dark.long,
    down = COLORS.dark.short;
  assert.ok(mascotShapes("win").some((shape) => shape.fill === up));
  assert.ok(mascotShapes("loss").some((shape) => shape.fill === down));
  assert.ok(!mascotShapes("loss").some((shape) => shape.fill === up));
});

test("the logo and every app's favicon are idle Tick", () => {
  const svg = mascotSvg("idle");
  assert.equal(read("packages/design-system/logo.svg"), `${svg}\n`);
  const favicon = `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23")}`;
  for (const app of readdirSync(new URL("../apps", import.meta.url)))
    assert.ok(read(`apps/${app}/index.html`).includes(`<link rel="icon" href="${favicon}"`), app);
});

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (path: string) => {
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${path} is not a PNG`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
};

test("the trading app installs to a home screen with Tick as its icon", () => {
  const manifest = JSON.parse(read("apps/web/public/manifest.webmanifest")) as {
    start_url: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons)
    assert.equal(pngSize(`apps/web/public${icon.src}`), icon.sizes, icon.src);
  // Chrome needs a 192 and a 512 to offer the install; Android crops a maskable one to its own shape.
  assert.deepEqual(
    manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`),
    ["192x192 any", "512x512 any", "512x512 maskable"],
  );
  const html = read("apps/web/index.html");
  assert.ok(html.includes('<link rel="manifest" href="/manifest.webmanifest" />'));
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />'));
  assert.equal(pngSize("apps/web/public/icons/apple-touch-icon.png"), "180x180");
  // The splash and title bar colors are the background tokens, written out because manifests cannot read CSS.
  assert.equal(manifest.background_color, COLORS.dark.bg);
  assert.equal(manifest.theme_color, COLORS.dark.bg);
  assert.ok(
    html.includes(
      `<meta name="theme-color" content="${COLORS.dark.bg}" media="(prefers-color-scheme: dark)" />`,
    ),
  );
  assert.ok(
    html.includes(
      `<meta name="theme-color" content="${COLORS.light.bg}" media="(prefers-color-scheme: light)" />`,
    ),
  );
});

test("a shared link to the trading app previews with its image", () => {
  const html = read("apps/web/index.html");
  // vite.config.ts swaps %RFQ_APP_URL% for the public address, since previews need absolute URLs.
  assert.ok(html.includes('<meta property="og:image" content="%RFQ_APP_URL%/og-image.png" />'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image" />'));
  assert.match(html, /<meta property="og:description" content="[^"]{60,200}" \/>/);
  assert.equal(pngSize("apps/web/public/og-image.png"), "1200x630");
});
