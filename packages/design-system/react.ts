// React versions of the brand drawings, shared by every app.
import { createElement as h } from "react";
import { MASCOT_VIEWBOX, mascotShapes, type MascotMood } from "./mascot.js";

/** Tick as an inline SVG. Decorative unless given a `label`. */
export function Mascot({
  mood = "idle",
  size = 24,
  label,
  className,
}: {
  mood?: MascotMood;
  size?: number;
  label?: string;
  className?: string;
}) {
  return h(
    "svg",
    {
      className,
      width: size,
      height: size,
      viewBox: MASCOT_VIEWBOX,
      role: label ? "img" : undefined,
      "aria-label": label,
      "aria-hidden": label ? undefined : true,
      focusable: "false",
    },
    mascotShapes(mood).map((shape, index) =>
      shape.fill
        ? h("path", { key: index, d: shape.d, fill: shape.fill })
        : h("path", {
            key: index,
            d: shape.d,
            fill: "none",
            stroke: shape.stroke,
            strokeWidth: shape.width,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }),
    ),
  );
}
