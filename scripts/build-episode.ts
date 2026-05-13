/**
 * Episode orchestrator — turns a single episode config JSON into a
 * fully-rendered upload bundle in demo/<episode-id>/:
 *
 *   final.mp4               main 1080p 16:9 video
 *   shorts.mp4              60s 9:16 cut
 *   thumbnail.jpg           1280x720
 *   final.srt               sentence-level subtitles
 *   chapters.txt            YouTube chapter markers
 *   metadata.md             title / description / tags
 *
 * Config schema (JSON):
 * {
 *   "id": "arxiv-2401-12345",                // becomes the output folder
 *   "title": "...", "subtitle": "...", "theme": "science",
 *   "memojiDir": "uploads/arxiv-2401-12345", // optional; auto-resolved
 *   "bgm": "tech" | "curious" | "dramatic" | "calm" | "path/to/music.mp3",
 *   "facePosition": "bottom-left" | "bottom-right" | "top-right" | "top-left",
 *   "source": { "kind": "arxiv", "refId": "2401.12345", "url": "..." },
 *   "scenes": [ ...standard Scene shapes... ]
 * }
 *
 * Memoji clips are matched per-scene by filename pattern:
 *   scene-1.mov ... scene-N.mov (or *-1.mov, *-2.mov etc).
 *
 * Each Memoji's audio duration overrides that scene's durationSeconds,
 * so the visuals never run ahead of speech. Scenes without a matching
 * Memoji keep their explicit durationSeconds from the config.
 *
 * Usage:
 *   npm run episode -- data/episodes/arxiv-2401-12345.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import {
  OUT_DIR,
  ROOT,
  ensureDir,
  PUBLIC_DIR,
} from "./lib/paths.js";

const W = 1920;
const H = 1080;
const FACE_SIZE = 280;
const FACE_MARGIN = 50;
const BGM_DIR = path.join(PUBLIC_DIR, "audio", "bgm");

type FacePos = "bottom-left" | "bottom-right" | "top-right" | "top-left";

type EpisodeConfig = {
  id: string;
  title: string;
  subtitle?: string;
  theme?: string;
  memojiDir?: string;
  bgm?: string;
  facePosition?: FacePos;
  source?: { kind: string; refId: string; url?: string };
  scenes: Array<Record<string, unknown> & {
    type: string;
    narration?: string;
    durationSeconds?: number;
  }>;
};

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0
        ? resolve()
        : reject(new Error(`ffmpeg ${c}\n${err.slice(-1200)}`)),
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

function facePosition(pos: FacePos): { x: number; y: number } {
  switch (pos) {
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

async function findMemojiClip(
  dir: string,
  sceneIndex: number,
): Promise<string | null> {
  try {
    const files = await fs.readdir(dir);
    const sceneNum = sceneIndex + 1;
    // Match `scene-N.mov`, `*-N.mov`, `*-Nmov.mov` (typo seen before)
    const patterns = [
      new RegExp(`^scene-${sceneNum}\\.mov$`),
      new RegExp(`-${sceneNum}(?:mov)?\\.mov$`),
    ];
    for (const re of patterns) {
      const m = files.find((f) => re.test(f));
      if (m) return path.join(dir, m);
    }
  } catch {
    // dir doesn't exist
  }
  return null;
}

function resolveBgm(bgm: string | undefined): string {
  if (!bgm) return path.join(BGM_DIR, "tech.mp3");
  // If it looks like a path, use as-is. Otherwise treat as mood name.
  if (bgm.endsWith(".mp3") || bgm.endsWith(".wav") || bgm.endsWith(".m4a")) {
    return path.isAbsolute(bgm) ? bgm : path.resolve(ROOT, bgm);
  }
  return path.join(BGM_DIR, `${bgm}.mp3`);
}

async function compositeWithFace(
  baseClip: string,
  memojiClip: string | null,
  pos: { x: number; y: number },
  duration: number,
  outFile: string,
  useSourceAudio: boolean,
): Promise<void> {
  const radius = FACE_SIZE / 2 - 4;

  if (!memojiClip) {
    // No face — just trim base clip to duration and apply consistent
    // encoding so concat can copy without re-encoding. If we're not
    // using the source's audio (e.g. canvas-rendered card scene with
    // no Memoji), inject a silent stereo AAC track so every clip in
    // the concat list has the same stream layout.
    if (useSourceAudio) {
      await ffmpeg([
        "-y",
        "-i",
        baseClip,
        "-t",
        String(duration),
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
        outFile,
      ]);
    } else {
      // Silent: synthesize a stereo silence track to match every other
      // scene's audio layout. Lets us hard-cut concat with -c copy.
      await ffmpeg([
        "-y",
        "-i",
        baseClip,
        "-f",
        "lavfi",
        "-t",
        String(duration),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-t",
        String(duration),
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
    return;
  }

  // With face overlay
  const filter = [
    `[1:v]crop=480:480:80:0,scale=${FACE_SIZE}:${FACE_SIZE},setpts=PTS-STARTPTS,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-${FACE_SIZE / 2},Y-${FACE_SIZE / 2}),${radius}),255,0)'[face]`,
    `[0:v][face]overlay=${pos.x}:${pos.y}[v]`,
    `[1:a]highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=200:makeup=2,equalizer=f=3500:t=h:width_type=h:width=1500:g=2,volume=1.6,dynaudnorm=p=0.71[voice]`,
  ].join(";");

  await ffmpeg([
    "-y",
    "-i",
    baseClip,
    "-i",
    memojiClip,
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

async function renderSourceClip(
  scene: {
    file: string;
    trimStart?: number;
    trimEnd?: number;
    caption?: string;
    source?: string;
    /** Optional path to ASS subtitle file to burn in. */
    subs?: string;
  },
  outFile: string,
  durationSeconds: number,
): Promise<void> {
  const src = path.isAbsolute(scene.file)
    ? scene.file
    : path.resolve(ROOT, scene.file);
  const ss = scene.trimStart ?? 0;
  // Build caption overlay PNG if needed
  const overlay = await buildSourceClipOverlay(scene);

  // Inputs: video, optional overlay PNG
  const args: string[] = ["-y", "-ss", String(ss), "-i", src];
  if (overlay) args.push("-loop", "1", "-i", overlay);

  // Filter chain — start with scale+crop+trim, optionally chain
  // subtitle burn-in (must come BEFORE overlay so subs sit beneath
  // the caption/source-chip overlay), then overlay.
  const subFilter = scene.subs
    ? `,subtitles='${scene.subs.replace(/'/g, "\\'")}'`
    : "";
  const filter = overlay
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},trim=duration=${durationSeconds.toFixed(2)},setpts=PTS-STARTPTS${subFilter}[base];[base][1:v]overlay=0:0[v]`
    : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},trim=duration=${durationSeconds.toFixed(2)},setpts=PTS-STARTPTS${subFilter}[v]`;

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-t",
    String(durationSeconds),
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

