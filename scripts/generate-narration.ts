import "dotenv/config";
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { GeneratedScript } from "./lib/script-schema.js";
import { AUDIO_DIR, ensureDir } from "./lib/paths.js";

const FALLBACK_WPM = 150;

/** Read mp3 duration in seconds via ffprobe. Bundled with Remotion's renderer. */
function probeDurationSeconds(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err}`));
      const n = parseFloat(out.trim());
      if (!isFinite(n)) return reject(new Error(`bad duration: ${out}`));
      resolve(n);
    });
    child.on("error", reject);
  });
}

function estimateSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2.5, (words / FALLBACK_WPM) * 60 + 0.5);
}

export async function generateNarrationForScript(
  script: GeneratedScript,
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env.");
  }
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_TTS_MODEL ?? "tts-1-hd";
  const voice = (process.env.OPENAI_TTS_VOICE ?? "onyx") as
    | "alloy"
    | "echo"
    | "fable"
    | "onyx"
    | "nova"
    | "shimmer";

  await ensureDir(AUDIO_DIR);

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const sceneAny = scene as Record<string, unknown> & {
      audio?: string;
      durationSeconds?: number;
      narration: string;
    };
    const filename = `${i.toString().padStart(2, "0")}.mp3`;
    const outFile = path.join(AUDIO_DIR, filename);

    console.log(
      `  > [${i + 1}/${script.scenes.length}] TTS (${scene.narration.split(/\s+/).length} words)`,
    );

    const speech = await client.audio.speech.create({
      model,
      voice,
      input: scene.narration,
      response_format: "mp3",
      speed: 1.0,
    });
    const buf = Buffer.from(await speech.arrayBuffer());
    await fs.writeFile(outFile, buf);

    let seconds: number;
    try {
      seconds = await probeDurationSeconds(outFile);
    } catch {
      seconds = estimateSeconds(scene.narration);
    }
    // Add half-second tail for breathing room between scenes.
    sceneAny.audio = filename;
    sceneAny.durationSeconds = +(seconds + 0.5).toFixed(2);
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run narrate -- <path-to-script.json>");
    process.exit(1);
  }
  const raw = await fs.readFile(file, "utf-8");
  const script = JSON.parse(raw) as GeneratedScript;
  await generateNarrationForScript(script);
  await fs.writeFile(file, JSON.stringify(script, null, 2), "utf-8");
  console.log(`-> Updated ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
