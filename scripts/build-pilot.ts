/**
 * Pilot episode renderer: "The 12 Layers of the AI Boom".
 *
 * Adds four animated infographic scene types tailored to investment
 * / industry-analysis content:
 *   - countUpStat   : a single big number that ticks 0 -> N
 *   - stackDiagram  : a vertical layer stack revealed top-to-bottom
 *   - animatedChart : bars that grow from 0 to their target value
 *   - logoGrid      : a grid of company labels that fade in with stagger
 *
 * Each scene is rendered as a sequence of PNG frames via @napi-rs/canvas
 * and encoded into an mp4 by ffmpeg's image2 demuxer. Per-scene mp4s are
 * crossfaded together and BGM is mixed under.
 *
 * Reads data/sample-pilot.json. Output: out/pilot.mp4 (silent backbone +
 * dramatic BGM). Use scripts/mix-narration.ts afterwards to add voice.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir, PUBLIC_DIR, DATA_DIR } from "./lib/paths.js";
import { getPalette, Palette } from "../src/styles/theme.js";
import type { Script, Scene } from "../src/types.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const XFADE_SECONDS = 0.5;
const BGM_DIR = path.join(PUBLIC_DIR, "audio", "bgm");
const CLIPS_DIR = path.join(OUT_DIR, "pilot-clips");
const FRAMES_DIR = path.join(OUT_DIR, "pilot-frames");

// ---- ffmpeg helpers ----

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg ${code}\n${err.slice(-1500)}`)),
    );
  });
}

// ---- shared canvas primitives ----

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

function gradientBg(ctx: SKRSContext2D, p: Palette) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.bgGradientFrom);
  g.addColorStop(1, p.bgGradientTo);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const r = ctx.createRadialGradient(W * 0.65, H * 0.25, 80, W * 0.65, H * 0.25, 1100);
  r.addColorStop(0, p.accentSoft);
  r.addColorStop(1, "transparent");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);
  // subtle dark vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, "transparent");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
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

function formatBigNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  return Math.round(n).toLocaleString("en-US");
}

// ---- scene drawers (per-frame) ----

type DrawCtx = {
  ctx: SKRSContext2D;
  p: Palette;
  /** 0..1 progress through the scene. */
  progress: number;
  /** Scene local time in seconds. */
  t: number;
  /** Total scene duration in seconds. */
  dur: number;
};

function drawTitleScene(d: DrawCtx, scene: Extract<Scene, { type: "title" }>) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  // Eyebrow
  const eyebrowOp = Math.min(1, d.t / 0.6);
  ctx.globalAlpha = eyebrowOp;
  ctx.fillStyle = p.accent;
  ctx.font = '800 36px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;
  // eyebrow text comes from title field
  const titleData = scene as unknown as {
    title: { eyebrow: string; line1: string; line2: string };
  };
  ctx.fillText(
    titleData.title.eyebrow.toUpperCase().split("").join(" "),
    W / 2,
    H / 2 - 180,
  );
  ctx.globalAlpha = 1;

  // Title lines: each animates with stagger
  const drawLine = (text: string, y: number, delay: number) => {
    const localT = Math.max(0, d.t - delay);
    const op = Math.min(1, localT / 0.5);
    const ty = (1 - easeOutCubic(Math.min(1, localT / 0.6))) * 30;
    ctx.globalAlpha = op;
    ctx.fillStyle = p.text;
    ctx.font = '900 130px "Inter", sans-serif';
    ctx.fillText(text, W / 2, y + ty);
    ctx.globalAlpha = 1;
  };
  drawLine(titleData.title.line1, H / 2 - 20, 0.3);
  drawLine(titleData.title.line2, H / 2 + 130, 0.55);

  // Accent bar
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  const barProgress = Math.min(1, Math.max(0, (d.t - 1.0) / 0.5));
  const barW = 120 * barProgress;
  ctx.fillStyle = p.accent;
  ctx.fillRect(W / 2 - barW / 2, H / 2 + 200, barW, 6);
  ctx.textAlign = "start";
}

