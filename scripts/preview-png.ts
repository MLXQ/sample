/**
 * Sandbox-friendly preview generator. Draws each scene type as a static
 * 1920x1080 PNG using @napi-rs/canvas (no browser, no chromium needed),
 * then stitches the PNGs into a short MP4 slideshow with ffmpeg.
 *
 * This is a visual mock of the real Remotion output — fonts and colors
 * match the components, but motion (Ken Burns, springs, subtitle reveal)
 * is not animated here.
 */
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OUT_DIR, ensureDir, ROOT } from "./lib/paths.js";
import { getPalette } from "../src/styles/theme.js";

const W = 1920;
const H = 1080;

const palette = getPalette("history");

function gradientBg(ctx: SKRSContext2D) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, palette.bgGradientFrom);
  g.addColorStop(1, palette.bgGradientTo);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Warm accent glow
  const r = ctx.createRadialGradient(W * 0.3, H * 0.2, 50, W * 0.3, H * 0.2, 900);
  r.addColorStop(0, palette.accentSoft);
  r.addColorStop(1, "transparent");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);

  // Edge vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.85);
  v.addColorStop(0, "transparent");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function placeholderImage(ctx: SKRSContext2D, label: string) {
  // Atmospheric placeholder for the Wikimedia photo slot.
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#3a2818");
  g.addColorStop(0.5, "#1a1410");
  g.addColorStop(1, "#0a0806");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Faux columns / silhouette
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  for (let i = 0; i < 6; i++) {
    const cx = 200 + i * 280;
    ctx.beginPath();
    ctx.moveTo(cx, H);
    ctx.lineTo(cx + 80, H);
    ctx.lineTo(cx + 70, 380);
    ctx.lineTo(cx + 10, 380);
    ctx.closePath();
    ctx.fill();
  }
  // Sun
  const sun = ctx.createRadialGradient(W * 0.7, H * 0.32, 20, W * 0.7, H * 0.32, 280);
  sun.addColorStop(0, "rgba(255,200,120,0.8)");
  sun.addColorStop(1, "transparent");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, W, H);

  // Vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.9);
  v.addColorStop(0, "transparent");
  v.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  // Watermark label so the user knows this slot would be a real photo
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.font = '500 22px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(`[ Wikimedia photo: ${label} ]`, W / 2, H - 40);
  ctx.textAlign = "start";
}

function drawSubtitleStrip(ctx: SKRSContext2D, text: string) {
  const padY = 18;
  const padX = 32;
  ctx.font = '500 34px "Inter", sans-serif';
  const maxWidth = 1500;
  const lines = wrapText(ctx, text, maxWidth - padX * 2);
  const lineHeight = 46;
  const stripH = padY * 2 + lineHeight * lines.length;
  const stripW = Math.min(maxWidth, ctx.measureText(text).width + padX * 2);

  const x = (W - stripW) / 2;
  const y = H - 60 - stripH;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, x, y, stripW, stripH, 8);
  ctx.fill();

  ctx.fillStyle = palette.text;
  ctx.textAlign = "center";
  lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, y + padY + 32 + i * lineHeight);
  });
  ctx.textAlign = "start";
}

function wrapText(ctx: SKRSContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > max && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- scene drawers ---

function drawTitle(ctx: SKRSContext2D, title: string, subtitle: string) {
  gradientBg(ctx);

  ctx.fillStyle = palette.text;
  ctx.font = '700 130px "Playfair Display", Georgia, serif';
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillText(title, W / 2, H / 2 - 30);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Accent underline
  ctx.fillStyle = palette.accent;
  ctx.fillRect(W / 2 - 160, H / 2 + 50, 320, 3);

  // Subtitle (uppercase tracked)
  ctx.fillStyle = palette.textMuted;
  ctx.font = '300 36px "Inter", sans-serif';
  ctx.textAlign = "center";
  const tracked = subtitle.toUpperCase().split("").join(" ");
  ctx.fillText(tracked, W / 2, H / 2 + 130);
  ctx.textAlign = "start";
}

function drawNarration(
  ctx: SKRSContext2D,
  imageLabel: string,
  caption: string,
  date: string,
  narration: string,
) {
  placeholderImage(ctx, imageLabel);

  // Date badge
  ctx.font = '600 28px "Inter", sans-serif';
  const dateLabel = date.toUpperCase();
  const dateW = ctx.measureText(dateLabel).width + 36;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, 80, H - 280, dateW, 56, 0);
  ctx.fill();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(80, H - 280, dateW, 56);
  ctx.fillStyle = palette.accent;
  ctx.fillText(dateLabel, 98, H - 245);

  // Caption (serif)
  ctx.fillStyle = palette.text;
  ctx.font = '600 56px "Playfair Display", Georgia, serif';
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 2;
  ctx.fillText(caption, 80, H - 160);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  drawSubtitleStrip(ctx, narration);
}

