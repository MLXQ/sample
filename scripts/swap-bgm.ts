/**
 * Swaps the BGM of the finished AI pilot with a user-supplied music
 * file. Takes the existing voice-only backbone (out/final-no-bgm.mp4)
 * and re-mixes the user's music underneath the voice with sidechain
 * ducking. Also re-renders the 9:16 Shorts cut with the same music.
 *
 * Usage:
 *   npm run swap-bgm -- <path-to-music.mp3> [bgm-volume]
 *
 *   bgm-volume defaults to 0.30 (30%). Range typically 0.15-0.45.
 *
 * Output:
 *   demo/final-with-voice.mp4
 *   demo/final-shorts.mp4
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OUT_DIR, ROOT, ensureDir, PUBLIC_DIR } from "./lib/paths.js";

const SHORTS_SCENES = [0, 1, 4, 5, 10];
const TARGET_W = 1080;
const TARGET_H = 1920;
const BAND_W = 1080;
const BAND_H = Math.round((BAND_W * 9) / 16);

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

async function remixWithBgm(
  voiceVideo: string,
  bgm: string,
  duration: number,
  bgmVolume: number,
  outFile: string,
): Promise<void> {
  await ffmpeg([
    "-y",
    "-i",
    voiceVideo,
    "-i",
    bgm,
    "-filter_complex",
    [
      `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${duration.toFixed(2)},volume=${bgmVolume},afade=t=in:st=0:d=1.5,afade=t=out:st=${(duration - 2).toFixed(2)}:d=2[bgm_pre]`,
      `[bgm_pre][0:a]sidechaincompress=threshold=-30dB:ratio=8:attack=10:release=300[bgm_ducked]`,
      `[0:a][bgm_ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[master]`,
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
    outFile,
  ]);
}

async function buildShortsWithBgm(bgm: string, bgmVolume: number, outFile: string): Promise<void> {
  await ensureDir(path.join(OUT_DIR, "shorts"));
  // Concat the picked scenes from final-clips (voice + face PiP, no BGM).
  const listFile = path.join(OUT_DIR, "shorts", "concat.txt");
  const lines = SHORTS_SCENES.map(
    (i) =>
      `file '${path.resolve(OUT_DIR, "final-clips", `${String(i).padStart(2, "0")}.mp4`)}'`,
  );
  await fs.writeFile(listFile, lines.join("\n"));
  const intermediate = path.join(OUT_DIR, "shorts", "169.mp4");
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
    intermediate,
  ]);
  const dur = await probeDuration(intermediate);

  await ffmpeg([
    "-y",
    "-i",
    intermediate,
    "-i",
    bgm,
    "-filter_complex",
    [
      `[0:v]scale=${BAND_W}:${BAND_H},pad=${TARGET_W}:${TARGET_H}:0:${(TARGET_H - BAND_H) / 2}:black[v]`,
      `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${dur.toFixed(2)},volume=${bgmVolume},afade=t=in:st=0:d=1.0,afade=t=out:st=${(dur - 1.5).toFixed(2)}:d=1.5[bgm_pre]`,
      `[bgm_pre][0:a]sidechaincompress=threshold=-30dB:ratio=8:attack=10:release=300[bgm_ducked]`,
      `[0:a][bgm_ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[master]`,
    ].join(";"),
    "-map",
    "[v]",
    "-map",
    "[master]",
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

async function main() {
  const argv = process.argv.slice(2);
  const userBgm = argv[0];
  const bgmVolume = argv[1] ? parseFloat(argv[1]) : 0.3;
  if (!userBgm) {
    console.error("Usage: npm run swap-bgm -- <path-to-music.mp3|wav|m4a> [bgm-volume]");
    console.error("  bgm-volume defaults to 0.30 (range typically 0.15-0.45)");
    process.exit(1);
  }
  // Resolve relative paths against project root if not absolute.
  const bgmPath = path.isAbsolute(userBgm)
    ? userBgm
    : path.resolve(ROOT, userBgm);
  try {
    await fs.access(bgmPath);
  } catch {
    console.error(`Music file not found: ${bgmPath}`);
    process.exit(1);
  }
  const bgmDur = await probeDuration(bgmPath);
  console.log(
    `-> Using BGM ${path.basename(bgmPath)} (${bgmDur.toFixed(1)}s, volume=${bgmVolume})`,
  );

  // Main video
  const voiceVideo = path.join(OUT_DIR, "final-no-bgm.mp4");
  try {
    await fs.access(voiceVideo);
  } catch {
    console.error(
      `Missing ${path.relative(ROOT, voiceVideo)} — run npm run final first to produce the voice-only backbone.`,
    );
    process.exit(1);
  }
  const videoDur = await probeDuration(voiceVideo);
  const finalOut = path.join(ROOT, "demo", "final-with-voice.mp4");
  console.log(`-> Remixing main video (${videoDur.toFixed(1)}s)`);
  await remixWithBgm(voiceVideo, bgmPath, videoDur, bgmVolume, finalOut);
  console.log(`   ${path.relative(ROOT, finalOut)}`);

  // Shorts
  console.log("-> Re-rendering Shorts cut");
  const shortsOut = path.join(ROOT, "demo", "final-shorts.mp4");
  await buildShortsWithBgm(bgmPath, bgmVolume, shortsOut);
  console.log(`   ${path.relative(ROOT, shortsOut)}`);

  console.log(`\nDone. Listen and tweak bgm-volume if needed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
