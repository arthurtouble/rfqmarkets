// The share card: a 1080 × 1350 image of a bet (market, Up or Down, the
// result, the tick line) that players post to X, Telegram, TikTok or
// Instagram. It never shows the wallet address or the balance.
import { useEffect, useState } from "react";
import type { ChartPoint } from "../lib/candles.js";
import {
  betLabel,
  placeLine,
  shareCaption,
  shareFileName,
  shareHeadline,
  shareMood,
  sharePrices,
  shareSubline,
  type ShareBet,
} from "../lib/share.js";
import { Sheet } from "../ui/primitives.js";
import { COLORS as TOKENS } from "../../../../packages/design-system/colors.js";
import { drawMascot } from "../../../../packages/design-system/mascot.js";

export const CARD_WIDTH = 1080,
  CARD_HEIGHT = 1350;
// The dark theme's colors. The card is always dark so it looks the same wherever it is posted.
const DARK = TOKENS.dark;
const COLORS = {
  bg: DARK.bg,
  line: DARK.line,
  text: DARK.text,
  secondary: DARK["text-secondary"],
  tertiary: DARK["text-tertiary"],
  brand: DARK.brand,
  up: DARK["long-text"],
  down: DARK["short-text"],
};
const FONT = '"Geist Variable", Geist, -apple-system, "Segoe UI", system-ui, sans-serif';
const font = (weight: number, size: number) => `${weight} ${size}px ${FONT}`;

/** The link posted with the card: this app's Up / Down screen for the market. */
export const shareUrl = (bet: Pick<ShareBet, "market">) =>
  `${window.location.origin}/updown/${encodeURIComponent(bet.market)}`;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  // Safari before 16 has no roundRect; trace the same shape with arcs there.
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** A rounded label ("Up 3×", "Cashed out") with its left edge at `x`, or its right edge when `alignRight`. */
function pill(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size: number,
  alignRight = false,
) {
  ctx.font = font(650, size);
  const padX = size * 0.6,
    h = size * 1.7,
    w = ctx.measureText(text).width + padX * 2;
  const left = alignRight ? x - w : x;
  roundRect(ctx, left, y, w, h, h / 2);
  ctx.fillStyle = `${color}26`;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + padX, y + h / 2 + 1);
}

/** The brand: Tick, then the name. */
function brand(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const s = 72;
  drawMascot(ctx, "idle", x, y - 4, s);
  ctx.fillStyle = COLORS.text;
  ctx.font = font(700, 40);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText("RFQ Markets", x + s + 18, y + s / 2 - 3);
}