function drawTimeline(
  ctx: SKRSContext2D,
  heading: string,
  events: { year: string; text: string }[],
  narration: string,
) {
  gradientBg(ctx);

  ctx.fillStyle = palette.text;
  ctx.font = '700 78px "Playfair Display", Georgia, serif';
  ctx.fillText(heading, 160, 200);

  // Vertical line
  const lineX = 178;
  const lineTop = 260;
  const lineBottom = H - 220;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(lineX, lineTop, 3, lineBottom - lineTop);

  const gap = (lineBottom - lineTop) / events.length;
  events.forEach((ev, i) => {
    const cy = lineTop + gap * i + 30;

    // Glow halo
    ctx.fillStyle = palette.accentSoft;
    ctx.beginPath();
    ctx.arc(lineX + 1, cy, 22, 0, Math.PI * 2);
    ctx.fill();
    // Dot
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.arc(lineX + 1, cy, 12, 0, Math.PI * 2);
    ctx.fill();

    // Year
    ctx.fillStyle = palette.accent;
    ctx.font = '700 30px "Inter", sans-serif';
    ctx.fillText(ev.year.toUpperCase(), lineX + 70, cy - 6);
    // Text
    ctx.fillStyle = palette.text;
    ctx.font = '500 44px "Playfair Display", Georgia, serif';
    ctx.fillText(ev.text, lineX + 70, cy + 42);
  });

  drawSubtitleStrip(ctx, narration);
}

function drawFact(
  ctx: SKRSContext2D,
  fact: string,
  source: string,
  narration: string,
) {
  gradientBg(ctx);

  // Card
  const cardW = 1500;
  const cardH = 600;
  const cardX = (W - cardW) / 2;
  const cardY = (H - cardH) / 2 - 60;
  ctx.fillStyle = palette.surface;
  roundRect(ctx, cardX, cardY, cardW, cardH, 24);
  ctx.fill();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1;
  ctx.stroke();

  // "Did you know?" tag
  ctx.fillStyle = palette.accent;
  ctx.font = '700 28px "Inter", sans-serif';
  ctx.fillText("D I D   Y O U   K N O W ?", cardX + 90, cardY + 90);

  // Fact (wrap)
  ctx.fillStyle = palette.text;
  ctx.font = '600 64px "Playfair Display", Georgia, serif';
  const lines = wrapText(ctx, fact, cardW - 180);
  lines.forEach((l, i) => ctx.fillText(l, cardX + 90, cardY + 200 + i * 76));

  // Source
  ctx.fillStyle = palette.textMuted;
  ctx.font = 'italic 24px "Inter", sans-serif';
  ctx.fillText(`Source: ${source}`, cardX + 90, cardY + cardH - 60);

  drawSubtitleStrip(ctx, narration);
}