function drawCountUpScene(
  d: DrawCtx,
  scene: Extract<Scene, { type: "countUpStat" }>,
) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  // Animation: 0 -> value over first 1.5s, then static.
  const ANIM = 1.5;
  const t01 = Math.min(1, d.t / ANIM);
  const eased = easeOutCubic(t01);
  const current = scene.value * eased;

  // Label (small, above)
  if (scene.label) {
    const op = Math.min(1, d.t / 0.4);
    ctx.globalAlpha = op;
    ctx.fillStyle = p.accent;
    ctx.font = '800 32px "Inter", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(
      scene.label.toUpperCase().split("").join(" "),
      W / 2,
      H / 2 - 200,
    );
    ctx.globalAlpha = 1;
  }

  // Big number
  const numText =
    (scene.prefix ?? "") + formatBigNumber(current) + (scene.suffix ?? "");
  ctx.fillStyle = p.text;
  ctx.font = '900 280px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 8;

  // Subtle scale punch at the end of the count
  const scale = t01 < 1 ? 1 : 1 + 0.03 * Math.max(0, 1 - (d.t - ANIM) / 0.3);
  ctx.save();
  ctx.translate(W / 2, H / 2 + 30);
  ctx.scale(scale, scale);
  ctx.fillText(numText, 0, 0);
  ctx.restore();

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Caption (italic, below)
  if (scene.caption) {
    const op = Math.min(1, Math.max(0, (d.t - ANIM) / 0.3));
    ctx.globalAlpha = op;
    ctx.fillStyle = p.textMuted;
    ctx.font = 'italic 32px "Inter", sans-serif';
    ctx.fillText(scene.caption, W / 2, H / 2 + 200);
    ctx.globalAlpha = 1;
  }

  ctx.textAlign = "start";
}

function drawStackScene(
  d: DrawCtx,
  scene: Extract<Scene, { type: "stackDiagram" }>,
) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  // Heading top-left
  ctx.fillStyle = p.text;
  ctx.font = '900 64px "Inter", sans-serif';
  ctx.fillText(scene.heading, 80, 110);

  // Layers stack on the right ~60% of the screen
  const stackX = 760;
  const stackY = 60;
  const stackW = 1080;
  const stackH = H - 120;
  const layerH = stackH / scene.layers.length;
  const gap = 6;

  // Reveal: stagger 0.12s per layer; total reveal ~scene.layers.length*0.12s
  const stagger = 0.12;

  scene.layers.forEach((layer, i) => {
    const startT = 0.4 + i * stagger;
    const localT = Math.max(0, d.t - startT);
    const op = Math.min(1, localT / 0.35);
    const tx = (1 - easeOutCubic(Math.min(1, localT / 0.45))) * 60;
    if (op <= 0) return;

    ctx.globalAlpha = op;
    const y = stackY + i * layerH;
    // Layer panel
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, stackX + tx, y, stackW, layerH - gap, 8);
    ctx.fill();
    // Left-edge accent bar
    ctx.fillStyle = p.accent;
    ctx.fillRect(stackX + tx, y, 6, layerH - gap);
    // Layer number
    ctx.fillStyle = p.textMuted;
    ctx.font = '700 22px "Inter", sans-serif';
    ctx.fillText(String(i + 1).padStart(2, "0"), stackX + tx + 30, y + (layerH - gap) / 2 + 8);
    // Label
    ctx.fillStyle = p.text;
    ctx.font = '800 32px "Inter", sans-serif';
    ctx.fillText(layer.label, stackX + tx + 100, y + (layerH - gap) / 2 - 4);
    // Note
    if (layer.note) {
      ctx.fillStyle = p.textMuted;
      ctx.font = '500 22px "Inter", sans-serif';
      ctx.fillText(layer.note, stackX + tx + 100, y + (layerH - gap) / 2 + 28);
    }
  });
  ctx.globalAlpha = 1;

  // Side caption
  ctx.fillStyle = p.textMuted;
  ctx.font = '500 26px "Inter", sans-serif';
  const sideLines = [
    `${scene.layers.length} layers`,
    "from raw materials",
    "to consumer apps",
  ];
  sideLines.forEach((l, i) => ctx.fillText(l, 80, 220 + i * 36));
}

