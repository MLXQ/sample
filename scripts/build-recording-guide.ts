/**
 * Builds a recording-guide variant of preview-final.mp4 that helps the
 * user record narration in sync.
 *
 * Differences vs preview-final:
 *   - Adds a small upper-right scene timer ("Scene 3 / 7 · 0:08")
 *   - Adds a top banner with the narration script for the current scene
 *     (large readable typography, like a teleprompter)
 *   - Slight pre-roll countdown bar at the start of each scene
 *   - BGM is not added — user records over silent backbone
 *
 * Output: out/recording-guide.mp4. The user plays this in their DAW
 * (DaVinci Resolve / Descript / Audacity), reads the on-screen script,
 * exports their voice as voice.mp3, and runs scripts/mix-narration.ts.
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
const PER_CLIP_SECONDS = 5.5; // longer per scene so user can comfortably read
const PER_CLIP_FRAMES = Math.round(PER_CLIP_SECONDS * FPS);

const palette = getPalette("explainer");
const VIDEOS_DIR = path.join(PUBLIC_DIR, "videos", "source");
const CLIPS_DIR = path.join(OUT_DIR, "guide-clips");
const OVL_DIR = path.join(OUT_DIR, "guide-overlays");

type Scene = {
  /** Source video (or empty for cards). */
  video: string;
  startTime: number;
  /** Verbatim narration the user should read. */
  narration: string;
  /** Optional scene label. */
  label: string;
};

// Same script as preview-final; narration text is what the user reads aloud.
const SCRIPT_TITLE = "Why Supermarkets Slow You Down";

const SCENES: Scene[] = [
  {
    video: "face-demographics-walking.mp4",
    startTime: 5,
    narration:
      "You've probably noticed this. Walk into any supermarket, and somehow you always come out with more than you planned. That isn't an accident — here's why.",
    label: "Title",
  },
  {
    video: "store-aisle-detection.mp4",
    startTime: 2,
    narration:
      "Every supermarket layout is engineered, not random. Architects spend years figuring out exactly where to put each aisle.",
    label: "The Setup",
  },
  {
    video: "fruit-and-vegetable-detection.mp4",
    startTime: 18,
    narration:
      "Fresh produce is almost always at the entrance — bright colors, vibrant smells, the look of health.",
    label: "Produce",
  },
  {
    video: "people-detection.mp4",
    startTime: 4,
    narration:
      "It primes you to feel healthier before you spend, which makes it easier to justify what comes next.",
    label: "Priming",
  },
  {
    video: "",
    startTime: 0,
    narration:
      "And there's the music. A 1982 study by Ronald Milliman found that slow background music can boost grocery sales by as much as thirty-eight percent.",
    label: "Fact",
  },
  {
    video: "store-aisle-detection.mp4",
    startTime: 18,
    narration:
      "Music tempo, lighting, even aisle width — all of it is tuned for slowness. The longer you stay, the more you spend.",
    label: "The Reveal",
  },
  {
    video: "",
    startTime: 0,
    narration: "Subscribe for more curiosity.",
    label: "Outro",
  },
];

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exit ${code}\n${err.slice(-1200)}`)),
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

function drawTeleprompter(
  ctx: SKRSContext2D,
  scene: Scene,
  sceneNum: number,
  totalScenes: number,
  elapsedSecondsAtFrame: number,
) {
  // Top dark banner with narration (the "teleprompter")
  const bannerH = 360;
  ctx.fillStyle = "rgba(8,12,20,0.92)";
  ctx.fillRect(0, 0, W, bannerH);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(0, bannerH, W, 4);

  // Scene meta (top-left)
  ctx.font = '700 26px "Inter", sans-serif';
  ctx.fillStyle = palette.accent;
  ctx.fillText(
    `SCENE ${sceneNum} / ${totalScenes}  ·  ${scene.label.toUpperCase()}`,
    50,
    50,
  );

  // Scene timer (top-right)
  const timerStr = `${elapsedSecondsAtFrame.toFixed(1)}s / ${PER_CLIP_SECONDS.toFixed(1)}s`;
  ctx.font = '700 26px "Inter", sans-serif';
  const tw = ctx.measureText(timerStr).width;
  ctx.fillText(timerStr, W - 50 - tw, 50);

  // Narration text (large, centered)
  ctx.fillStyle = palette.text;
  ctx.font = '600 44px "Inter", sans-serif';
  const lines = wrapText(ctx, scene.narration, W - 200);
  const lineH = 60;
  const totalH = lines.length * lineH;
  const startY = 80 + (bannerH - 80 - totalH) / 2 + lineH;
  ctx.textAlign = "center";
  lines.forEach((l, i) => {
    ctx.fillText(l, W / 2, startY + i * lineH);
  });
  ctx.textAlign = "start";

  // Progress bar inside banner
  const pct = Math.min(1, elapsedSecondsAtFrame / PER_CLIP_SECONDS);
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(50, bannerH - 14, W - 100, 6);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(50, bannerH - 14, (W - 100) * pct, 6);
}

function drawCountdown(ctx: SKRSContext2D, secondsLeft: number) {
  const cx = W / 2;
  const cy = (H + 360) / 2;
  ctx.font = '900 220px "Inter", sans-serif';
  ctx.fillStyle = palette.accent;
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 30;
  ctx.fillText(String(Math.ceil(secondsLeft)), cx, cy + 40);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.textAlign = "start";
}

async function renderSceneOverlay(
  scene: Scene,
  sceneNum: number,
  totalScenes: number,
  outDir: string,
): Promise<{ overlayFiles: { file: string; startFrame: number; endFrame: number }[] }> {
  await ensureDir(outDir);
  const overlays: { file: string; startFrame: number; endFrame: number }[] = [];

  // We render N overlay snapshots (each at 1-second intervals) so the
  // teleprompter timer ticks. Cheaper than a full per-frame overlay.
  const SNAPSHOT_HZ = 5; // 5 frames per second snapshot resolution
  const total = Math.ceil(PER_CLIP_SECONDS * SNAPSHOT_HZ);
  const framesPerSnap = Math.round(FPS / SNAPSHOT_HZ);

  for (let s = 0; s < total; s++) {
    const elapsed = s / SNAPSHOT_HZ;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;

    drawTeleprompter(ctx, scene, sceneNum, totalScenes, elapsed);

    // Show countdown only during the first 1.5s of each scene
    if (elapsed < 1.5) {
      const countdownVal = 1.5 - elapsed;
      if (countdownVal > 0) drawCountdown(ctx, countdownVal);
    }

    const file = path.join(outDir, `${String(s).padStart(3, "0")}.png`);
    await fs.writeFile(file, await canvas.encode("png"));
    const startFrame = s * framesPerSnap;
    const endFrame =
      s === total - 1 ? PER_CLIP_FRAMES : (s + 1) * framesPerSnap;
    overlays.push({ file, startFrame, endFrame });
  }

  return { overlayFiles: overlays };
}

async function renderSceneClip(
  scene: Scene,
  overlayFiles: { file: string; startFrame: number; endFrame: number }[],
  outFile: string,
): Promise<void> {
  const args: string[] = ["-y"];
  if (scene.video) {
    const src = path.join(VIDEOS_DIR, scene.video);
    args.push("-ss", String(scene.startTime), "-i", src);
  } else {
    // Use the first overlay's region as background — but for cards we
    // want a clean dark backdrop. ffmpeg lavfi color source.
    args.push(
      "-f",
      "lavfi",
      "-i",
      `color=c=${palette.bgGradientTo.replace("#", "0x")}:s=${W}x${H}:r=${FPS}`,
    );
  }
  for (const o of overlayFiles) args.push("-loop", "1", "-i", o.file);

  const filters: string[] = [];
  if (scene.video) {
    filters.push(
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS[base]`,
    );
  } else {
    filters.push(
      `[0:v]trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS[base]`,
    );
  }

  let prev = "[base]";
  for (let i = 0; i < overlayFiles.length; i++) {
    const o = overlayFiles[i];
    const out = i === overlayFiles.length - 1 ? "[v]" : `[ov${i}]`;
    const t1 = (o.startFrame / FPS).toFixed(3);
    const t2 = (o.endFrame / FPS).toFixed(3);
    filters.push(
      `${prev}[${i + 1}:v]overlay=0:0:enable='between(t,${t1},${t2})'${out}`,
    );
    prev = out;
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
    "20",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outFile,
  );

  await ffmpeg(args);
}