async function buildSourceClipOverlay(scene: { caption?: string; source?: string }): Promise<string | null> {
  if (!scene.caption && !scene.source) return null;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
  ctx.clearRect(0, 0, W, H);

  // Bottom gradient for caption readability
  const grad = ctx.createLinearGradient(0, H * 0.55, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.6, "rgba(0,0,0,0.6)");
  grad.addColorStop(1, "rgba(0,0,0,0.9)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);

  if (scene.source) {
    ctx.font = '800 28px "Inter", system-ui, sans-serif';
    const text = scene.source.toUpperCase().split("").join(" ");
    const w = ctx.measureText(text).width + 36;
    ctx.fillStyle = "#ffd23d";
    ctx.fillRect(80, 80, w, 50);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillText(text, 98, 114);
  }
  if (scene.caption) {
    ctx.fillStyle = "#fff";
    ctx.font = '700 48px "Inter", system-ui, sans-serif';
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = 20;
    ctx.fillText(scene.caption, 80, H - 100);
    ctx.shadowColor = "transparent";
  }
  const tmpDir = await fs.mkdtemp(path.join(OUT_DIR, "source-overlay-"));
  const file = path.join(tmpDir, "overlay.png");
  await fs.writeFile(file, await canvas.encode("png"));
  return file;
}

async function main() {
  const argv = process.argv.slice(2);
  const configPath = argv[0];
  if (!configPath) {
    console.error("Usage: npm run episode -- <episode-config.json>");
    process.exit(1);
  }
  const raw = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as EpisodeConfig;
  console.log(`-> Episode: ${config.id} — ${config.title}`);

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

  const facePos = facePosition(config.facePosition ?? "bottom-left");
  const memojiDir = config.memojiDir
    ? path.resolve(ROOT, config.memojiDir)
    : path.resolve(ROOT, "uploads", config.id);

  // Step 1: Map Memoji clips, update durations to match
  console.log("-> Probing Memoji clips");
  const memojiByScene: (string | null)[] = [];
  for (let i = 0; i < config.scenes.length; i++) {
    const f = await findMemojiClip(memojiDir, i);
    memojiByScene.push(f);
    if (f) {
      const d = await probeDuration(f);
      config.scenes[i].durationSeconds = +d.toFixed(2);
      console.log(`   [${i + 1}] ${path.basename(f)}  ${d.toFixed(2)}s`);
    } else {
      console.log(`   [${i + 1}] (no memoji — using configured ${config.scenes[i].durationSeconds ?? "?"}s)`);
    }
  }

  // Step 2: Persist updated scenes to a temp file so build-pilot can read it
  const episodeDir = path.join(OUT_DIR, "episodes", config.id);
  await ensureDir(episodeDir);
  const renderJson = path.join(ROOT, "data", "episodes", `${config.id}.render.json`);
  await ensureDir(path.dirname(renderJson));
  await fs.writeFile(renderJson, JSON.stringify(config, null, 2));

  // Step 3: Render visual clips per scene. For non-sourceClip scenes,
  // delegate to build-pilot (it does title / countUpStat / etc.). For
  // sourceClip, render directly with ffmpeg.
  console.log("-> Rendering scene visuals");
  const sceneClipsDir = path.join(episodeDir, "scene-clips");
  await ensureDir(sceneClipsDir);

  // For canvas-rendered scenes, we need to call build-pilot with this
  // config. Easiest: temporarily point build-pilot at our render json.
  // build-pilot reads data/sample-pilot.json hard-coded; we use a
  // small wrapper trick — write the render json to sample-pilot.json
  // location only if --use-config flag is added later. For now we
  // require build-pilot to support a config path. Falling back: copy
  // our render json over sample-pilot.json briefly, then restore.
  // (Cleaner refactor lives in a follow-up commit.)
  const pilotPath = path.join(ROOT, "data", "sample-pilot.json");
  const pilotBackup = await fs.readFile(pilotPath, "utf-8");
  try {
    await fs.writeFile(pilotPath, JSON.stringify(config, null, 2));
    // Clear pilot cache so it re-renders with our durations
    await fs.rm(path.join(OUT_DIR, "pilot-clips"), { recursive: true, force: true });
    await fs.rm(path.join(OUT_DIR, "pilot-frames"), { recursive: true, force: true });
    await fs.rm(path.join(OUT_DIR, "pilot.mp4"), { force: true });
    await fs.rm(path.join(OUT_DIR, "pilot-silent.mp4"), { force: true });
    await runCmd("npx", ["tsx", "scripts/build-pilot.ts"]);
  } finally {
    // Restore the original sample-pilot.json
    await fs.writeFile(pilotPath, pilotBackup);
  }

  // build-pilot wrote per-scene clips to out/pilot-clips/NN.mp4. For
  // sourceClip scenes we need to overwrite those with the actual
  // source-clip render.
  for (let i = 0; i < config.scenes.length; i++) {
    const scene = config.scenes[i];
    if (scene.type === "sourceClip") {
      const dur = scene.durationSeconds ?? 5;
      const target = path.join(
        OUT_DIR,
        "pilot-clips",
        `${String(i).padStart(2, "0")}.mp4`,
      );
      await renderSourceClip(
        scene as unknown as { file: string; trimStart?: number; trimEnd?: number; caption?: string; source?: string },
        target,
        dur,
      );
      console.log(`   [${i + 1}] sourceClip rendered`);
    }
  }

  // Step 4: For each scene, composite face PiP + voice (or use source audio for sourceClip)
  console.log("-> Compositing face PiP + voice per scene");
  const finalClipsDir = path.join(OUT_DIR, "final-clips");
  await fs.rm(finalClipsDir, { recursive: true, force: true });
  await ensureDir(finalClipsDir);
  const finalClips: string[] = [];
  for (let i = 0; i < config.scenes.length; i++) {
    const scene = config.scenes[i];
    const silent = path.join(
      OUT_DIR,
      "pilot-clips",
      `${String(i).padStart(2, "0")}.mp4`,
    );
    const out = path.join(finalClipsDir, `${String(i).padStart(2, "0")}.mp4`);
    const dur = scene.durationSeconds ?? 5;
    const memoji = memojiByScene[i];
    const useSourceAudio =
      scene.type === "sourceClip" && !(scene as { muteSourceAudio?: boolean }).muteSourceAudio && !memoji;
    await compositeWithFace(silent, memoji, facePos, dur, out, useSourceAudio);
    finalClips.push(out);
    console.log(`   [${i + 1}] ${path.basename(out)}`);
  }

  // Step 5: Concat (hard cuts; no xfade)
  console.log("-> Concatenating");
  const concatList = path.join(episodeDir, "concat.txt");
  await fs.writeFile(
    concatList,
    finalClips.map((f) => `file '${path.resolve(f)}'`).join("\n"),
  );
  const noBgm = path.join(episodeDir, "final-no-bgm.mp4");
  await ffmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatList,
    "-c",
    "copy",
    noBgm,
  ]);

  // Step 6: Mix BGM
  console.log("-> Mixing BGM");
  const totalDur = config.scenes.reduce(
    (a, s) => a + (s.durationSeconds ?? 5),
    0,
  );
  const bgm = resolveBgm(config.bgm);
  const final = path.join(episodeDir, "final.mp4");
  await ffmpeg([
    "-y",
    "-i",
    noBgm,
    "-i",
    bgm,
    "-filter_complex",
    [
      `[0:a]aformat=channel_layouts=stereo,asplit=2[voice_main][voice_sc]`,
      `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${totalDur.toFixed(2)},volume=0.30,afade=t=in:st=0:d=1.5,afade=t=out:st=${(totalDur - 2).toFixed(2)}:d=2[bgm_pre]`,
      `[bgm_pre][voice_sc]sidechaincompress=threshold=-30dB:ratio=8:attack=10:release=300[bgm_ducked]`,
      `[voice_main][bgm_ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[master]`,
    ].join(";"),
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
    final,
  ]);

  // Step 7: Copy to demo/<episode-id>/ + run downstream artifact builders
  const demoDir = path.join(ROOT, "demo", "episodes", config.id);
  await ensureDir(demoDir);
  await fs.copyFile(final, path.join(demoDir, "final.mp4"));

  console.log(
    `\nDone -> ${path.relative(ROOT, path.join(demoDir, "final.mp4"))} (${totalDur.toFixed(1)}s)`,
  );
  console.log(
    `Next: thumbnail / Shorts / metadata builders (run separately, or extend this script).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