function drawChartScene(
  d: DrawCtx,
  scene: Extract<Scene, { type: "animatedChart" }>,
) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  // Heading
  ctx.fillStyle = p.text;
  ctx.font = '900 64px "Inter", sans-serif';
  ctx.fillText(scene.heading, 100, 120);

  if (scene.unit) {
    ctx.fillStyle = p.accent;
    ctx.font = '700 28px "Inter", sans-serif';
    ctx.fillText(scene.unit.toUpperCase().split("").join(" "), 100, 165);
  }

  // Plot area
  const plotX = 180;
  const plotY = 240;
  const plotW = W - 360;
  const plotH = 700;
  const baselineY = plotY + plotH;

  // Y-axis line + grid (subtle)
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = plotY + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
  }

  const maxValue = Math.max(...scene.bars.map((b) => b.value));
  // Round up to nice number
  const niceMax = Math.ceil(maxValue / 200) * 200;
  const barCount = scene.bars.length;
  const slotW = plotW / barCount;
  const barW = slotW * 0.55;

  scene.bars.forEach((bar, i) => {
    // Reveal stagger
    const startT = 0.4 + i * 0.18;
    const localT = Math.max(0, d.t - startT);
    const grow = Math.min(1, easeOutCubic(localT / 0.6));

    const targetH = (bar.value / niceMax) * plotH;
    const h = targetH * grow;
    const x = plotX + i * slotW + (slotW - barW) / 2;
    const y = baselineY - h;

    // Bar gradient
    const grad = ctx.createLinearGradient(0, y, 0, baselineY);
    grad.addColorStop(0, p.accent);
    grad.addColorStop(1, "rgba(76,194,255,0.25)");
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barW, h, 8);
    ctx.fill();

    // Value label on top of bar
    if (grow > 0.6) {
      const labelOp = Math.min(1, (grow - 0.6) / 0.3);
      ctx.globalAlpha = labelOp;
      ctx.fillStyle = p.text;
      ctx.font = '800 32px "Inter", sans-serif';
      ctx.textAlign = "center";
      const animVal = bar.value * grow;
      ctx.fillText(formatBigNumber(animVal), x + barW / 2, y - 18);
      ctx.globalAlpha = 1;
    }

    // X-axis label
    ctx.fillStyle = p.textMuted;
    ctx.font = '700 26px "Inter", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(bar.label, x + barW / 2, baselineY + 50);
  });
  ctx.textAlign = "start";

  // Baseline
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(plotX, baselineY);
  ctx.lineTo(plotX + plotW, baselineY);
  ctx.stroke();
}

function drawLogoGridScene(
  d: DrawCtx,
  scene: Extract<Scene, { type: "logoGrid" }>,
) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  // Heading
  ctx.fillStyle = p.accent;
  ctx.font = '900 32px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(
    scene.heading.toUpperCase().split("").join(" "),
    W / 2,
    180,
  );

  const n = scene.logos.length;
  const cols = n <= 4 ? n : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);

  const tileW = 420;
  const tileH = 200;
  const gapX = 40;
  const gapY = 40;
  const totalW = cols * tileW + (cols - 1) * gapX;
  const totalH = rows * tileH + (rows - 1) * gapY;
  const startX = (W - totalW) / 2;
  const startY = (H - totalH) / 2 + 80;

  scene.logos.forEach((label, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = startX + c * (tileW + gapX);
    const y = startY + r * (tileH + gapY);

    // Stagger reveal
    const startT = 0.3 + i * 0.12;
    const localT = Math.max(0, d.t - startT);
    const op = Math.min(1, localT / 0.4);
    const scale = easeOutBack(Math.min(1, localT / 0.6));
    if (op <= 0) return;

    ctx.save();
    ctx.translate(x + tileW / 2, y + tileH / 2);
    ctx.scale(0.85 + 0.15 * scale, 0.85 + 0.15 * scale);
    ctx.translate(-tileW / 2, -tileH / 2);
    ctx.globalAlpha = op;

    // Tile background
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, 0, 0, tileW, tileH, 14);
    ctx.fill();
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner accent corner
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, 0, 8, 8);

    // Label (auto-fit font size)
    ctx.fillStyle = p.text;
    let fontSize = 48;
    ctx.font = `900 ${fontSize}px "Inter", sans-serif`;
    while (ctx.measureText(label).width > tileW - 60 && fontSize > 28) {
      fontSize -= 2;
      ctx.font = `900 ${fontSize}px "Inter", sans-serif`;
    }
    ctx.textAlign = "center";
    ctx.fillText(label, tileW / 2, tileH / 2 + fontSize / 3);

    ctx.restore();
    ctx.globalAlpha = 1;
  });

  ctx.textAlign = "start";
}

