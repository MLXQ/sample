/**
 * Preview generator for the EXPLAINER style (Veritasium / Cleo Abram /
 * Johnny Harris flavor): cycling B-roll clips + big hero subtitle with
 * highlighted keywords + small upper-left chip label.
 *
 * Sandbox-friendly: draws static PNGs with @napi-rs/canvas. No browser,
 * no chromium needed. Real Remotion render replaces the painted "video"
 * background with actual Pexels stock footage and adds motion.
 */
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OUT_DIR, ensureDir, ROOT } from "./lib/paths.js";
import { getPalette } from "../src/styles/theme.js";

const W = 1920;
const H = 1080;
const palette = getPalette("explainer");

function fauxClip(ctx: SKRSContext2D, kind: string) {
  // Render a faux video frame: gradient + subject silhouette + grain.
  const palettes: Record<string, [string, string, string]> = {
    cabin: ["#7894b8", "#3a4f6e", "#0d1722"],
    airplane: ["#aac6e3", "#5979a3", "#0a1320"],
    desert: ["#e8b97a", "#b07a3b", "#2a1808"],
    nose: ["#f0d6c5", "#c39780", "#3a2014"],
    plate: ["#d8c7a1", "#7c5e36", "#1c1208"],
    salt: ["#eeece4", "#9a958a", "#1d1c18"],
    engine: ["#8a8d96", "#3e424d", "#0a0c12"],
    chef: ["#d8b89a", "#7d5236", "#1f140a"],
  };
  const colors = palettes[kind] ?? palettes.cabin;

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, colors[0]);
  g.addColorStop(0.6, colors[1]);
  g.addColorStop(1, colors[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Subject silhouette
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  if (kind === "cabin" || kind === "airplane") {
    // Plane silhouette
    ctx.beginPath();
    ctx.moveTo(W * 0.05, H * 0.55);
    ctx.lineTo(W * 0.7, H * 0.5);
    ctx.lineTo(W * 0.95, H * 0.52);
    ctx.lineTo(W * 0.95, H * 0.58);
    ctx.lineTo(W * 0.7, H * 0.6);
    ctx.lineTo(W * 0.05, H * 0.62);
    ctx.closePath();
    ctx.fill();
    // wing
    ctx.beginPath();
    ctx.moveTo(W * 0.45, H * 0.6);
    ctx.lineTo(W * 0.5, H * 0.78);
    ctx.lineTo(W * 0.62, H * 0.78);
    ctx.lineTo(W * 0.6, H * 0.6);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "desert" || kind === "nose") {
    // Dunes
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.ellipse(
        W * (0.1 + i * 0.27),
        H * (0.85 - i * 0.05),
        W * 0.3,
        H * 0.18,
        0,
        Math.PI,
        2 * Math.PI,
      );
      ctx.fill();
    }
  } else if (kind === "plate" || kind === "chef") {
    // Plate
    ctx.beginPath();
    ctx.ellipse(W / 2, H * 0.65, W * 0.3, H * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    // Food blob
    ctx.fillStyle = "rgba(255,180,80,0.7)";
    ctx.beginPath();
    ctx.ellipse(W / 2, H * 0.62, W * 0.18, H * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "engine") {
    // Engine cowl
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, W * 0.28, H * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Fan blades
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI * 2) / 12;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(a);
      ctx.fillRect(-12, -H * 0.32, 24, H * 0.32);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.fillStyle = "#222";
    ctx.arc(W / 2, H / 2, 60, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "salt") {
    // Salt grains
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * W;
      const y = H * 0.4 + Math.random() * H * 0.55;
      const r = 2 + Math.random() * 6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Grain
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = "#fff";
  for (let i = 0; i < 3000; i++) {
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  ctx.globalAlpha = 1;

  // Overlay darkening for subtitle readability
  const v = ctx.createLinearGradient(0, 0, 0, H);
  v.addColorStop(0, "rgba(0,0,0,0.35)");
  v.addColorStop(0.55, "rgba(0,0,0,0.15)");
  v.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function gradientBg(ctx: SKRSContext2D) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, palette.bgGradientFrom);
  g.addColorStop(1, palette.bgGradientTo);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const r = ctx.createRadialGradient(W * 0.7, H * 0.2, 50, W * 0.7, H * 0.2, 900);
  r.addColorStop(0, palette.accentSoft);
  r.addColorStop(1, "transparent");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);
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

type Token = { text: string; highlight: boolean };
function tokenize(s: string): Token[] {
  const re = /\*\*([^*]+)\*\*/g;
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), highlight: false });
    out.push({ text: m[1], highlight: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), highlight: false });
  return out;
}

