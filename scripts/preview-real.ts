/**
 * Composes a finished demo MP4 from REAL stock-style footage:
 *   - downloads sample videos (CCTV-style, but actual video, not painted gradients)
 *   - draws a transparent PNG overlay per scene (chip + hero subtitle with
 *     keyword highlights, drawn by canvas — no browser needed)
 *   - ffmpeg crops / scales / Ken-Burns-zooms each clip, blends a dark
 *     bottom gradient for subtitle readability, overlays the PNG
 *   - crossfades all the per-scene mp4s into a final demo
 *
 * Output: out/preview-real.mp4 — actual moving footage with the
 * channel's subtitle/chip system on top.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";
import { getPalette } from "../src/styles/theme.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const PER_CLIP_SECONDS = 3.8;
const XFADE_SECONDS = 0.6;
const PER_CLIP_FRAMES = Math.round(PER_CLIP_SECONDS * FPS);

const palette = getPalette("explainer");
const VIDEOS_DIR = path.join(ROOT, "public", "videos", "source");
const SCENES_DIR = path.join(OUT_DIR, "real-clips");
const OVERLAY_DIR = path.join(OUT_DIR, "real-overlays");

type Scene = {
  /** Source mp4 in public/videos/source. Empty string = no video, render gradient (used for fact card). */
  video: string;
  /** Trim point inside the source. */
  startTime: number;
  /** Camera move applied after scaling to 1920x1080. */
  pan: "in" | "out" | "left" | "right" | "none";
  /** Optional upper-left chip label. */
  chip?: string;
  /** Hero subtitle. **double asterisks** highlight keywords in accent color. */
  subtitle?: string;
  /** Title scene mode — render giant centered title instead of subtitle. */
  title?: { line1: string; line2: string; eyebrow: string };
  /** Fact card mode. */
  fact?: { tag: string; text: string; source: string };
  /** Outro mode. */
  outro?: { cta: string };
};

const SCENES: Scene[] = [
  {
    video: "face-demographics-walking.mp4",
    startTime: 5,
    pan: "in",
    title: {
      eyebrow: "Explained in 90 seconds",
      line1: "Why Supermarkets",
      line2: "Slow You Down",
    },
  },
  {
    video: "store-aisle-detection.mp4",
    startTime: 2,
    pan: "right",
    chip: "The Setup",
    subtitle: "Every supermarket layout is **engineered** — not random.",
  },
  {
    video: "fruit-and-vegetable-detection.mp4",
    startTime: 18,
    pan: "left",
    subtitle: "**Fresh produce** is always at the entrance.",
  },
  {
    video: "people-detection.mp4",
    startTime: 4,
    pan: "in",
    subtitle: "It primes you to feel **healthier** before you spend.",
  },
  {
    video: "",
    startTime: 0,
    pan: "in",
    fact: {
      tag: "DID YOU KNOW?",
      text: "Slow background music boosts grocery sales by 38%.",
      source: "Milliman, Journal of Marketing, 1982",
    },
  },
  {
    video: "store-aisle-detection.mp4",
    startTime: 18,
    pan: "out",
    chip: "The Reveal",
    subtitle: "Music, lighting, even aisle width — all tuned for **slowness**.",
  },
  {
    video: "",
    startTime: 0,
    pan: "in",
    outro: { cta: "Subscribe for more curiosity." },
  },
];

