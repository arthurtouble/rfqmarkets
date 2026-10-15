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
