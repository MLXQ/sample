/**
 * Builds a 1280x720 YouTube thumbnail for the 12-layer AI pilot.
 * Big hook text + accent number + Memoji face crop pulled from the
 * first scene's user recording.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D, loadImage } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";
import { getPalette } from "../src/styles/theme.js";

const W = 1280;
const H = 720;

const UPLOAD_DIR = "/root/.claude/uploads/cbd4799e-32e1-46df-a261-819de48098c1";

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-800)}`)),
    );
  });
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

async function main() {
  await ensureDir(path.join(OUT_DIR, "thumb"));

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

  // Step 1: grab a Memoji face frame from scene 1 mov (mid-clip, mouth open)
  const memoji = path.join(UPLOAD_DIR, "d90bc61e-1.mov");
  const memojiFramePng = path.join(OUT_DIR, "thumb", "memoji-frame.png");
  await ffmpeg([
    "-y",
    "-ss",
    "3.5",
    "-i",
    memoji,
    "-frames:v",
    "1",
    "-vf",
    "crop=480:480:80:0",
    memojiFramePng,
  ]);

  const palette = getPalette("science");

  // Step 2: paint the thumbnail
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, palette.bgGradientFrom);
  bg.addColorStop(1, "#020714");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.65, H * 0.25, 80, W * 0.65, H * 0.25, 900);
  glow.addColorStop(0, palette.accentSoft);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Right-side stylized stack tower (12 bars decreasing in opacity)
  const towerX = W - 320;
  const towerY = 100;
  const towerW = 240;
  const towerBarH = 38;
  const towerGap = 6;
  const labels = [
    "Materials",
    "Lithography",
    "Foundries",
    "Memory",
    "Designers",
    "Networking",
    "Power",
    "Cooling",
    "Real Estate",
    "Cloud",
    "Foundation Models",
    "Applications",
  ];
  for (let i = 0; i < labels.length; i++) {
    const y = towerY + i * (towerBarH + towerGap);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    roundRect(ctx, towerX, y, towerW, towerBarH, 5);
    ctx.fill();
    ctx.fillStyle = palette.accent;
    ctx.fillRect(towerX, y, 4, towerBarH);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = '700 16px "Inter", sans-serif';
    ctx.fillText(labels[i], towerX + 16, y + 25);
  }

  // "12" giant accent number (top-left)
  ctx.fillStyle = palette.accent;
  ctx.font = '900 320px "Inter", sans-serif';
  ctx.shadowColor = "rgba(76,194,255,0.55)";
  ctx.shadowBlur = 40;
  ctx.fillText("12", 60, 290);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // "LAYERS" eyebrow
  ctx.fillStyle = palette.text;
  ctx.font = '900 52px "Inter", sans-serif';
  ctx.fillText("LAYERS", 240, 200);

  // Hook line (multi-line)
  ctx.fillStyle = palette.text;
  ctx.font = '900 64px "Inter", sans-serif';
  ctx.fillText("of the AI", 60, 380);
  ctx.fillText("BOOM", 60, 460);

  // Yellow burst banner at bottom
  const bannerH = 80;
  const bannerY = H - bannerH - 30;
  ctx.shadowColor = "rgba(255,210,61,0.6)";
  ctx.shadowBlur = 30;
  ctx.fillStyle = "#ffd23d";
  roundRect(ctx, 40, bannerY, 700, bannerH, 12);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#0a0a0a";
  ctx.font = '900 36px "Inter", sans-serif';
  ctx.fillText("$500B  ·  4 COUNTRIES  ·  3 MONOPOLIES", 60, bannerY + 52);

  // Memoji face (bottom-right, circular)
  const faceImg = await loadImage(memojiFramePng);
  const faceSize = 260;
  const faceX = W - faceSize - 30;
  const faceY = H - faceSize - 30;
  // Yellow ring
  ctx.shadowColor = "rgba(255,210,61,0.55)";
  ctx.shadowBlur = 26;
  ctx.strokeStyle = "#ffd23d";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(faceX + faceSize / 2, faceY + faceSize / 2, faceSize / 2 + 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // Clip to circle and draw
  ctx.save();
  ctx.beginPath();
  ctx.arc(faceX + faceSize / 2, faceY + faceSize / 2, faceSize / 2 - 4, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(faceImg, faceX, faceY, faceSize, faceSize);
  ctx.restore();

  // Save
  const out = path.join(ROOT, "demo", "youtube-thumbnail.jpg");
  const buf = await canvas.encode("jpeg", 92);
  await fs.writeFile(out, buf);
  console.log(`-> ${path.relative(ROOT, out)}  ${(buf.length / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
