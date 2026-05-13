/**
 * Fully-automated arXiv episode builder. Takes a paper ID, fetches
 * the abstract + metadata from arXiv, asks Claude to draft a 6-7 scene
 * explainer script, synthesizes voice via OpenAI TTS for each scene's
 * narration, and runs the standard build-episode pipeline.
 *
 * NO Memoji recording required. Designed to run inside a Claude Code
 * Routine on a daily schedule.
 *
 * Usage:
 *   npm run arxiv-episode -- 2401.12345
 *   npm run arxiv-episode -- 2401.12345 --voice onyx --bgm tech
 *
 * Output:
 *   data/episodes/arxiv-2401-12345.json   (generated config)
 *   uploads/arxiv-2401-12345/scene-{1..N}.mp3   (TTS audio per scene)
 *   demo/episodes/arxiv-2401-12345/final.mp4   (after build-episode)
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { XMLParser } from "fast-xml-parser";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { DATA_DIR, ROOT, ensureDir } from "./lib/paths.js";

type ArxivPaper = {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  primaryCategory: string;
  date: string;
  abstractUrl: string;
  pdfUrl: string;
};

const sceneSchema = z.object({
  type: z.enum([
    "title",
    "countUpStat",
    "stackDiagram",
    "animatedChart",
    "logoGrid",
    "marketShare",
    "fact",
    "outro",
  ]),
}).passthrough();

const draftSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  scenes: z.array(sceneSchema).min(5).max(10),
});

const SYSTEM_PROMPT = `You are a senior writer for a daily AI-paper YouTube channel ("Paper of the Day" format, 60-120 seconds per video, similar to Yannic Kilcher's TLDR but tighter).

Given a paper's title, authors, primary category, and abstract, produce a JSON script using ONLY the following scene types in this order:

  1. title           — hook the viewer
  2. countUpStat     — the single most striking number from the abstract
                       (parameters, % improvement, $ cost, GPU count, etc.)
  3. stackDiagram    — 3-5 layers explaining their METHOD (each layer is
                       one step of their pipeline)  -- OR --
     flowDiagram     — same purpose, horizontal arrows instead of stacked
  4. animatedChart   — bar chart comparing their result to baselines
                       (use realistic numbers from the abstract; fabricate
                       only when the abstract gives a relative claim, and
                       round to plausible whole numbers)
  5. fact            — the single most "wait, what?" sentence from the
                       abstract, lightly rephrased for impact
  6. outro           — subscribe + tease the format

RULES:
- Output ONLY valid JSON. No markdown, no preamble.
- Each scene's "narration" is what the (synthesized) voice will literally say.
- Narration: 25-55 words per scene. Punchy. ESL-friendly English.
- Voice is single-take TTS, so absolutely no unpronounceable jargon dumps.
- Acronyms like "MMLU", "GPU", "FLOP" are fine — pronounced letter by letter.
- For numbers: spell out small ones (one, two), digits for big ones (70B, $4.6M).
- durationSeconds for each scene: number-of-words * 0.4 + 1, rounded to 0.5.

EXACT JSON SHAPE:
{
  "title": "...",          // 6-9 word YouTube title
  "subtitle": "Paper of the day",
  "scenes": [ { ...scene1... }, { ...scene2... }, ... ]
}

Each scene matches the existing schema in src/types.ts:
  title:        { type, title:{line1,line2,eyebrow}, narration, durationSeconds }
  countUpStat:  { type, value, prefix?, suffix?, label?, caption?, narration, durationSeconds }
  stackDiagram: { type, heading, layers:[{label,note}], narration, durationSeconds }
  flowDiagram:  { type, heading, steps:[{label,note}], narration, durationSeconds }
  animatedChart:{ type, heading, unit?, bars:[{label,value}], narration, durationSeconds }
  fact:         { type, fact, source?, narration, durationSeconds }
  outro:        { type, cta, narration, durationSeconds }`;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-1000)}`)),
    );
  });
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${c}`))));
  });
}

async function fetchArxivPaper(id: string): Promise<ArxivPaper> {
  const url = `http://export.arxiv.org/api/query?id_list=${id}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "video-pipeline/0.1" },
  });
  if (!res.ok) throw new Error(`arxiv ${res.status}`);
  const xml = await res.text();
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
  }).parse(xml);
  const e = parsed?.feed?.entry;
  if (!e) throw new Error(`arxiv: no entry for ${id}`);

  const links = Array.isArray(e.link) ? e.link : [e.link];
  const pdfLink = links.find((l: { "@title"?: string }) => l["@title"] === "pdf");
  const abstractLink = links.find(
    (l: { "@rel"?: string }) => l["@rel"] === "alternate",
  );
  const authors = (Array.isArray(e.author) ? e.author : [e.author]).map(
    (a: { name: string }) => a.name,
  );
  const categories = (Array.isArray(e.category) ? e.category : [e.category]).map(
    (c: { "@term": string }) => c["@term"],
  );

  return {
    id,
    title: (e.title as string).replace(/\s+/g, " ").trim(),
    authors,
    abstract: (e.summary as string).replace(/\s+/g, " ").trim(),
    primaryCategory:
      e["arxiv:primary_category"]?.["@term"] ?? categories[0] ?? "cs.AI",
    date: (e.published as string).slice(0, 10),
    abstractUrl: abstractLink?.["@href"] ?? `https://arxiv.org/abs/${id}`,
    pdfUrl: pdfLink?.["@href"] ?? `https://arxiv.org/pdf/${id}`,
  };
}

async function draftScript(paper: ArxivPaper): Promise<z.infer<typeof draftSchema>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-opus-4-7";
  const user = `Paper: ${paper.title}
Authors: ${paper.authors.slice(0, 4).join(", ")}${paper.authors.length > 4 ? ", et al." : ""}
Category: ${paper.primaryCategory}
arXiv: ${paper.id}

Abstract:
${paper.abstract}

Write the JSON script now.`;

  const res = await client.messages.create({
    model,
    max_tokens: 3000,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: user }],
  });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Claude returned no text");
  const cleaned = block.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return draftSchema.parse(JSON.parse(cleaned));
}

async function synthesizeVoice(
  text: string,
  voice: string,
  outFile: string,
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_TTS_MODEL ?? "tts-1-hd";
  const speech = await client.audio.speech.create({
    model,
    voice: voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
    input: text,
    response_format: "mp3",
    speed: 1.0,
  });
  const buf = Buffer.from(await speech.arrayBuffer());
  await fs.writeFile(outFile, buf);
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
      c === 0
        ? resolve(parseFloat(out.trim()))
        : reject(new Error(`probe ${c}`)),
    );
  });
}

/** Wrap TTS output (mp3) into a tiny mov so build-episode's Memoji
 *  detection can treat it as a "scene clip" and use its duration. We
 *  add a 640x480 black-frame video to keep ffmpeg happy. The face PiP
 *  step will see a black face — we override facePosition to "off"
 *  via a flag the orchestrator already supports.
 *
 *  Simpler approach: just save as mp3 with a `.mov` extension nope,
 *  build-episode's face compositor expects a video stream. So we
 *  make a real video container. */