// ---------- ffmpeg helpers ----------

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exit ${code}\n${err.slice(-1500)}`)),
    );
  });
}

// ---------- overlay rendering ----------

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

type Token = { word: string; highlight: boolean };
function tokenize(s: string): Token[] {
  const re = /\*\*([^*]+)\*\*/g;
  const parts: { text: string; hl: boolean }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index), hl: false });
    parts.push({ text: m[1], hl: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last), hl: false });
  const words: Token[] = [];
  for (const p of parts) {
    for (const w of p.text.split(/\s+/).filter(Boolean)) {
      words.push({ word: w, highlight: p.hl });
    }
  }
  return words;
}

function drawChip(ctx: SKRSContext2D, label: string) {
  ctx.font = '800 28px "Inter", system-ui, sans-serif';
  const text = label.toUpperCase().split("").join(" ");
  const w = ctx.measureText(text).width + 56;
  const h = 56;
  const x = 80;
  const y = 80;
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = palette.accent;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillText(text, x + 28, y + 38);
}

function drawHeroSubtitle(ctx: SKRSContext2D, text: string) {
  const fontSize = 78;
  ctx.font = `800 ${fontSize}px "Inter", system-ui, sans-serif`;
  const plain = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  const maxW = W - 240;
  const plainLines = wrapText(ctx, plain, maxW);
  const lineH = fontSize * 1.18;

  const flat = tokenize(text);
  const linesAsTokens: Token[][] = [];
  let idx = 0;
  for (const line of plainLines) {
    const wordsInLine = line.split(/\s+/).filter(Boolean).length;
    linesAsTokens.push(flat.slice(idx, idx + wordsInLine));
    idx += wordsInLine;
  }

  const totalH = linesAsTokens.length * lineH;
  const startY = H - 140 - totalH;

  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 4;
  linesAsTokens.forEach((lineTokens, li) => {
    const lineWidth =
      lineTokens.map((t) => ctx.measureText(t.word).width).reduce((a, b) => a + b, 0) +
      ctx.measureText(" ").width * Math.max(0, lineTokens.length - 1);
    let x = (W - lineWidth) / 2;
    const y = startY + (li + 1) * lineH;
    for (let i = 0; i < lineTokens.length; i++) {
      const t = lineTokens[i];
      ctx.fillStyle = t.highlight ? palette.accent : palette.text;
      ctx.fillText(t.word, x, y);
      x += ctx.measureText(t.word).width;
      if (i < lineTokens.length - 1) x += ctx.measureText(" ").width;
    }
  });
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawTitle(
  ctx: SKRSContext2D,
  eyebrow: string,
  l1: string,
  l2: string,
) {
  // Top eyebrow
  ctx.fillStyle = palette.accent;
  ctx.font = '800 36px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;
  ctx.fillText(eyebrow.toUpperCase().split("").join(" "), W / 2, H / 2 - 180);

  // Big title
  ctx.fillStyle = palette.text;
  ctx.font = '900 130px "Inter", sans-serif';
  ctx.fillText(l1, W / 2, H / 2 - 20);
  ctx.fillText(l2, W / 2, H / 2 + 130);

  // Accent bar
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.fillStyle = palette.accent;
  ctx.fillRect(W / 2 - 60, H / 2 + 200, 120, 6);
  ctx.textAlign = "start";
}

function drawFact(
  ctx: SKRSContext2D,
  tag: string,
  fact: string,
  source: string,
) {
  // No real footage — paint a deep gradient so the card pops.
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, palette.bgGradientFrom);
  g.addColorStop(1, palette.bgGradientTo);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const r = ctx.createRadialGradient(W / 2, H * 0.3, 50, W / 2, H * 0.3, 900);
  r.addColorStop(0, palette.accentSoft);
  r.addColorStop(1, "transparent");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);

  const cardW = 1500;
  const cardH = 540;
  const cardX = (W - cardW) / 2;
  const cardY = (H - cardH) / 2;
  ctx.fillStyle = palette.surface;
  roundRect(ctx, cardX, cardY, cardW, cardH, 24);
  ctx.fill();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = palette.accent;
  ctx.font = '900 30px "Inter", sans-serif';
  ctx.fillText(tag.toUpperCase().split("").join(" "), cardX + 90, cardY + 100);

  ctx.fillStyle = palette.text;
  ctx.font = '800 60px "Inter", sans-serif';
  const lines = wrapText(ctx, fact, cardW - 180);
  lines.forEach((l, i) => ctx.fillText(l, cardX + 90, cardY + 200 + i * 76));

  ctx.fillStyle = palette.textMuted;
  ctx.font = 'italic 22px "Inter", sans-serif';
  ctx.fillText(`Source: ${source}`, cardX + 90, cardY + cardH - 50);
}

function drawOutro(ctx: SKRSContext2D, cta: string) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, palette.bgGradientFrom);
  g.addColorStop(1, palette.bgGradientTo);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = palette.text;
  ctx.font = '900 88px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(cta, W / 2, H / 2 - 50);

  // Subscribe button
  const btnText = "S U B S C R I B E";
  ctx.font = '800 36px "Inter", sans-serif';
  const btnW = ctx.measureText(btnText).width + 100;
  const btnH = 96;
  const bx = (W - btnW) / 2;
  const by = H / 2 + 50;

  ctx.shadowColor = palette.accent;
  ctx.shadowBlur = 60;
  ctx.fillStyle = palette.accent;
  roundRect(ctx, bx, by, btnW, btnH, btnH / 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillText(btnText, W / 2, by + 60);
  ctx.textAlign = "start";
}

function drawBottomGradient(ctx: SKRSContext2D) {
  // Dark gradient at bottom so the white subtitle stays readable
  // over any source footage.
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.6, "rgba(0,0,0,0.55)");
  g.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.45, W, H * 0.55);
}

async function renderOverlayPng(
  scene: Scene,
  outFile: string,
  isOverFootage: boolean,
): Promise<void> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;

  if (isOverFootage) {
    // Bottom gradient for readability over moving footage
    drawBottomGradient(ctx);
  }

  if (scene.title) {
    drawTitle(ctx, scene.title.eyebrow, scene.title.line1, scene.title.line2);
  } else if (scene.fact) {
    drawFact(ctx, scene.fact.tag, scene.fact.text, scene.fact.source);
  } else if (scene.outro) {
    drawOutro(ctx, scene.outro.cta);
  } else {
    if (scene.chip) drawChip(ctx, scene.chip);
    if (scene.subtitle) drawHeroSubtitle(ctx, scene.subtitle);
  }

  const buf = await canvas.encode("png");
  await fs.writeFile(outFile, buf);
}

// ---------- per-scene compositing ----------

function zoompanExpr(pan: Scene["pan"]): string {
  const n = PER_CLIP_FRAMES;
  const zIn = `1+0.001*on`;
  const zOut = `1.1-0.001*on`;
  const cx = `iw/2-(iw/zoom/2)`;
  const cy = `ih/2-(ih/zoom/2)`;
  switch (pan) {
    case "in":
      return `zoompan=z='${zIn}':d=${n}:s=${W}x${H}:fps=${FPS}:x='${cx}':y='${cy}'`;
    case "out":
      return `zoompan=z='${zOut}':d=${n}:s=${W}x${H}:fps=${FPS}:x='${cx}':y='${cy}'`;
    case "left":
      return `zoompan=z='1.1':d=${n}:s=${W}x${H}:fps=${FPS}:x='(iw-iw/zoom)*(1-on/${n})':y='${cy}'`;
    case "right":
      return `zoompan=z='1.1':d=${n}:s=${W}x${H}:fps=${FPS}:x='(iw-iw/zoom)*(on/${n})':y='${cy}'`;
    case "none":
      return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`;
  }
}