/** Draws the card for `bet` onto `canvas` (resized to the card). */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  bet: ShareBet,
  points: readonly ChartPoint[],
  host: string,
) {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const pad = 80,
    W = CARD_WIDTH,
    H = CARD_HEIGHT;
  const tone = bet.pnl > 0n ? COLORS.up : bet.pnl < 0n ? COLORS.down : COLORS.secondary;
  const side = bet.long ? COLORS.up : COLORS.down;

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 560, 40, W / 2, 560, 760);
  glow.addColorStop(0, `${tone}33`);
  glow.addColorStop(1, `${tone}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  brand(ctx, pad, pad);
  pill(
    ctx,
    bet.closed ? "Cashed out" : "Live",
    W - pad,
    pad + 6,
    bet.closed ? COLORS.secondary : COLORS.brand,
    28,
    true,
  );

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = COLORS.text;
  ctx.font = font(600, 60);
  ctx.fillText(bet.name, W / 2, 300);
  ctx.font = font(650, 36);
  const label = betLabel(bet);
  const labelWidth = ctx.measureText(label).width + 36 * 1.2;
  pill(ctx, label, W / 2 - labelWidth / 2, 336, side, 36);

  // The headline shrinks to fit when the number is long (a four-digit return, a large dollar result).
  const headline = shareHeadline(bet);
  let size = 220;
  ctx.font = font(700, size);
  while (ctx.measureText(headline).width > W - pad * 2 && size > 80) ctx.font = font(700, (size -= 8));
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = tone;
  ctx.fillText(headline, W / 2, 620);
  const subline = shareSubline(bet);
  if (subline) {
    ctx.font = font(600, 64);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(subline, W / 2, 712);
  }

  // The tick line with the entry price as a dashed guide.
  const top = 790,
    height = 300,
    entry = Number(bet.entryPrice) / 1e6;
  if (points.length >= 2) {
    const { xy, y } = placeLine(points, W - pad * 2, height, [entry]);
    const at = ([px, py]: [number, number]) => [pad + px, top + py] as const;
    const fill = ctx.createLinearGradient(0, top, 0, top + height);
    fill.addColorStop(0, `${tone}40`);
    fill.addColorStop(1, `${tone}00`);
    ctx.beginPath();
    xy.forEach((point, index) => (index ? ctx.lineTo(...at(point)) : ctx.moveTo(...at(point))));
    ctx.lineTo(pad + xy.at(-1)![0], top + height);
    ctx.lineTo(pad + xy[0][0], top + height);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    xy.forEach((point, index) => (index ? ctx.lineTo(...at(point)) : ctx.moveTo(...at(point))));
    ctx.strokeStyle = tone;
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    const end = at(xy.at(-1)!);
    ctx.beginPath();
    ctx.arc(end[0], end[1], 12, 0, Math.PI * 2);
    ctx.fillStyle = tone;
    ctx.fill();

    const entryY = top + y(entry);
    ctx.setLineDash([14, 12]);
    ctx.strokeStyle = COLORS.tertiary;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pad, entryY);
    ctx.lineTo(W - pad, entryY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = font(600, 26);
    ctx.fillStyle = COLORS.tertiary;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("Entry", pad, entryY - 8);
  }

  ctx.fillStyle = COLORS.line;
  ctx.fillRect(pad, H - 190, W - pad * 2, 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = font(500, 34);
  ctx.fillStyle = COLORS.secondary;
  ctx.fillText(sharePrices(bet), pad, H - 120);
  ctx.font = font(600, 34);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(host, pad, H - 70);
  // Tick reacts to the result in the corner.
  drawMascot(ctx, shareMood(bet), W - pad - 150, H - 172, 150);
}

/** Renders the card to a PNG once the app font is ready. */
async function cardImage(bet: ShareBet, points: readonly ChartPoint[]): Promise<Blob | null> {
  try {
    await Promise.all([700, 650, 600, 500].map((weight) => document.fonts.load(font(weight, 40))));
  } catch {
    /* fall back to the system font */
  }
  const canvas = document.createElement("canvas");
  drawShareCard(canvas, bet, points, window.location.host);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

type Image = { blob: Blob; url: string; file: File };

/** A sheet with the card, and buttons to share it, save it or copy its text. */
export function ShareSheet({
  bet,
  points,
  onClose,
}: {
  bet: ShareBet;
  points: readonly ChartPoint[];
  onClose: () => void;
}) {
  const [image, setImage] = useState<Image | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const caption = shareCaption(bet);
  const url = shareUrl(bet);

  // Drawn once when the sheet opens, so an open bet's card is a snapshot, not a moving target.
  useEffect(() => {
    let live = true,
      made: Image | null = null;
    cardImage(bet, points)
      .then((blob) => {
        if (!live) return;
        if (!blob) return setFailed(true);
        made = {
          blob,
          url: URL.createObjectURL(blob),
          file: new File([blob], shareFileName(bet), { type: "image/png" }),
        };
        setImage(made);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made.url);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const canShareFile =
    !!image && typeof navigator.canShare === "function" && navigator.canShare({ files: [image.file] });
  const share = async () => {
    if (!image) return;
    try {
      await navigator.share({ files: [image.file], text: `${caption} ${url}` });
    } catch (error) {
      // Closing the share sheet is not an error worth showing.
      if ((error as Error)?.name !== "AbortError")
        setNote("Sharing didn't work here. Save the image instead.");
    }
  };
  const save = () => {
    if (!image) return;
    const link = document.createElement("a");
    link.href = image.url;
    link.download = image.file.name;
    link.click();
    setNote("Image saved");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${caption} ${url}`);
      setNote("Text copied");
    } catch {
      setNote("Couldn't copy here");
    }
  };

  return (
    <Sheet open onClose={onClose} title="Share your trade" labelledBy="share-title">
      <div className="sheet-body share-sheet">
        {image ? (
          <img className="share-sheet__card" src={image.url} alt={`Share card: ${caption}`} />
        ) : (
          <div className="share-sheet__card share-sheet__card--loading" role="status">
            {failed ? (
              "Couldn't draw the card"
            ) : (
              <span className="rfq-spinner" aria-label="Drawing the card" />
            )}
          </div>
        )}
        <p className="footnote rfq-muted center">{caption}</p>
        <div className="share-sheet__actions">
          {canShareFile && (
            <button
              type="button"
              className="rfq-btn rfq-btn--lg rfq-btn--primary rfq-btn--block"
              onClick={() => void share()}
            >
              Share
            </button>
          )}
          <button
            type="button"
            className={`rfq-btn rfq-btn--lg rfq-btn--block ${canShareFile ? "rfq-btn--secondary" : "rfq-btn--primary"}`}
            disabled={!image}
            onClick={save}
          >
            Save image
          </button>
          <button
            type="button"
            className="rfq-btn rfq-btn--lg rfq-btn--block rfq-btn--ghost"
            onClick={() => void copy()}
          >
            Copy text and link
          </button>
        </div>
        {note && (
          <p className="footnote rfq-faint center" role="status">
            {note}
          </p>
        )}
      </div>
    </Sheet>
  );
}
