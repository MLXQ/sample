/**
 * Final-quality demo compositor. Combines every improvement onto the
 * real-footage explainer pipeline:
 *
 *   1. Real video footage as background (CCTV samples here, Pexels in prod)
 *   2. NO Ken Burns on video sources (only stills get zoompan) -> natural feel
 *   3. Per-scene color grading via ffmpeg eq= (chip mood drives the look)
 *   4. Word-by-word kinetic subtitle reveal (multiple PNG overlays, each
 *      enabled at a slice of the scene timeline)
 *   5. Keyword scale-pop on highlighted words
 *   6. xfade scene transitions
 *   7. Procedurally generated BGM mixed under (with ducking-ready compressor)
 *
 * Output: out/preview-final.mp4 — silent on the voice track but with
 * music. Run scripts/mix-narration.ts afterwards to add user voiceover.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir, PUBLIC_DIR } from "./lib/paths.js";
import { getPalette } from "../src/styles/theme.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const PER_CLIP_SECONDS = 4.0;
const XFADE_SECONDS = 0.6;
const PER_CLIP_FRAMES = Math.round(PER_CLIP_SECONDS * FPS);
const REVEAL_LEAD_FRAMES = 6; // wait this many frames before first word reveals
const REVEAL_TAIL_FRAMES = 8; // last word stays put for this many frames

const palette = getPalette("explainer");
const VIDEOS_DIR = path.join(PUBLIC_DIR, "videos", "source");
const BGM_DIR = path.join(PUBLIC_DIR, "audio", "bgm");
const SCENES_DIR = path.join(OUT_DIR, "final-clips");
const OVERLAY_DIR = path.join(OUT_DIR, "final-overlays");

// Mood -> (color grade preset, BGM track key)
type Mood = "neutral" | "intrigue" | "twist" | "reveal" | "calm";

const COLOR_GRADE: Record<Mood, string> = {
  // ffmpeg "eq" filter strings. Subtle — never push beyond ±15%.
  neutral: "eq=contrast=1.05:saturation=0.95",
  intrigue: "eq=contrast=1.10:saturation=0.85:gamma_b=1.05", // cool, desaturated
  twist: "eq=contrast=1.15:saturation=1.05:gamma_r=1.05", // warm, punchy
  reveal: "eq=contrast=1.10:saturation=1.10:brightness=0.02", // bright, alive
  calm: "eq=contrast=1.02:saturation=0.90:brightness=-0.02", // soft, muted
};

const BGM_BY_MOOD: Record<Mood, string> = {
  neutral: "curious.mp3",
  intrigue: "curious.mp3",
  twist: "dramatic.mp3",
  reveal: "dramatic.mp3",
  calm: "calm.mp3",
};

type Scene = {
  video: string; // empty = no footage
  startTime: number;
  mood: Mood;
  chip?: string;
  subtitle?: string;
  title?: { line1: string; line2: string; eyebrow: string };
  fact?: { tag: string; text: string; source: string };
  outro?: { cta: string };
};

const SCRIPT_TITLE = "Why Supermarkets Slow You Down";

const SCENES: Scene[] = [
  {
    video: "face-demographics-walking.mp4",
    startTime: 5,
    mood: "calm",
    title: {
      eyebrow: "Explained in 90 seconds",
      line1: "Why Supermarkets",
      line2: "Slow You Down",
    },
  },
  {
    video: "store-aisle-detection.mp4",
    startTime: 2,
    mood: "intrigue",
    chip: "The Setup",
    subtitle: "Every supermarket layout is **engineered** — not random.",
  },
  {
    video: "fruit-and-vegetable-detection.mp4",
    startTime: 18,
    mood: "neutral",
    subtitle: "**Fresh produce** is always at the entrance.",
  },
  {
    video: "people-detection.mp4",
    startTime: 4,
    mood: "neutral",
    subtitle: "It primes you to feel **healthier** before you spend.",
  },
  {
    video: "",
    startTime: 0,
    mood: "calm",
    fact: {
      tag: "DID YOU KNOW?",
      text: "Slow background music boosts grocery sales by 38%.",
      source: "Milliman, Journal of Marketing, 1982",
    },
  },
  {
    video: "store-aisle-detection.mp4",
    startTime: 18,
    mood: "reveal",
    chip: "The Reveal",
    subtitle: "Music, lighting, even aisle width — all tuned for **slowness**.",
  },
  {
    video: "",
    startTime: 0,
    mood: "calm",
    outro: { cta: "Subscribe for more curiosity." },
  },
];

// --- ffmpeg helpers -----------------------------------------------------

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

// --- canvas drawing primitives ------------------------------------------

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
  const out: Token[] = [];
  for (const p of parts)
    for (const w of p.text.split(/\s+/).filter(Boolean))
      out.push({ word: w, highlight: p.hl });
  return out;
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

function drawBottomGradient(ctx: SKRSContext2D) {
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.6, "rgba(0,0,0,0.6)");
  g.addColorStop(1, "rgba(0,0,0,0.9)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.45, W, H * 0.55);
}

/**
 * Layout the hero subtitle and return per-word x/y/highlight info.
 * Same layout used by every keyframe so words stay still as they reveal.
 */
