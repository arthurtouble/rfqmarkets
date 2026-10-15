// Tick, the RFQ Markets mascot. The drawing lives in mascot.json; this file turns it into SVG markup
// and canvas paths. Tick is always drawn in the dark theme's colors so it looks the same on every surface.
import mascot from "./mascot.json" with { type: "json" };
import { COLORS } from "./colors.js";

export type MascotMood = "idle" | "win" | "loss";
export const MASCOT_MOODS = ["idle", "win", "loss"] as const satisfies readonly MascotMood[];
export const MASCOT_NAME = mascot.name;

type Role = keyof typeof mascot.colors;
/** A shape: its path, and either a fill or a stroke and its width. In mascot.json the colors are roles. */
export type MascotShape = { d: string; fill?: string; stroke?: string; width?: number };

const SIZE = mascot.viewBox;
export const MASCOT_VIEWBOX = `0 0 ${SIZE} ${SIZE}`;
const color = (role: string) => COLORS.dark[mascot.colors[role as Role] as keyof typeof COLORS.dark];

/** Tick's shapes for `mood`, back to front, with colors resolved. */
export function mascotShapes(mood: MascotMood): MascotShape[] {
  return [...mascot.shared, ...mascot.moods[mood]].map((shape: MascotShape) =>
    shape.fill
      ? { d: shape.d, fill: color(shape.fill) }
      : { d: shape.d, stroke: color(shape.stroke!), width: shape.width },
  );
}

/** Tick as a standalone SVG document, for favicons, image tags and downloads. */
export function mascotSvg(mood: MascotMood = "idle"): string {
  const paths = mascotShapes(mood).map((shape) =>
    shape.fill
      ? `<path d="${shape.d}" fill="${shape.fill}"/>`
      : `<path d="${shape.d}" fill="none" stroke="${shape.stroke}" stroke-width="${shape.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MASCOT_VIEWBOX}">${paths.join("")}</svg>`;
}

/** Draws Tick onto a canvas with its top-left corner at (x, y), `size` pixels square. */
export function drawMascot(
  ctx: CanvasRenderingContext2D,
  mood: MascotMood,
  x: number,
  y: number,
  size: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / SIZE, size / SIZE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const shape of mascotShapes(mood)) {
    const path = new Path2D(shape.d);
    if (shape.fill) {
      ctx.fillStyle = shape.fill;
      ctx.fill(path);
    } else {
      ctx.strokeStyle = shape.stroke!;
      ctx.lineWidth = shape.width!;
      ctx.stroke(path);
    }
  }
  ctx.restore();
}
