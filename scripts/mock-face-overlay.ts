/**
 * One-shot mock: takes a single frame from pilot.mp4 and composites a
 * placeholder "face" circle in the bottom-right corner — to preview
 * what a Memoji / webcam PiP overlay would look like before the user
 * actually records anything.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const W = 1920;
const H = 1080;
const FACE_SIZE = 320;
const FACE_MARGIN = 40;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg ${code}\n${err.slice(-1000)}`)),
    );
  });
}

function drawFaceMockup(ctx: SKRSContext2D, label: string) {
  const cx = FACE_SIZE / 2;
  const cy = FACE_SIZE / 2;
  const r = FACE_SIZE / 2 - 6;

  // Outer accent ring
  ctx.strokeStyle = "#ffd23d";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
  ctx.stroke();

  // Face circle backdrop
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Skin tone (warm beige) — placeholder for any avatar
  const grad = ctx.createRadialGradient(cx - 30, cy - 40, 30, cx, cy, r);
  grad.addColorStop(0, "#f4cfa2");
  grad.addColorStop(1, "#c89968");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
  ctx.fill();

  // Hair (top)
  ctx.fillStyle = "#2c1d10";
  ctx.beginPath();
  ctx.ellipse(cx, cy - 40, r - 15, 60, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  // Eyes
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(cx - 36, cy - 5, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 36, cy - 5, 8, 0, Math.PI * 2);
  ctx.fill();
  // Eye highlights
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx - 33, cy - 8, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 39, cy - 8, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Mouth (small open speaking shape)
  ctx.fillStyle = "#5a2820";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 38, 22, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  // Teeth
  ctx.fillStyle = "#fff";
  ctx.fillRect(cx - 14, cy + 30, 28, 4);

  // "LIVE" indicator dot (pulsing red would animate; static here)
  ctx.fillStyle = "#ff5e3a";
  ctx.beginPath();
  ctx.arc(20, 20, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = '700 14px "Inter", sans-serif';
  ctx.fillText("LIVE", 36, 25);

  // Name label below (optional)
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, FACE_SIZE - 38, FACE_SIZE, 38);
  ctx.fillStyle = "#fff";
  ctx.font = '700 18px "Inter", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(label, FACE_SIZE / 2, FACE_SIZE - 12);
  ctx.textAlign = "start";
}

async function main() {
  await ensureDir(path.join(OUT_DIR, "face-overlay-mock"));
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

  // Render placeholder face PNG (with circular alpha)
  const facePng = path.join(OUT_DIR, "face-overlay-mock", "face.png");
  const canvas = createCanvas(FACE_SIZE, FACE_SIZE);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
  // Apply a clipping path so the canvas is circular (alpha)
  ctx.save();
  ctx.beginPath();
  ctx.arc(FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  drawFaceMockup(ctx, "YOUR FACE");
  ctx.restore();
  await fs.writeFile(facePng, await canvas.encode("png"));

  // Pick three pilot frames and composite the face into bottom-right
  const pilotPath = path.join(OUT_DIR, "pilot.mp4");
  const samples = [
    { name: "stack", t: 28 },
    { name: "marketshare", t: 38 },
    { name: "flow", t: 60 },
  ];

  const x = W - FACE_SIZE - FACE_MARGIN;
  const y = H - FACE_SIZE - FACE_MARGIN;

  for (const s of samples) {
    const out = path.join(OUT_DIR, "face-overlay-mock", `${s.name}-with-face.jpg`);
    await ffmpeg([
      "-y",
      "-ss",
      String(s.t),
      "-i",
      pilotPath,
      "-i",
      facePng,
      "-filter_complex",
      `[0:v][1:v]overlay=${x}:${y}[v]`,
      "-map",
      "[v]",
      "-frames:v",
      "1",
      out,
    ]);
    console.log(`-> ${path.relative(ROOT, out)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