type WordLayout = {
  word: string;
  highlight: boolean;
  x: number;
  y: number;
  width: number;
};
function layoutSubtitle(
  ctx: SKRSContext2D,
  text: string,
): { layout: WordLayout[]; fontSize: number } {
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

  const layout: WordLayout[] = [];
  linesAsTokens.forEach((lineTokens, li) => {
    const lineWidth =
      lineTokens.map((t) => ctx.measureText(t.word).width).reduce((a, b) => a + b, 0) +
      ctx.measureText(" ").width * Math.max(0, lineTokens.length - 1);
    let x = (W - lineWidth) / 2;
    const y = startY + (li + 1) * lineH;
    for (let i = 0; i < lineTokens.length; i++) {
      const t = lineTokens[i];
      const w = ctx.measureText(t.word).width;
      layout.push({ word: t.word, highlight: t.highlight, x, y, width: w });
      x += w;
      if (i < lineTokens.length - 1) x += ctx.measureText(" ").width;
    }
  });
  return { layout, fontSize };
}

function drawSubtitleUpToWord(
  ctx: SKRSContext2D,
  layout: WordLayout[],
  fontSize: number,
  visibleCount: number,
  popIndex: number | null,
) {
  ctx.font = `800 ${fontSize}px "Inter", system-ui, sans-serif`;
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 4;
  for (let i = 0; i < Math.min(visibleCount, layout.length); i++) {
    const w = layout[i];
    ctx.fillStyle = w.highlight ? palette.accent : palette.text;

    if (i === popIndex && w.highlight) {
      // Slight pop for the highlighted word as it appears
      ctx.save();
      const cx = w.x + w.width / 2;
      const cy = w.y - fontSize * 0.35;
      ctx.translate(cx, cy);
      ctx.scale(1.08, 1.08);
      ctx.translate(-cx, -cy);
      ctx.fillText(w.word, w.x, w.y);
      ctx.restore();
    } else {
      ctx.fillText(w.word, w.x, w.y);
    }
  }
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
  ctx.fillStyle = palette.accent;
  ctx.font = '800 36px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.95)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;
  ctx.fillText(eyebrow.toUpperCase().split("").join(" "), W / 2, H / 2 - 180);

  ctx.fillStyle = palette.text;
  ctx.font = '900 130px "Inter", sans-serif';
  ctx.fillText(l1, W / 2, H / 2 - 20);
  ctx.fillText(l2, W / 2, H / 2 + 130);

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

// --- per-scene compositing ----------------------------------------------

type TimedOverlay = {
  file: string;
  startFrame: number;
  endFrame: number;
};

type SceneOverlays = {
  /** Always-on full-frame card (title/fact/outro/empty). null for broll. */
  base: string | null;
  /** Time-windowed overlays for kinetic subtitle. Empty for non-broll. */
  timed: TimedOverlay[];
};

/**
 * For broll: render keyframe overlays per word (and a pop variant for
 * highlighted words). Each overlay is given an explicit time window so
 * the chain has no gaps. For title/fact/outro: a single full-frame.
 */
async function renderKeyframeOverlays(
  scene: Scene,
  isOverFootage: boolean,
  outDir: string,
): Promise<SceneOverlays> {
  await ensureDir(outDir);

  // Title / fact / outro: single full overlay
  if (scene.title) {
    const file = path.join(outDir, "00.png");
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    if (isOverFootage) drawBottomGradient(ctx);
    drawTitle(ctx, scene.title.eyebrow, scene.title.line1, scene.title.line2);
    await fs.writeFile(file, await canvas.encode("png"));
    return { base: file, timed: [] };
  }
  if (scene.fact) {
    const file = path.join(outDir, "00.png");
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    drawFact(ctx, scene.fact.tag, scene.fact.text, scene.fact.source);
    await fs.writeFile(file, await canvas.encode("png"));
    return { base: file, timed: [] };
  }
  if (scene.outro) {
    const file = path.join(outDir, "00.png");
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    drawOutro(ctx, scene.outro.cta);
    await fs.writeFile(file, await canvas.encode("png"));
    return { base: file, timed: [] };
  }

  const subtitle = scene.subtitle ?? "";
  if (!subtitle) {
    // No subtitle but we still want chip + gradient
    const file = path.join(outDir, "00.png");
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    if (isOverFootage) drawBottomGradient(ctx);
    if (scene.chip) drawChip(ctx, scene.chip);
    await fs.writeFile(file, await canvas.encode("png"));
    return { base: file, timed: [] };
  }

  // Broll with subtitle. Layout the words once.
  const layoutCanvas = createCanvas(W, H);
  const layoutCtx = layoutCanvas.getContext("2d") as unknown as SKRSContext2D;
  const { layout, fontSize } = layoutSubtitle(layoutCtx, subtitle);

  // Empty base (gradient + chip only). Always shown; word overlays are
  // STACKED on top during their windows. The base never goes away.
  const baseFile = path.join(outDir, "base.png");
  {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    if (isOverFootage) drawBottomGradient(ctx);
    if (scene.chip) drawChip(ctx, scene.chip);
    await fs.writeFile(baseFile, await canvas.encode("png"));
  }

  // Word-by-word reveal timing
  const revealStart = REVEAL_LEAD_FRAMES;
  const revealEnd = PER_CLIP_FRAMES - REVEAL_TAIL_FRAMES;
  const wordSlot = (revealEnd - revealStart) / layout.length;
  const POP_FRAMES = 4;

  const timed: TimedOverlay[] = [];
  for (let k = 1; k <= layout.length; k++) {
    const wStart = Math.round(revealStart + (k - 1) * wordSlot);
    const wEnd =
      k === layout.length
        ? PER_CLIP_FRAMES
        : Math.round(revealStart + k * wordSlot);

    if (layout[k - 1].highlight) {
      // Pop frame for first POP_FRAMES of this word's slot
      const popFile = path.join(outDir, `${String(k).padStart(2, "0")}-pop.png`);
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
      if (isOverFootage) drawBottomGradient(ctx);
      if (scene.chip) drawChip(ctx, scene.chip);
      drawSubtitleUpToWord(ctx, layout, fontSize, k, k - 1);
      await fs.writeFile(popFile, await canvas.encode("png"));
      timed.push({ file: popFile, startFrame: wStart, endFrame: wStart + POP_FRAMES });

      // Static frame fills the rest of the slot
      const staticFile = path.join(outDir, `${String(k).padStart(2, "0")}.png`);
      const c2 = createCanvas(W, H);
      const cx2 = c2.getContext("2d") as unknown as SKRSContext2D;
      if (isOverFootage) drawBottomGradient(cx2);
      if (scene.chip) drawChip(cx2, scene.chip);
      drawSubtitleUpToWord(cx2, layout, fontSize, k, null);
      await fs.writeFile(staticFile, await c2.encode("png"));
      timed.push({ file: staticFile, startFrame: wStart + POP_FRAMES, endFrame: wEnd });
    } else {
      const file = path.join(outDir, `${String(k).padStart(2, "0")}.png`);
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
      if (isOverFootage) drawBottomGradient(ctx);
      if (scene.chip) drawChip(ctx, scene.chip);
      drawSubtitleUpToWord(ctx, layout, fontSize, k, null);
      await fs.writeFile(file, await canvas.encode("png"));
      timed.push({ file, startFrame: wStart, endFrame: wEnd });
    }
  }

  return { base: baseFile, timed };
}

async function renderSceneClip(
  scene: Scene,
  overlays: SceneOverlays,
  outFile: string,
): Promise<void> {
  const grade = COLOR_GRADE[scene.mood];

  // Inputs:
  //   [0]: source video (or looped base PNG)
  //   [1]: base overlay PNG (always-on)
  //   [2..N+1]: timed overlay PNGs
  const args: string[] = ["-y"];
  if (scene.video) {
    const src = path.join(VIDEOS_DIR, scene.video);
    args.push("-ss", String(scene.startTime), "-i", src);
  } else {
    args.push("-loop", "1", "-i", overlays.base!);
  }
  if (overlays.base) args.push("-loop", "1", "-i", overlays.base);
  for (const tf of overlays.timed) args.push("-loop", "1", "-i", tf.file);

  const filters: string[] = [];
  if (scene.video) {
    filters.push(
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${grade},trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS[base]`,
    );
  } else {
    filters.push(
      `[0:v]scale=${W}:${H},${grade},trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS[base]`,
    );
  }

  let prev = "[base]";
  let nextIdx = 1;

  // Always-on base overlay (gradient + chip)
  if (overlays.base) {
    filters.push(`${prev}[${nextIdx}:v]overlay=0:0[ovb]`);
    prev = "[ovb]";
    nextIdx++;
  }

  // Timed word/pop overlays
  for (let i = 0; i < overlays.timed.length; i++) {
    const tf = overlays.timed[i];
    const out = i === overlays.timed.length - 1 ? "[v]" : `[ov${i}]`;
    const t1 = (tf.startFrame / FPS).toFixed(3);
    const t2 = (tf.endFrame / FPS).toFixed(3);
    filters.push(
      `${prev}[${nextIdx}:v]overlay=0:0:enable='between(t,${t1},${t2})'${out}`,
    );
    prev = out;
    nextIdx++;
  }

  // If there were no timed overlays, the base is the final output
  const finalLabel = overlays.timed.length === 0 ? prev : "[v]";
  if (overlays.timed.length === 0 && prev !== "[v]") {
    // alias prev to [v] for -map
    filters.push(`${prev}null[v]`);
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
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
    "-pix_fmt",
    "yuv420p",
    "-an",
    outFile,
  );

  await ffmpeg(args);
}

// --- xfade chain --------------------------------------------------------

async function concatWithXfade(inputs: string[], outFile: string): Promise<void> {
  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], outFile);
    return;
  }
  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);
  const filters: string[] = [];
  let prev = "[0:v]";
  let off = PER_CLIP_SECONDS - XFADE_SECONDS;
  for (let i = 1; i < inputs.length; i++) {
    const out = i === inputs.length - 1 ? "[vout]" : `[v${i}]`;
    filters.push(
      `${prev}[${i}:v]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${off.toFixed(2)}${out}`,
    );
    prev = out;
    off += PER_CLIP_SECONDS - XFADE_SECONDS;
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

// --- BGM mixing ---------------------------------------------------------

async function mixBgm(
  silentVideo: string,
  outFile: string,
  durationSeconds: number,
): Promise<void> {
  // Pick BGM by the dominant mood of the script's broll scenes.
  // Heuristic: use the first non-title broll scene's mood.
  const broll = SCENES.find((s) => s.subtitle);
  const mood: Mood = broll?.mood ?? "intrigue";
  const bgmFile = path.join(BGM_DIR, BGM_BY_MOOD[mood]);

  await ffmpeg([
    "-y",
    "-i",
    silentVideo,
    "-i",
    bgmFile,
    "-filter_complex",
    // Lower BGM volume substantially since narration will eventually sit on top.
    // afade in at start, out at end. Matches video duration.
    `[1:a]volume=0.32,afade=t=in:st=0:d=1.5,afade=t=out:st=${(durationSeconds - 2).toFixed(2)}:d=2,atrim=duration=${durationSeconds.toFixed(2)}[bgm]`,
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

// --- main ---------------------------------------------------------------

async function ensureSampleVideos(): Promise<void> {
  await ensureDir(VIDEOS_DIR);
  const need = Array.from(new Set(SCENES.map((s) => s.video).filter(Boolean)));
  for (const v of need) {
    const out = path.join(VIDEOS_DIR, v);
    try {
      await fs.access(out);
      continue;
    } catch {
      // missing
    }
    const url = `https://raw.githubusercontent.com/intel-iot-devkit/sample-videos/master/${v}`;
    console.log(`   downloading ${v}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${v} -> ${res.status}`);
    await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
  }
}

async function main() {
  await ensureDir(SCENES_DIR);
  await ensureDir(OVERLAY_DIR);
  await ensureSampleVideos();

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

  const clips: string[] = [];
  for (let i = 0; i < SCENES.length; i++) {
    const s = SCENES[i];
    const sceneOverlayDir = path.join(OVERLAY_DIR, String(i).padStart(2, "0"));
    const overlays = await renderKeyframeOverlays(s, !!s.video, sceneOverlayDir);
    const clip = path.join(SCENES_DIR, `${String(i).padStart(2, "0")}.mp4`);
    await renderSceneClip(s, overlays, clip);
    clips.push(clip);
    const tag = s.title ? "title" : s.fact ? "fact" : s.outro ? "outro" : "broll";
    console.log(
      `[${i + 1}/${SCENES.length}] ${tag.padEnd(5)} ${s.video || "(card)"} :: ${overlays.timed.length} timed overlay(s)`,
    );
  }

  console.log("-> Crossfading scenes");
  const silent = path.join(OUT_DIR, "preview-final-silent.mp4");
  await concatWithXfade(clips, silent);

  // Get exact duration (clips minus xfade overlap)
  const totalDur =
    clips.length * PER_CLIP_SECONDS - (clips.length - 1) * XFADE_SECONDS;

  console.log("-> Mixing BGM");
  const final = path.join(OUT_DIR, "preview-final.mp4");
  await mixBgm(silent, final, totalDur);

  console.log(`\nDone -> ${path.relative(ROOT, final)} (${totalDur.toFixed(1)}s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
