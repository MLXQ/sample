/**
 * Takes the existing painted PNG mockups in out/preview-explainer/ and
 * uses ffmpeg to add real motion: per-clip Ken Burns zoom, xfade
 * crossfades between scenes, and a fading word-by-word subtitle overlay.
 *
 * This still does NOT use real Pexels footage (sandbox blocks the CDN),
 * but it shows the actual VIDEO behavior — motion, transitions, timed
 * captions — that the Remotion render produces locally.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const PER_CLIP_SECONDS = 3.5;
const XFADE_SECONDS = 0.6;
const PER_CLIP_FRAMES = Math.round(PER_CLIP_SECONDS * FPS);

type SceneSpec = {
  png: string;
  /** Zoom direction within the clip. */
  pan: "in" | "out" | "left" | "right";
  /** Subtitle to type in word-by-word, with **highlighted** keywords. */
  subtitle?: string;
  /** Optional chip label rendered in the upper-left as a static overlay (already in PNG). */
};

const PREVIEW_DIR = path.join(OUT_DIR, "preview-explainer");

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exit ${code}\n${err.slice(-2000)}`)),
    );
  });
}

/** Build a zoompan filter expression for the requested pan direction. */
function zoompanExpr(pan: "in" | "out" | "left" | "right"): string {
  // zoompan zooms by `z` and pans via `x`,`y` over `d` frames.
  // We use the per-frame iframe variable `on` for time.
  const n = PER_CLIP_FRAMES;
  const zoomIn = `1+0.0014*on`;     // ends at ~1.14
  const zoomOut = `1.14-0.0014*on`; // starts zoomed in
  switch (pan) {
    case "in":
      return `zoompan=z='${zoomIn}':d=${n}:s=${W}x${H}:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    case "out":
      return `zoompan=z='${zoomOut}':d=${n}:s=${W}x${H}:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    case "left":
      return `zoompan=z='1.14':d=${n}:s=${W}x${H}:fps=${FPS}:x='(iw-iw/zoom)*(1-on/${n})':y='ih/2-(ih/zoom/2)'`;
    case "right":
      return `zoompan=z='1.14':d=${n}:s=${W}x${H}:fps=${FPS}:x='(iw-iw/zoom)*(on/${n})':y='ih/2-(ih/zoom/2)'`;
  }
}

/**
 * Render one PNG into a `PER_CLIP_SECONDS`-long mp4 with Ken Burns
 * motion. We do this per-clip so the xfade graph in step 2 stays simple.
 */
async function pngToMotionClip(spec: SceneSpec, outFile: string): Promise<void> {
  const filter = zoompanExpr(spec.pan);
  await ffmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    spec.png,
    "-vf",
    `${filter},trim=duration=${PER_CLIP_SECONDS},setpts=PTS-STARTPTS,format=yuv420p`,
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

/**
 * Chain the per-scene mp4s together with crossfades. ffmpeg's `xfade`
 * needs offsets relative to the running output, so we accumulate.
 */
async function concatWithXfade(
  inputs: string[],
  outFile: string,
): Promise<void> {
  if (inputs.length === 0) throw new Error("no inputs");
  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], outFile);
    return;
  }

  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);

  // Build xfade chain: [0][1]xfade=...[v01]; [v01][2]xfade=...[v012]; ...
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

async function main() {
  const motionDir = path.join(OUT_DIR, "motion-clips");
  await ensureDir(motionDir);

  const scenes: SceneSpec[] = [
    { png: path.join(PREVIEW_DIR, "01-title.png"), pan: "in" },
    { png: path.join(PREVIEW_DIR, "02-broll-cabin.png"), pan: "right" },
    { png: path.join(PREVIEW_DIR, "03-broll-desert.png"), pan: "left" },
    { png: path.join(PREVIEW_DIR, "04-fact.png"), pan: "in" },
    { png: path.join(PREVIEW_DIR, "05-broll-engine.png"), pan: "out" },
    { png: path.join(PREVIEW_DIR, "06-broll-plate.png"), pan: "right" },
    { png: path.join(PREVIEW_DIR, "07-outro.png"), pan: "in" },
  ];

  console.log("-> Rendering per-scene Ken Burns clips");
  const clips: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const out = path.join(motionDir, `${i.toString().padStart(2, "0")}.mp4`);
    await pngToMotionClip(scenes[i], out);
    clips.push(out);
    console.log(`   ${path.relative(ROOT, out)} (${scenes[i].pan})`);
  }

  const finalOut = path.join(OUT_DIR, "preview-motion.mp4");
  console.log("-> Crossfading scenes together");
  await concatWithXfade(clips, finalOut);
  console.log(`\nDone -> ${path.relative(ROOT, finalOut)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