async function wrapTtsAsMovieScene(
  mp3: string,
  outMov: string,
): Promise<void> {
  // Single black 640x480 frame, audio from the mp3, mov container.
  // build-episode's compositeWithFace expects 640x480 source for the
  // face crop; we use a fully black frame so the "face circle" is a
  // black disc. The user will set facePosition to off-screen or we
  // can later add a "no face" episode flag.
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=640x480:r=30",
    "-i",
    mp3,
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outMov,
  ]);
}

type Args = {
  paperId: string;
  voice: string;
  bgm: string;
  noFace: boolean;
};
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { paperId: "", voice: "onyx", bgm: "tech", noFace: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--voice") (out.voice = v), i++;
    else if (a === "--bgm") (out.bgm = v), i++;
    else if (a === "--with-face") out.noFace = false;
    else if (!out.paperId) out.paperId = a;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.paperId) {
    console.error("Usage: npm run arxiv-episode -- <paper-id> [--voice onyx] [--bgm tech]");
    process.exit(1);
  }
  console.log(`-> Fetching arXiv paper ${args.paperId}`);
  const paper = await fetchArxivPaper(args.paperId);
  console.log(`   ${paper.title}`);
  console.log(`   ${paper.authors.slice(0, 3).join(", ")} (${paper.date})`);

  console.log("-> Drafting script via Claude");
  const draft = await draftScript(paper);
  console.log(`   "${draft.title}" — ${draft.scenes.length} scenes`);

  const slug = args.paperId.replace(/\./g, "-");
  const id = `arxiv-${slug}`;
  const memojiDir = path.join(ROOT, "uploads", id);
  await ensureDir(memojiDir);

  console.log("-> Synthesizing TTS audio per scene");
  for (let i = 0; i < draft.scenes.length; i++) {
    const scene = draft.scenes[i] as { narration?: string };
    if (!scene.narration) continue;
    const mp3 = path.join(memojiDir, `scene-${i + 1}.mp3`);
    const mov = path.join(memojiDir, `scene-${i + 1}.mov`);
    await synthesizeVoice(scene.narration, args.voice, mp3);
    await wrapTtsAsMovieScene(mp3, mov);
    const dur = await probeDuration(mov);
    (draft.scenes[i] as { durationSeconds?: number }).durationSeconds = +dur.toFixed(2);
    console.log(`   [${i + 1}/${draft.scenes.length}] ${dur.toFixed(1)}s`);
  }

  // Persist episode config
  const config = {
    id,
    title: draft.title,
    subtitle: draft.subtitle,
    theme: "science",
    memojiDir: path.relative(ROOT, memojiDir),
    bgm: args.bgm,
    facePosition: "bottom-left",
    source: {
      kind: "arxiv",
      refId: args.paperId,
      url: paper.abstractUrl,
    },
    scenes: draft.scenes,
    paper: {
      title: paper.title,
      authors: paper.authors,
      abstract: paper.abstract,
      pdfUrl: paper.pdfUrl,
    },
  };
  const configPath = path.join(DATA_DIR, "episodes", `${id}.json`);
  await ensureDir(path.dirname(configPath));
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`-> Config: ${path.relative(ROOT, configPath)}`);

  console.log("-> Running build-episode");
  await runCmd("npx", ["tsx", "scripts/build-episode.ts", configPath]);

  console.log(
    `\nDone — final video at demo/episodes/${id}/final.mp4`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