async function concatClips(inputs: string[], outFile: string): Promise<void> {
  // Hard-cut concat (no xfade) so the audio sync is exact for the user.
  const listFile = path.join(CLIPS_DIR, "concat.txt");
  const lines = inputs.map((f) => `file '${path.resolve(f)}'`);
  await fs.writeFile(listFile, lines.join("\n"));
  await ffmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    outFile,
  ]);
}

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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${v} -> ${res.status}`);
    await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
  }
}

async function writeScriptText(outFile: string): Promise<void> {
  const lines: string[] = [];
  lines.push(`# ${SCRIPT_TITLE}\n`);
  lines.push(`Scene durations: ${PER_CLIP_SECONDS}s each\n`);
  SCENES.forEach((s, i) => {
    lines.push(`## Scene ${i + 1} / ${SCENES.length} — ${s.label}`);
    lines.push("");
    lines.push(s.narration);
    lines.push("");
  });
  await fs.writeFile(outFile, lines.join("\n"));
}

async function main() {
  await ensureDir(CLIPS_DIR);
  await ensureDir(OVL_DIR);
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
    const sceneDir = path.join(OVL_DIR, String(i).padStart(2, "0"));
    const { overlayFiles } = await renderSceneOverlay(
      SCENES[i],
      i + 1,
      SCENES.length,
      sceneDir,
    );
    const clip = path.join(CLIPS_DIR, `${String(i).padStart(2, "0")}.mp4`);
    await renderSceneClip(SCENES[i], overlayFiles, clip);
    clips.push(clip);
    console.log(`[${i + 1}/${SCENES.length}] ${SCENES[i].label}`);
  }

  console.log("-> Concatenating");
  const out = path.join(OUT_DIR, "recording-guide.mp4");
  await concatClips(clips, out);

  // Also drop a plain-text script the user can copy into Descript / a
  // teleprompter app if they prefer.
  const txt = path.join(OUT_DIR, "recording-script.md");
  await writeScriptText(txt);

  console.log(`\nDone:`);
  console.log(`  video  -> ${path.relative(ROOT, out)}`);
  console.log(`  script -> ${path.relative(ROOT, txt)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