function drawFactScene(d: DrawCtx, scene: Extract<Scene, { type: "fact" }>) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  const cardW = 1500;
  const cardH = 540;
  const cardX = (W - cardW) / 2;
  const cardY = (H - cardH) / 2;

  // Card scale-in
  const localT = Math.max(0, d.t - 0.1);
  const scale = 0.85 + 0.15 * easeOutBack(Math.min(1, localT / 0.6));
  const op = Math.min(1, localT / 0.3);

  ctx.save();
  ctx.translate(cardX + cardW / 2, cardY + cardH / 2);
  ctx.scale(scale, scale);
  ctx.translate(-cardW / 2, -cardH / 2);
  ctx.globalAlpha = op;

  ctx.fillStyle = p.surface;
  roundRect(ctx, 0, 0, cardW, cardH, 24);
  ctx.fill();
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = p.accent;
  ctx.font = '900 30px "Inter", sans-serif';
  ctx.fillText("D I D   Y O U   K N O W ?", 90, 100);

  ctx.fillStyle = p.text;
  ctx.font = '800 56px "Inter", sans-serif';
  const lines = wrapText(ctx, scene.fact, cardW - 180);
  lines.forEach((l, i) => ctx.fillText(l, 90, 200 + i * 72));

  if (scene.source) {
    const srcOp = Math.max(0, Math.min(1, (d.t - 0.8) / 0.4));
    ctx.globalAlpha = op * srcOp;
    ctx.fillStyle = p.textMuted;
    ctx.font = 'italic 22px "Inter", sans-serif';
    ctx.fillText(`Source: ${scene.source}`, 90, cardH - 50);
  }

  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawOutroScene(d: DrawCtx, scene: Extract<Scene, { type: "outro" }>) {
  const { ctx, p } = d;
  gradientBg(ctx, p);

  // CTA
  const ctaT = Math.max(0, d.t - 0.2);
  const ctaOp = Math.min(1, ctaT / 0.4);
  const ctaY = H / 2 - 50 + (1 - easeOutCubic(Math.min(1, ctaT / 0.5))) * 30;

  ctx.globalAlpha = ctaOp;
  ctx.fillStyle = p.text;
  ctx.font = '900 84px "Inter", sans-serif';
  ctx.textAlign = "center";
  const lines = wrapText(ctx, scene.cta, W - 240);
  lines.forEach((l, i) => ctx.fillText(l, W / 2, ctaY + i * 100));
  ctx.globalAlpha = 1;

  // Subscribe button with pulsing glow
  const btnT = Math.max(0, d.t - 0.7);
  const btnOp = Math.min(1, btnT / 0.4);
  const btnScale = 0.7 + 0.3 * easeOutBack(Math.min(1, btnT / 0.6));
  const pulse = 0.5 + 0.5 * Math.sin(d.t * 3);

  const btnText = "S U B S C R I B E";
  ctx.font = '800 36px "Inter", sans-serif';
  const btnW = ctx.measureText(btnText).width + 100;
  const btnH = 96;
  const bx = (W - btnW) / 2;
  const by = H / 2 + 130;

  ctx.save();
  ctx.translate(bx + btnW / 2, by + btnH / 2);
  ctx.scale(btnScale, btnScale);
  ctx.translate(-btnW / 2, -btnH / 2);
  ctx.globalAlpha = btnOp;

  ctx.shadowColor = p.accent;
  ctx.shadowBlur = 40 + pulse * 60;
  ctx.fillStyle = p.accent;
  roundRect(ctx, 0, 0, btnW, btnH, btnH / 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillText(btnText, btnW / 2, btnH / 2 + 12);

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.textAlign = "start";
}

// ---- per-scene render orchestration ----

async function renderSceneFrames(
  scene: Scene,
  palette: Palette,
  outDir: string,
): Promise<{ frameCount: number }> {
  await ensureDir(outDir);
  const dur = (scene as { durationSeconds?: number }).durationSeconds ?? 5;
  const frameCount = Math.round(dur * FPS);

  for (let f = 0; f < frameCount; f++) {
    const t = f / FPS;
    const progress = f / Math.max(1, frameCount - 1);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    const dctx: DrawCtx = { ctx, p: palette, t, progress, dur };

    switch (scene.type) {
      case "title":
        drawTitleScene(dctx, scene);
        break;
      case "countUpStat":
        drawCountUpScene(dctx, scene);
        break;
      case "stackDiagram":
        drawStackScene(dctx, scene);
        break;
      case "animatedChart":
        drawChartScene(dctx, scene);
        break;
      case "logoGrid":
        drawLogoGridScene(dctx, scene);
        break;
      case "fact":
        drawFactScene(dctx, scene);
        break;
      case "outro":
        drawOutroScene(dctx, scene);
        break;
      default:
        // Other scene types (broll, narration, timeline) — left to existing
        // pipelines. Render a simple placeholder.
        gradientBg(ctx, palette);
    }

    const file = path.join(outDir, `${String(f).padStart(4, "0")}.png`);
    await fs.writeFile(file, await canvas.encode("png"));
  }

  return { frameCount };
}

async function encodeSceneClip(
  framesDir: string,
  outFile: string,
): Promise<void> {
  await ffmpeg([
    "-y",
    "-framerate",
    String(FPS),
    "-i",
    path.join(framesDir, "%04d.png"),
    "-c:v",
    "libx264",
    "-crf",
    "16",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    outFile,
  ]);
}

async function concatWithXfade(inputs: string[], outFile: string): Promise<void> {
  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], outFile);
    return;
  }
  // Probe each clip's duration so we can offset xfades correctly.
  const durs: number[] = [];
  for (const f of inputs) {
    const probe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      f,
    ]);
    let out = "";
    probe.stdout.on("data", (d) => (out += d.toString()));
    await new Promise<void>((resolve, reject) => {
      probe.on("error", reject);
      probe.on("close", (c) =>
        c === 0 ? resolve() : reject(new Error(`probe ${c}`)),
      );
    });
    durs.push(parseFloat(out.trim()));
  }

  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);

  const filters: string[] = [];
  let prev = "[0:v]";
  let cumul = durs[0] - XFADE_SECONDS;
  for (let i = 1; i < inputs.length; i++) {
    const out = i === inputs.length - 1 ? "[vout]" : `[v${i}]`;
    filters.push(
      `${prev}[${i}:v]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${cumul.toFixed(3)}${out}`,
    );
    prev = out;
    cumul += durs[i] - XFADE_SECONDS;
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    outFile,
  );

  await ffmpeg(args);
}

