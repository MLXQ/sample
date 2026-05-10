/**
 * Builds a 9:16 vertical Shorts cut from the 16:9 final video. Strategy:
 *
 *   1. Pick the most "Shorts-friendly" run of scenes — title + the
 *      two strongest hooks. For our pilot that's:
 *        Scene 1 (title)         10.72s
 *        Scene 2 ($500B+)        10.05s
 *        Scene 5 (Choke Points)   9.00s     ← the hookiest stat
 *        Scene 6 ($400M ASML)    12.68s
 *        Scene 11 (outro)         7.13s
 *      Total ~49.6s, comfortably under YouTube Shorts' 60s cap.
 *   2. Concat just those scenes from out/final-clips/*.mp4 (already
 *      contain face + voice).
 *   3. Letterbox to 1080x1920 with a centered 1080x608 video band
 *      (16:9 fit), leaving large top/bottom black bars for the
 *      mobile-friendly aspect.
 *   4. The Memoji PiP was rendered in the bottom-left of the 16:9
 *      frame; after scaling, it lands inside the visible band, so we
 *      keep it where it is (no further compositing needed).
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OUT_DIR, ROOT, ensureDir, PUBLIC_DIR } from "./lib/paths.js";

// 0-indexed scene picks for the Shorts cut
const SHORTS_SCENES = [0, 1, 4, 5, 10];

const TARGET_W = 1080;
const TARGET_H = 1920;
const BAND_W = 1080;
const BAND_H = Math.round((BAND_W * 9) / 16); // 608

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-1200)}`)),
    );
  });
}

async function main() {
  await ensureDir(path.join(OUT_DIR, "shorts"));

  // Step 1: Concat the picked scenes from out/final-clips into one
  // intermediate 16:9 video that already has voice + face PiP.
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

  // Step 2: probe the intermediate's duration so we can loop BGM correctly
  const probe = spawn("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    intermediate,
  ]);
  let probeOut = "";
  probe.stdout.on("data", (d) => (probeOut += d.toString()));
  await new Promise<void>((resolve, reject) => {
    probe.on("error", reject);
    probe.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`probe ${c}`)),
    );
  });
  const dur = parseFloat(probeOut.trim());
  console.log(`-> Shorts cut duration: ${dur.toFixed(2)}s`);

  // Step 3: scale to 1080x608 (preserve aspect by scaling to 1080 wide),
  // pad to 1080x1920 with black bars top/bottom, re-encode. Voice +
  // BGM already mixed inside the per-scene clips, so we just keep them
  // and add a fresh BGM duck-mix to make the music match the new
  // duration. (Otherwise the BGM bleeds in from the old longer clip
  // mix.) Voice is preserved by sourcing it from the concatenated mp4.
  const final = path.join(ROOT, "demo", "final-shorts.mp4");
  const bgm = path.join(PUBLIC_DIR, "audio", "bgm", "tech.mp3");

  await ffmpeg([
    "-y",
    "-i",
    intermediate,
    "-i",
    bgm,
    "-filter_complex",
    [
      // Scale + pad to 9:16
      `[0:v]scale=${BAND_W}:${BAND_H},pad=${TARGET_W}:${TARGET_H}:0:${(TARGET_H - BAND_H) / 2}:black[v]`,
      // BGM loop + trim + volume + fade
      `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${dur.toFixed(2)},volume=0.30,afade=t=in:st=0:d=1.0,afade=t=out:st=${(dur - 1.5).toFixed(2)}:d=1.5[bgm_pre]`,
      // Sidechain duck against the voice
      `[bgm_pre][0:a]sidechaincompress=threshold=-30dB:ratio=8:attack=10:release=300[bgm_ducked]`,
      // Mix voice + ducked BGM
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
    final,
  ]);

  const stat = await fs.stat(final);
  console.log(
    `-> ${path.relative(ROOT, final)}  ${(stat.size / 1024 / 1024).toFixed(1)} MB  ${dur.toFixed(1)}s  ${TARGET_W}x${TARGET_H}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