function drawOutro(ctx: SKRSContext2D, cta: string) {
  gradientBg(ctx);

  ctx.fillStyle = palette.text;
  ctx.font = '700 96px "Playfair Display", Georgia, serif';
  ctx.textAlign = "center";
  ctx.fillText(cta, W / 2, H / 2 - 60);

  // Subscribe button
  const btnText = "SUBSCRIBE";
  ctx.font = '600 36px "Inter", sans-serif';
  const btnW = ctx.measureText(btnText).width + 120;
  const btnH = 96;
  const bx = (W - btnW) / 2;
  const by = H / 2 + 60;

  ctx.shadowColor = palette.accent;
  ctx.shadowBlur = 60;
  ctx.fillStyle = palette.accent;
  roundRect(ctx, bx, by, btnW, btnH, btnH / 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#0b0b0b";
  ctx.fillText(btnText.split("").join(" "), W / 2, by + 60);
  ctx.textAlign = "start";
}

async function savePng(filename: string, draw: (ctx: SKRSContext2D) => void) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
  draw(ctx);
  const buf = await canvas.encode("png");
  await fs.writeFile(filename, buf);
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)),
    );
  });
}

async function main() {
  const dir = path.join(OUT_DIR, "preview");
  await ensureDir(dir);

  // Try to register the bundled fonts if available - falls back to system serif/sans.
  const interFonts = await tryFonts(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]);
  for (const f of interFonts) GlobalFonts.registerFromPath(f, "Inter");
  const playfair = await tryFonts([
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
  ]);
  for (const f of playfair) GlobalFonts.registerFromPath(f, "Playfair Display");

  const scenes: { name: string; duration: number; draw: (ctx: SKRSContext2D) => void }[] = [
    {
      name: "01-title",
      duration: 4,
      draw: (ctx) => drawTitle(ctx, "The Fall of Constantinople", "May 29, 1453"),
    },
    {
      name: "02-narration",
      duration: 4,
      draw: (ctx) =>
        drawNarration(
          ctx,
          "Theodosian Walls",
          "The Theodosian Walls",
          "413 AD",
          "For more than a thousand years, the triple walls of Constantinople had repelled every army that dared approach them.",
        ),
    },
    {
      name: "03-timeline",
      duration: 5,
      draw: (ctx) =>
        drawTimeline(
          ctx,
          "The Fifty-Three Day Siege",
          [
            { year: "April 6", text: "Ottoman army surrounds the land walls." },
            { year: "April 22", text: "Ships hauled overland to bypass the chain." },
            { year: "May 7", text: "First major assault is repelled." },
            { year: "May 29", text: "The walls are breached; the city falls." },
          ],
          "The siege lasted fifty-three days, with cannons pounding the walls by day and Byzantine defenders rebuilding them by night.",
        ),
    },
    {
      name: "04-fact",
      duration: 4,
      draw: (ctx) =>
        drawFact(
          ctx,
          "Mehmed's super-cannon weighed 19 tons and could hurl a 600-pound stone over a mile.",
          "Roger Crowley, 1453",
          "The largest of Mehmed's cannons weighed nineteen tons and could fire a six-hundred-pound stone over a mile through the air.",
        ),
    },
    {
      name: "05-outro",
      duration: 3,
      draw: (ctx) => drawOutro(ctx, "Subscribe for more forgotten history."),
    },
  ];

  console.log("-> Drawing scene mockups");
  const concatLines: string[] = [];
  for (const s of scenes) {
    const png = path.join(dir, `${s.name}.png`);
    await savePng(png, s.draw);
    concatLines.push(`file '${png}'`);
    concatLines.push(`duration ${s.duration}`);
    console.log(`   wrote ${path.relative(ROOT, png)}`);
  }
  // ffmpeg concat demuxer requires last file repeated without duration
  concatLines.push(`file '${path.join(dir, scenes[scenes.length - 1].name)}.png'`);
  const concatFile = path.join(dir, "concat.txt");
  await fs.writeFile(concatFile, concatLines.join("\n"));

  const mp4 = path.join(OUT_DIR, "preview.mp4");
  console.log("-> Stitching to MP4 with ffmpeg");
  await ffmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-fps_mode",
    "vfr",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "20",
    mp4,
  ]);

  console.log(`\nDone -> ${path.relative(ROOT, mp4)}`);
}

async function tryFonts(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const c of candidates) {
    try {
      await fs.access(c);
      found.push(c);
    } catch {
      // skip
    }
  }
  return found;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