function drawHeroSubtitle(ctx: SKRSContext2D, text: string) {
  const fontSize = 84;
  ctx.font = `800 ${fontSize}px "Inter", system-ui, sans-serif`;

  // Word wrap the plain version first to compute lines, then re-render
  // each line with token-aware coloring.
  const plain = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  const maxW = W - 240;
  const plainLines = wrapText(ctx, plain, maxW);
  const lineH = fontSize * 1.15;

  // Compute per-line tokens by walking the original string and matching
  // word-by-word against the wrapped lines.
  const tokens = tokenize(text);
  const flatWords: { word: string; highlight: boolean }[] = [];
  for (const t of tokens) {
    for (const w of t.text.split(/\s+/).filter(Boolean)) {
      flatWords.push({ word: w, highlight: t.highlight });
    }
  }

  const linesAsTokens: { word: string; highlight: boolean }[][] = [];
  let idx = 0;
  for (const line of plainLines) {
    const wordsInLine = line.split(/\s+/).filter(Boolean).length;
    linesAsTokens.push(flatWords.slice(idx, idx + wordsInLine));
    idx += wordsInLine;
  }

  const totalH = linesAsTokens.length * lineH;
  const startY = H - 120 - totalH;

  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 4;

  linesAsTokens.forEach((lineTokens, li) => {
    const lineWidth = lineTokens
      .map((t) => ctx.measureText(t.word).width)
      .reduce((a, b) => a + b, 0) +
      ctx.measureText(" ").width * Math.max(0, lineTokens.length - 1);
    let x = (W - lineWidth) / 2;
    const y = startY + (li + 1) * lineH;
    lineTokens.forEach((t, wi) => {
      ctx.fillStyle = t.highlight ? palette.accent : palette.text;
      ctx.fillText(t.word, x, y);
      x += ctx.measureText(t.word).width;
      if (wi < lineTokens.length - 1) x += ctx.measureText(" ").width;
    });
  });

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawChip(ctx: SKRSContext2D, label: string) {
  ctx.font = '800 28px "Inter", system-ui, sans-serif';
  const text = label.toUpperCase().split("").join(" ");
  const w = ctx.measureText(text).width + 56;
  const h = 56;
  const x = 80;
  const y = 80;

  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = palette.accent;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.fillStyle = "#0a0a0a";
  ctx.fillText(text, x + 28, y + 38);
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

function drawTitle(ctx: SKRSContext2D, title: string, subtitle: string) {
  gradientBg(ctx);

  ctx.fillStyle = palette.accent;
  ctx.font = '800 36px "Inter", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(subtitle.toUpperCase().split("").join(" "), W / 2, H / 2 - 140);

  ctx.fillStyle = palette.text;
  ctx.font = '900 130px "Inter", system-ui, sans-serif';
  const lines = wrapText(ctx, title, W - 240);
  const total = lines.length * 150;
  lines.forEach((l, i) => {
    ctx.fillText(l, W / 2, H / 2 - 30 + i * 150 - total / 2 + 150);
  });

  ctx.fillStyle = palette.accent;
  ctx.fillRect(W / 2 - 50, H / 2 + 130, 100, 6);
  ctx.textAlign = "start";
}

function drawBroll(
  ctx: SKRSContext2D,
  clipKind: string,
  subtitle: string,
  chip: string | null,
) {
  fauxClip(ctx, clipKind);
  if (chip) drawChip(ctx, chip);
  drawHeroSubtitle(ctx, subtitle);
}

function drawFact(ctx: SKRSContext2D, fact: string, source: string) {
  gradientBg(ctx);

  // Card
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

  // Tag
  ctx.fillStyle = palette.accent;
  ctx.font = '900 30px "Inter", system-ui, sans-serif';
  ctx.fillText("D I D   Y O U   K N O W ?", cardX + 90, cardY + 100);

  // Big fact
  ctx.fillStyle = palette.text;
  ctx.font = '800 64px "Inter", system-ui, sans-serif';
  const lines = wrapText(ctx, fact, cardW - 180);
  lines.forEach((l, i) => ctx.fillText(l, cardX + 90, cardY + 200 + i * 76));

  ctx.fillStyle = palette.textMuted;
  ctx.font = 'italic 22px "Inter", system-ui, sans-serif';
  ctx.fillText(`Source: ${source}`, cardX + 90, cardY + cardH - 50);
}

function drawOutro(ctx: SKRSContext2D, cta: string) {
  gradientBg(ctx);

  ctx.fillStyle = palette.text;
  ctx.font = '900 88px "Inter", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(cta, W / 2, H / 2 - 50);

  // Subscribe button
  const btnText = "S U B S C R I B E";
  ctx.font = '800 36px "Inter", system-ui, sans-serif';
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
    child.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`)),
    );
  });
}

async function tryFonts(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const c of candidates) {
    try {
      await fs.access(c);
      found.push(c);
    } catch {
      // not present
    }
  }
  return found;
}

async function main() {
  const dir = path.join(OUT_DIR, "preview-explainer");
  await ensureDir(dir);

  const interFonts = await tryFonts([
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ]);
  for (const f of interFonts) GlobalFonts.registerFromPath(f, "Inter");

  const scenes: { name: string; duration: number; draw: (ctx: SKRSContext2D) => void }[] = [
    {
      name: "01-title",
      duration: 3,
      draw: (ctx) =>
        drawTitle(ctx, "Why Airplane Food Tastes Worse", "Explained in 90 seconds"),
    },
    {
      name: "02-broll-cabin",
      duration: 3,
      draw: (ctx) =>
        drawBroll(
          ctx,
          "cabin",
          "At cruising altitude, your body is in a **pressurized cabin** at 8,000 feet.",
          "The Setup",
        ),
    },
    {
      name: "03-broll-desert",
      duration: 3,
      draw: (ctx) =>
        drawBroll(
          ctx,
          "desert",
          "The dry air dehydrates your **nose and tongue**.",
          null,
        ),
    },
    {
      name: "04-fact",
      duration: 3,
      draw: (ctx) =>
        drawFact(
          ctx,
          "Your sense of taste for sweet and salty drops by up to 30% in flight.",
          "Lufthansa / Fraunhofer Institute, 2010",
        ),
    },
    {
      name: "05-broll-engine",
      duration: 3,
      draw: (ctx) =>
        drawBroll(
          ctx,
          "engine",
          "Cabin noise also dulls **sweetness** and boosts **umami**.",
          "The Twist",
        ),
    },
    {
      name: "06-broll-plate",
      duration: 3,
      draw: (ctx) =>
        drawBroll(
          ctx,
          "plate",
          "That's why airlines load their food with **salt, spice, and tomato**.",
          null,
        ),
    },
    {
      name: "07-outro",
      duration: 3,
      draw: (ctx) => drawOutro(ctx, "Subscribe for more curiosity."),
    },
  ];

  console.log("-> Drawing explainer scene mockups");
  const concat: string[] = [];
  for (const s of scenes) {
    const png = path.join(dir, `${s.name}.png`);
    await savePng(png, s.draw);
    concat.push(`file '${png}'`);
    concat.push(`duration ${s.duration}`);
    console.log(`   wrote ${path.relative(ROOT, png)}`);
  }
  concat.push(`file '${path.join(dir, scenes[scenes.length - 1].name)}.png'`);
  const concatFile = path.join(dir, "concat.txt");
  await fs.writeFile(concatFile, concat.join("\n"));

  const mp4 = path.join(OUT_DIR, "preview-explainer.mp4");
  console.log("-> Stitching to MP4");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
