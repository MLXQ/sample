/**
 * Final video assembler. Inputs:
 *   - 11 Memoji .mov files (one per scene, named ...-1.mov ... -11.mov)
 *   - data/sample-pilot.json (script structure; durations get rewritten
 *     to match each Memoji clip's exact length so visuals never run
 *     ahead of speech)
 *   - public/audio/bgm/dramatic.mp3 (procedural BGM library)
 *
 * Pipeline:
 *   1. Probe every Memoji's duration; rewrite the per-scene
 *      durationSeconds in sample-pilot.json.
 *   2. Clear the pilot cache and run build-pilot.ts so the per-scene
 *      visual clips (out/pilot-clips/00.mp4 .. 10.mp4) match the new
 *      durations exactly.
 *   3. For each scene, ffmpeg-composite:
 *        - pilot scene clip (silent visual)
 *        - Memoji video cropped to a 280x280 circle, alpha-merged
 *          with a pre-rendered circular mask, overlaid in the
 *          bottom-left corner
 *        - Memoji audio cleaned up: highpass + compressor + loudnorm
 *      Output: out/final-clips/NN.mp4 (video + voice, no BGM yet).
 *   4. Hard-cut concat all 11 final clips into out/final-no-bgm.mp4.
 *   5. Sidechain-duck BGM under the voice and mux into
 *      out/final-with-voice.mp4. The voice stays present, music
 *      drops -8dB whenever speech is detected.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir, PUBLIC_DIR, DATA_DIR } from "./lib/paths.js";

const W = 1920;
const H = 1080;

// Face PiP layout
const FACE_SIZE = 280;
const FACE_MARGIN = 50;
type FacePos = "bottom-left" | "bottom-right" | "top-right" | "top-left";
const FACE_POSITION: FacePos = "bottom-left";

const UPLOAD_DIR =
  "/root/.claude/uploads/cbd4799e-32e1-46df-a261-819de48098c1";
const BGM_FILE = path.join(PUBLIC_DIR, "audio", "bgm", "dramatic.mp3");
const PILOT_JSON = path.join(DATA_DIR, "sample-pilot.json");

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-1500)}`)),
    );
  });
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0
        ? resolve(parseFloat(out.trim()))
        : reject(new Error(`probe ${c}`)),
    );
  });
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`${cmd} ${c}`)),
    );
  });
}

async function findMemojiForScene(sceneIdx: number): Promise<string> {
  const files = await fs.readdir(UPLOAD_DIR);
  const target = sceneIdx + 1; // 1-indexed
  // Match filenames ending with `-N.mov` or `-Nmov.mov` (typo seen in input)
  const re = new RegExp(`-${target}(?:mov)?\\.mov$`);
  const found = files.find((f) => re.test(f));
  if (!found) throw new Error(`No Memoji .mov found for scene ${target}`);
  return path.join(UPLOAD_DIR, found);
}

function facePosition(): { x: number; y: number } {
  switch (FACE_POSITION) {
    case "bottom-left":
      return { x: FACE_MARGIN, y: H - FACE_SIZE - FACE_MARGIN };
    case "bottom-right":
      return { x: W - FACE_SIZE - FACE_MARGIN, y: H - FACE_SIZE - FACE_MARGIN };
    case "top-right":
      return { x: W - FACE_SIZE - FACE_MARGIN, y: FACE_MARGIN };
    case "top-left":
      return { x: FACE_MARGIN, y: FACE_MARGIN };
  }
}

/**
 * Pre-render a 280x280 PNG with a white circle on transparent background.
 * Used as an alphamerge mask so the Memoji face shows only inside the
 * circle. Faster than evaluating geq per-frame.
 */
async function buildCircularMaskPng(outFile: string): Promise<void> {
  const canvas = createCanvas(FACE_SIZE, FACE_SIZE);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
  // Fully transparent background by default
  ctx.clearRect(0, 0, FACE_SIZE, FACE_SIZE);
  // Solid white circle (everything inside this becomes opaque after alphamerge)
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE / 2 - 4, 0, Math.PI * 2);
  ctx.fill();
  await fs.writeFile(outFile, await canvas.encode("png"));
}

/**
 * Pre-render a yellow accent ring PNG (transparent inside, accent
 * outside ring). Sits on top of the face for a polished look.
 */
async function buildRingPng(outFile: string): Promise<void> {
  const canvas = createCanvas(FACE_SIZE, FACE_SIZE);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
  ctx.clearRect(0, 0, FACE_SIZE, FACE_SIZE);
  // Soft glow shadow
  ctx.shadowColor = "rgba(255,210,61,0.45)";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = "#ffd23d";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE / 2 - 4, 0, Math.PI * 2);
  ctx.stroke();
  await fs.writeFile(outFile, await canvas.encode("png"));
}

async function compositeSceneWithFace(
  silentSceneClip: string,
  memoji: string,
  maskPng: string,
  ringPng: string,
  outFile: string,
): Promise<void> {
  const pos = facePosition();

  // Voice processing pipeline:
  //   highpass 80Hz : remove low-freq rumble/AC hum
  //   compressor   : even out dynamics
  //   eq           : slight presence boost at 3.5kHz
  //   loudnorm     : -16 LUFS target (well above the -14 broadcast
  //                  default so voice sits comfortably over BGM)
  const filter = [
    // Crop the 640x480 Memoji to a 480x480 square (start at x=80 to center)
    `[1:v]crop=480:480:80:0,scale=${FACE_SIZE}:${FACE_SIZE},setpts=PTS-STARTPTS,format=rgba[face_rgb]`,
    // Mask is white-on-transparent; convert luma to alpha and merge
    `[2:v]format=gray[mask_gray]`,
    `[face_rgb][mask_gray]alphamerge[face_circ]`,
    // Composite: pilot -> face circle -> ring
    `[0:v][face_circ]overlay=${pos.x}:${pos.y}[step1]`,
    `[step1][3:v]overlay=${pos.x}:${pos.y}[v]`,
    // Voice processing
    `[1:a]highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=200:makeup=2,equalizer=f=3500:t=h:width_type=h:width=1500:g=2,loudnorm=I=-16:TP=-1.5:LRA=9[voice]`,
  ].join(";");

  await ffmpeg([
    "-y",
    "-i",
    silentSceneClip,
    "-i",
    memoji,
    "-loop",
    "1",
    "-i",
    maskPng,
    "-loop",
    "1",
    "-i",
    ringPng,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[voice]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outFile,
  ]);
}

