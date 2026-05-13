/**
 * Whisper transcription wrapper. Takes a local audio/video file,
 * extracts mono 16kHz audio via ffmpeg, chunks if needed (Whisper API
 * caps at 25 MB per request), POSTs each chunk to OpenAI's
 * /v1/audio/transcriptions endpoint with verbose_json so we get
 * segment-level timestamps, and emits a single combined transcript
 * JSON with stitched timestamps.
 *
 * Output schema:
 *   {
 *     "language": "english",
 *     "duration": 1234.5,
 *     "text": "full transcript ...",
 *     "segments": [
 *       { "start": 0.0, "end": 4.5, "text": "..." },
 *       ...
 *     ]
 *   }
 *
 * Usage:
 *   npm run transcribe -- path/to/hearing.mp4 [output.json]
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const CHUNK_SECONDS = 600; // 10-minute chunks at 16kHz mono mp3 ≈ 5 MB
const SAMPLE_RATE = 16000;

type WhisperSegment = {
  start: number;
  end: number;
  text: string;
};

type Transcript = {
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
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

async function extractAudio(input: string, outDir: string): Promise<string[]> {
  // Extract a single mono 16kHz mp3, then split into CHUNK_SECONDS slices
  // using ffmpeg's segment muxer.
  const pattern = path.join(outDir, "chunk-%03d.mp3");
  await ffmpeg([
    "-y",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-b:a",
    "64k",
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    "-reset_timestamps",
    "1",
    pattern,
  ]);
  const files = (await fs.readdir(outDir))
    .filter((f) => f.startsWith("chunk-") && f.endsWith(".mp3"))
    .sort()
    .map((f) => path.join(outDir, f));
  return files;
}

async function transcribeChunk(
  client: OpenAI,
  file: string,
): Promise<Transcript> {
  // Use the Node-friendly fs.ReadStream via the toFile helper
  const stream = await fs.readFile(file);
  // OpenAI SDK accepts a Buffer wrapped via the `toFile` helper
  const buf = new File(
    [new Uint8Array(stream)],
    path.basename(file),
    { type: "audio/mpeg" },
  );
  const res = (await client.audio.transcriptions.create({
    file: buf,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  })) as unknown as Transcript;
  return res;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY missing in env. Copy .env.example to .env.");
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const inputPath = argv[0];
  const outPath = argv[1];
  if (!inputPath) {
    console.error("Usage: npm run transcribe -- <audio-or-video-file> [output.json]");
    process.exit(1);
  }
  const absInput = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(ROOT, inputPath);
  const inputName = path.basename(absInput, path.extname(absInput));

  const workDir = path.join(OUT_DIR, "transcripts", inputName);
  await ensureDir(workDir);
  const audioDir = path.join(workDir, "audio");
  await fs.rm(audioDir, { recursive: true, force: true });
  await ensureDir(audioDir);

  console.log(`-> Input: ${path.relative(ROOT, absInput)}`);
  const dur = await probeDuration(absInput);
  console.log(`   Duration: ${(dur / 60).toFixed(1)} min`);

  console.log(`-> Extracting audio + chunking (${CHUNK_SECONDS}s each)`);
  const chunks = await extractAudio(absInput, audioDir);
  console.log(`   ${chunks.length} chunks`);

  const client = new OpenAI({ apiKey });
  const segments: WhisperSegment[] = [];
  const textParts: string[] = [];
  let language = "english";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const offset = i * CHUNK_SECONDS;
    console.log(
      `   [${i + 1}/${chunks.length}] whisper: ${path.basename(chunk)}`,
    );
    const t = await transcribeChunk(client, chunk);
    language = t.language;
    textParts.push(t.text);
    for (const s of t.segments ?? []) {
      segments.push({
        start: +(s.start + offset).toFixed(3),
        end: +(s.end + offset).toFixed(3),
        text: s.text.trim(),
      });
    }
  }

  const transcript: Transcript = {
    language,
    duration: dur,
    text: textParts.join(" "),
    segments,
  };

  const finalOut = outPath
    ? path.isAbsolute(outPath)
      ? outPath
      : path.resolve(ROOT, outPath)
    : path.join(workDir, "transcript.json");
  await fs.writeFile(finalOut, JSON.stringify(transcript, null, 2));
  console.log(
    `\nDone -> ${path.relative(ROOT, finalOut)}  (${segments.length} segments)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