async function mixBgm(
  silentVideo: string,
  outFile: string,
  bgmFile: string,
  durationSeconds: number,
): Promise<void> {
  await ffmpeg([
    "-y",
    "-i",
    silentVideo,
    "-i",
    bgmFile,
    "-filter_complex",
    `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${durationSeconds.toFixed(2)},volume=0.32,afade=t=in:st=0:d=1.5,afade=t=out:st=${(durationSeconds - 2).toFixed(2)}:d=2[bgm]`,
    "-map",
    "0:v",
    "-map",
    "[bgm]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outFile,
  ]);
}

// ---- main ----

async function main() {
  await ensureDir(CLIPS_DIR);
  await ensureDir(FRAMES_DIR);

  // Register a usable bold font for "Inter".
  for (const f of [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ]) {
    try {
      await fs.access(f);
      GlobalFonts.registerFromPath(f, "Inter");
      break;
    } catch {
      // try next
    }
  }

  const scriptPath = path.join(DATA_DIR, "sample-pilot.json");
  const raw = await fs.readFile(scriptPath, "utf-8");
  const script = JSON.parse(raw) as Script;
  const palette = getPalette(script.theme ?? "science");

  console.log(`-> Rendering ${script.scenes.length} scenes`);
  const clips: string[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const sceneFrames = path.join(FRAMES_DIR, String(i).padStart(2, "0"));
    const sceneClip = path.join(CLIPS_DIR, `${String(i).padStart(2, "0")}.mp4`);

    const start = Date.now();
    const { frameCount } = await renderSceneFrames(scene, palette, sceneFrames);
    await encodeSceneClip(sceneFrames, sceneClip);
    const ms = Date.now() - start;
    clips.push(sceneClip);
    console.log(
      `   [${i + 1}/${script.scenes.length}] ${scene.type.padEnd(15)} ${frameCount} frames (${ms}ms)`,
    );
  }

  console.log("-> Concatenating with xfade");
  const silent = path.join(OUT_DIR, "pilot-silent.mp4");
  await concatWithXfade(clips, silent);

  // BGM: dramatic for AI / industry-analysis content
  const bgm = path.join(BGM_DIR, "dramatic.mp3");
  // Compute final duration (sum minus xfades)
  let dur = 0;
  for (const scene of script.scenes) {
    dur += (scene as { durationSeconds?: number }).durationSeconds ?? 5;
  }
  dur -= XFADE_SECONDS * (script.scenes.length - 1);

  console.log(`-> Mixing BGM (${path.basename(bgm)})`);
  const out = path.join(OUT_DIR, "pilot.mp4");
  await mixBgm(silent, out, bgm, dur);

  console.log(`\nDone -> ${path.relative(ROOT, out)} (${dur.toFixed(1)}s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