async function concatScenes(inputs: string[], outFile: string): Promise<void> {
  const listFile = path.join(OUT_DIR, "concat-final.txt");
  await fs.writeFile(
    listFile,
    inputs.map((f) => `file '${path.resolve(f)}'`).join("\n"),
  );
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
  await fs.unlink(listFile).catch(() => undefined);
}

async function addBgmDucked(
  input: string,
  output: string,
  duration: number,
): Promise<void> {
  // BGM looped to match duration, attenuated, sidechain-ducked under voice
  const filter = [
    `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${duration.toFixed(2)},volume=0.32,afade=t=in:st=0:d=1.5,afade=t=out:st=${(duration - 2).toFixed(2)}:d=2[bgm_pre]`,
    // BGM is sidechain-keyed off the voice track ([0:a]) so it ducks
    // automatically when speech is present.
    `[bgm_pre][0:a]sidechaincompress=threshold=-30dB:ratio=8:attack=10:release=300[bgm_ducked]`,
    `[0:a][bgm_ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[master]`,
  ].join(";");

  await ffmpeg([
    "-y",
    "-i",
    input,
    "-i",
    BGM_FILE,
    "-filter_complex",
    filter,
    "-map",
    "0:v",
    "-map",
    "[master]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    output,
  ]);
}

async function main() {
  // Step 1: Find each Memoji file by scene number, probe duration.
  console.log("-> Probing Memoji files");
  const memojiFiles: string[] = [];
  const memojiDurations: number[] = [];
  for (let i = 0; i < 11; i++) {
    const f = await findMemojiForScene(i);
    const d = await probeDuration(f);
    memojiFiles.push(f);
    memojiDurations.push(d);
    console.log(
      `   Scene ${i + 1}: ${path.basename(f).padEnd(28)} ${d.toFixed(2)}s`,
    );
  }
  const totalDur = memojiDurations.reduce((a, b) => a + b, 0);
  console.log(`-> Total speech duration: ${totalDur.toFixed(2)}s`);

  // Step 2: Update sample-pilot.json so each scene's visual matches its
  // narration length exactly. The script semantics (narration text,
  // scene types, headings) stay identical — only durations change.
  console.log("-> Updating sample-pilot.json durations");
  const scriptRaw = await fs.readFile(PILOT_JSON, "utf-8");
  const script = JSON.parse(scriptRaw);
  for (let i = 0; i < 11; i++) {
    script.scenes[i].durationSeconds = +memojiDurations[i].toFixed(2);
  }
  await fs.writeFile(PILOT_JSON, JSON.stringify(script, null, 2));

  // Step 3: Clear the pilot cache and re-render scene clips so frame
  // counts reflect the new durations.
  console.log("-> Clearing pilot cache");
  for (const dir of ["pilot-clips", "pilot-frames"]) {
    await fs.rm(path.join(OUT_DIR, dir), { recursive: true, force: true });
  }
  for (const f of ["pilot.mp4", "pilot-silent.mp4"]) {
    await fs.rm(path.join(OUT_DIR, f), { force: true });
  }

  console.log("-> Running build-pilot.ts (renders 11 scene clips)");
  await runCmd("npx", ["tsx", "scripts/build-pilot.ts"]);

  // Step 4: Build mask + ring PNGs once, then composite per scene.
  console.log("-> Compositing face PiP + voice per scene");
  const finalDir = path.join(OUT_DIR, "final-clips");
  await ensureDir(finalDir);
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
  const maskPng = path.join(finalDir, "face-mask.png");
  const ringPng = path.join(finalDir, "face-ring.png");
  await buildCircularMaskPng(maskPng);
  await buildRingPng(ringPng);

  const finalClips: string[] = [];
  for (let i = 0; i < 11; i++) {
    const silentClip = path.join(
      OUT_DIR,
      "pilot-clips",
      `${String(i).padStart(2, "0")}.mp4`,
    );
    const memoji = memojiFiles[i];
    const out = path.join(finalDir, `${String(i).padStart(2, "0")}.mp4`);
    const start = Date.now();
    await compositeSceneWithFace(silentClip, memoji, maskPng, ringPng, out);
    console.log(
      `   [${i + 1}/11] ${path.basename(out)}  (${Date.now() - start}ms)`,
    );
    finalClips.push(out);
  }

  // Step 5: Concatenate all per-scene final clips into one video.
  console.log("-> Concatenating scenes");
  const combined = path.join(OUT_DIR, "final-no-bgm.mp4");
  await concatScenes(finalClips, combined);

  // Step 6: Mix BGM under voice with sidechain ducking.
  console.log("-> Mixing BGM with sidechain ducking");
  const finalOut = path.join(OUT_DIR, "final-with-voice.mp4");
  await addBgmDucked(combined, finalOut, totalDur);

  console.log(
    `\nDone -> ${path.relative(ROOT, finalOut)} (${totalDur.toFixed(1)}s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
