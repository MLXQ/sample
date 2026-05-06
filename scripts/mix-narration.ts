/**
 * Final-mile script: takes the silent video backbone + user's voiceover
 * recording + procedural BGM and produces the upload-ready MP4 with
 * proper audio levels.
 *
 * Audio chain:
 *   - Voiceover: highpass 80Hz, deesser-ish (mild presence cut), light
 *     compressor, leveled to -16 LUFS-ish
 *   - BGM: looped to match video length, low-passed slightly so it sits
 *     under the voice, sidechained against the voice (ducks -8dB when
 *     the user is speaking)
 *   - Final mix: voice + ducked BGM, encoded as AAC 192k
 *
 * Usage:
 *   npm run mix -- <path-to-voice.mp3> [<path-to-silent.mp4>] [<bgm-mood>]
 *
 *   Defaults: silent = out/preview-final-silent.mp4
 *             bgm-mood = curious
 *
 * Output: out/preview-final-with-voice.mp4
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OUT_DIR, ROOT, PUBLIC_DIR } from "./lib/paths.js";

const BGM_DIR = path.join(PUBLIC_DIR, "audio", "bgm");

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)),
    );
  });
}

async function probeDuration(file: string): Promise<number> {
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
      c === 0 ? resolve(parseFloat(out.trim())) : reject(new Error(`probe ${c}`)),
    );
  });
}

async function main() {
  const args = process.argv.slice(2);
  const voicePath = args[0];
  const silentPath = args[1] ?? path.join(OUT_DIR, "preview-final-silent.mp4");
  const mood = args[2] ?? "curious";
  if (!voicePath) {
    console.error("Usage: npm run mix -- <voice.mp3> [silent.mp4] [bgm-mood]");
    console.error("  bgm-mood: curious | dramatic | calm");
    process.exit(1);
  }

  const bgmPath = path.join(BGM_DIR, `${mood}.mp3`);
  for (const f of [voicePath, silentPath, bgmPath]) {
    try {
      await fs.access(f);
    } catch {
      console.error(`Missing file: ${f}`);
      process.exit(1);
    }
  }

  const videoDur = await probeDuration(silentPath);
  console.log(`-> Video: ${videoDur.toFixed(2)}s`);

  const out = path.join(OUT_DIR, "preview-final-with-voice.mp4");

  // ffmpeg complex filter:
  //   [voice] -> highpass + compressor + loudnorm   -> [voice_clean]
  //   [bgm]   -> aloop -> volume + lowpass          -> [bgm_pre]
  //   [bgm_pre] sidechained by [voice_clean]       -> [bgm_ducked]
  //   amix [voice_clean][bgm_ducked]               -> [aout]
  // Then mux video + aout
  //
  // sidechaincompress: ratio 4, threshold -28dB, attack 5ms, release 250ms
  const filter = [
    // Voice processing
    "[1:a]highpass=f=80,acompressor=threshold=-20dB:ratio=3:attack=5:release=180:makeup=2,volume=1.4,asplit=2[voice_main][voice_sc]",

    // BGM: loop, trim to video duration, attenuate, lowpass slightly
    `[2:a]aloop=loop=-1:size=2e9,atrim=duration=${videoDur.toFixed(3)},volume=0.42,lowpass=f=8500,afade=t=in:st=0:d=1.5,afade=t=out:st=${(videoDur - 2).toFixed(2)}:d=2[bgm_pre]`,

    // Sidechain duck BGM with voice
    "[bgm_pre][voice_sc]sidechaincompress=threshold=-30dB:ratio=8:attack=10:release=300:makeup=0[bgm_ducked]",

    // Mix
    "[voice_main][bgm_ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aout]",
  ].join(";");

  await ffmpeg([
    "-y",
    "-i",
    silentPath,
    "-i",
    voicePath,
    "-i",
    bgmPath,
    "-filter_complex",
    filter,
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    out,
  ]);

  console.log(`\nDone -> ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
