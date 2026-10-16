// Draws the trading app's home-screen icons and its link-preview image from Tick (the mascot) and the
// brand tokens, into apps/web/public. Run it after changing the mascot or the colors:
//   npx tsx scripts/app-icons.ts
// It uses Playwright's Chromium (set PLAYWRIGHT_CHROMIUM_EXECUTABLE in cloud sessions). brand.test.ts
// checks the files exist at the sizes the manifest and index.html name.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { COLORS } from "../packages/design-system/colors.js";
import { mascotSvg } from "../packages/design-system/mascot.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "apps/web/public");
const font = pathToFileURL(
  join(root, "node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"),
).href;
const dark = COLORS.dark;
const tick = mascotSvg("idle");

/** A square icon: Tick centred on the dark background, taking `scale` of the width. */
const icon = (scale: number) => `
  <body style="margin:0;width:100vw;height:100vh;display:grid;place-items:center;background:${dark.bg}">
    <div style="width:${scale * 100}vw;height:${scale * 100}vw">${tick.replace("<svg ", '<svg width="100%" height="100%" ')}</div>
  </body>`;

// 1200×630 is the size X, Telegram, Discord, Facebook and LinkedIn all crop to without losing anything.
const preview = `
  <style>
    @font-face { font-family: Geist; src: url("${font}") format("woff2"); font-weight: 100 900; }
    body { margin: 0; width: 1200px; height: 630px; background: ${dark.bg}; color: ${dark.text};
      font-family: Geist, sans-serif; display: grid; grid-template-columns: 360px 1fr; align-items: center;
      gap: 56px; padding: 0 96px; box-sizing: border-box; }
    h1 { margin: 0 0 20px; font-size: 76px; line-height: 1; font-weight: 700; letter-spacing: -0.02em; }
    p { margin: 0; font-size: 40px; line-height: 1.25; font-weight: 500; color: ${dark.text}; }
    .up { color: ${dark.long}; } .down { color: ${dark.short}; }
    small { display: block; margin-top: 28px; font-size: 28px; color: ${dark["text-secondary"]}; }
  </style>
  <body>
    <div style="width:360px;height:360px">${tick.replace("<svg ", '<svg width="100%" height="100%" ')}</div>
    <div>
      <h1>RFQ Markets</h1>
      <p>Pick <span class="up">Up</span> or <span class="down">Down</span> on BTC, ETH and more.</p>
      <small>Perpetual futures on Base. No trading fees.</small>
    </div>
  </body>`;

const shots: Array<{ file: string; size: [number, number]; html: string }> = [
  { file: "icons/icon-192.png", size: [192, 192], html: icon(0.78) },
  { file: "icons/icon-512.png", size: [512, 512], html: icon(0.78) },
  // Maskable icons get cropped to a circle or squircle: keep Tick inside the central 80% safe zone.
  { file: "icons/icon-maskable-512.png", size: [512, 512], html: icon(0.6) },
  { file: "icons/apple-touch-icon.png", size: [180, 180], html: icon(0.74) },
  { file: "og-image.png", size: [1200, 630], html: preview },
];

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const scratch = await mkdtemp(join(tmpdir(), "rfq-icons-"));
try {
  await mkdir(join(out, "icons"), { recursive: true });
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.size[0], height: shot.size[1] } });
    // A file:// page, so the preview can load Geist from node_modules.
    const html = join(scratch, "page.html");
    await writeFile(html, `<!doctype html><meta charset="utf-8">${shot.html}`);
    await page.goto(pathToFileURL(html).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, shot.file), omitBackground: false });
    await page.close();
    console.log(`wrote apps/web/public/${shot.file}`);
  }
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