async function renderSceneClip(
  scene: Scene,
  i: number,
  overlayPng: string,
  outFile: string,
): Promise<void> {
  if (scene.video) {
    const src = path.join(VIDEOS_DIR, scene.video);
    // Pre-scale so zoompan operates on a 1920x1080 frame, then overlay PNG.
    const filter =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${zoompanExpr(scene.pan)},trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS[bg];` +
      `[bg][1:v]overlay=0:0,format=yuv420p[v]`;

    await ffmpeg([
      "-y",
      "-ss",
      String(scene.startTime),
      "-i",
      src,
      "-i",
      overlayPng,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-frames:v",
      String(PER_CLIP_FRAMES),
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "veryfast",
      "-an",
      outFile,
    ]);
  } else {
    // No source video — overlay on its own (already includes the gradient bg)
    await ffmpeg([
      "-y",
      "-loop",
      "1",
      "-i",
      overlayPng,
      "-vf",
      `${zoompanExpr(scene.pan)},trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS,format=yuv420p`,
      "-frames:v",
      String(PER_CLIP_FRAMES),
      "-r",
      String(FPS),
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "veryfast",
      outFile,
    ]);
  }
}

// ---------- xfade chain ----------

async function concatWithXfade(inputs: string[], outFile: string): Promise<void> {
  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], outFile);
    return;
  }
  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);
  const filters: string[] = [];
  let prevLabel = "[0:v]";
  let runningOffset = PER_CLIP_SECONDS - XFADE_SECONDS;
  for (let i = 1; i < inputs.length; i++) {
    const out = i === inputs.length - 1 ? "[vout]" : `[v${i}]`;
    filters.push(
      `${prevLabel}[${i}:v]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${runningOffset.toFixed(2)}${out}`,
    );
    prevLabel = out;
    runningOffset += PER_CLIP_SECONDS - XFADE_SECONDS;
  }
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    outFile,
  );
  await ffmpeg(args);
}

// ---------- main ----------

async function ensureSampleVideos(): Promise<void> {
  await ensureDir(VIDEOS_DIR);
  const need = Array.from(new Set(SCENES.map((s) => s.video).filter(Boolean)));
  for (const v of need) {
    const out = path.join(VIDEOS_DIR, v);
    try {
      await fs.access(out);
      continue;
    } catch {
      // missing — download
    }
    const url = `https://raw.githubusercontent.com/intel-iot-devkit/sample-videos/master/${v}`;
    console.log(`   downloading ${v}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${v} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(out, buf);
  }
}

async function main() {
  await ensureDir(SCENES_DIR);
  await ensureDir(OVERLAY_DIR);
  await ensureSampleVideos();

  // Try to register a system font for the Inter face
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

  console.log("-> Rendering scene overlays + clips");
  const clips: string[] = [];
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i];
    const overlay = path.join(OVERLAY_DIR, `${i.toString().padStart(2, "0")}.png`);
    const clip = path.join(SCENES_DIR, `${i.toString().padStart(2, "0")}.mp4`);
    await renderOverlayPng(s, overlay, !!s.video);
    await renderSceneClip(s, i, overlay, clip);
    clips.push(clip);
    const tag = s.title ? "title" : s.fact ? "fact" : s.outro ? "outro" : "broll";
    console.log(`   [${i + 1}/${SCENES.length}] ${tag.padEnd(5)} ${s.video || "(no footage)"}`);
  }

  const out = path.join(OUT_DIR, "preview-real.mp4");
  console.log("-> Crossfading scenes");
  await concatWithXfade(clips, out);
  console.log(`\nDone -> ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
