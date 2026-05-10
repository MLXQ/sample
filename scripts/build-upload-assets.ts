/**
 * Generates the upload-ready text bundle for a finished script:
 *   - SRT subtitle file (sentence-level timing, ~5-10 words per cue)
 *   - YouTube chapter markers (one per scene, 00:00 first)
 *   - title / description / tags suggestions
 *
 * Reads data/sample-pilot.json (or any other script). Pushes outputs
 * into demo/.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { OUT_DIR, ROOT, ensureDir, DATA_DIR } from "./lib/paths.js";
import type { Script, Scene } from "../src/types.js";

const PILOT_JSON = path.join(DATA_DIR, "sample-pilot.json");
const OUT_DIR_DEMO = path.join(ROOT, "demo");

function fmtSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function fmtChapterTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0")
    );
  }
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

/**
 * Split narration into shorter sub-cues (~6-10 words each) and
 * distribute time proportional to word count.
 */
function splitToSubcues(
  narration: string,
  sceneStart: number,
  sceneDur: number,
): { text: string; start: number; end: number }[] {
  if (!narration.trim()) return [];
  // Split on sentence-ish boundaries first, then further chunk long sentences.
  const sentences = narration
    .split(/(?<=[.!?—])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const TARGET_WORDS = 9;
  const chunks: string[] = [];
  for (const s of sentences) {
    const words = s.split(/\s+/);
    if (words.length <= TARGET_WORDS + 3) {
      chunks.push(s);
      continue;
    }
    // Break into ~TARGET_WORDS chunks
    for (let i = 0; i < words.length; i += TARGET_WORDS) {
      chunks.push(words.slice(i, i + TARGET_WORDS).join(" "));
    }
  }

  const totalWords = chunks
    .map((c) => c.split(/\s+/).length)
    .reduce((a, b) => a + b, 0);
  let t = sceneStart;
  const out: { text: string; start: number; end: number }[] = [];
  for (const c of chunks) {
    const wc = c.split(/\s+/).length;
    const dur = (wc / totalWords) * sceneDur;
    out.push({ text: c, start: t, end: t + dur });
    t += dur;
  }
  return out;
}

function getSceneLabel(scene: Scene): string {
  switch (scene.type) {
    case "title":
      return "The 12 Layers";
    case "outro":
      return "Next episode";
    case "fact":
      return "Concentration fact";
    case "countUpStat":
      return scene.label ?? "Stat";
    case "stackDiagram":
    case "marketShare":
    case "worldMap":
    case "flowDiagram":
    case "animatedChart":
    case "logoGrid":
    case "timeline":
      return scene.heading;
    case "narration":
      return scene.caption ?? "Narration";
    case "broll":
      return scene.chip ?? "B-roll";
  }
}

async function main() {
  const raw = await fs.readFile(PILOT_JSON, "utf-8");
  const script = JSON.parse(raw) as Script;

  // -------- SRT --------
  const srtLines: string[] = [];
  let cueId = 1;
  let cursor = 0;
  for (const sceneU of script.scenes) {
    const scene = sceneU as Scene & {
      narration?: string;
      durationSeconds?: number;
    };
    const dur = scene.durationSeconds ?? 5;
    const cues = splitToSubcues(scene.narration ?? "", cursor, dur);
    for (const c of cues) {
      srtLines.push(String(cueId));
      srtLines.push(`${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}`);
      srtLines.push(c.text);
      srtLines.push("");
      cueId++;
    }
    cursor += dur;
  }
  const srtPath = path.join(OUT_DIR_DEMO, "final-with-voice.srt");
  await fs.writeFile(srtPath, srtLines.join("\n"));

  // -------- Chapters --------
  const chapterLines: string[] = [];
  let cstart = 0;
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i] as Scene & { durationSeconds?: number };
    const label = getSceneLabel(scene);
    // YouTube requires gap >= 10s; if smaller, merge or skip. Our scenes
    // are mostly >= 7s. Snap first chapter to 00:00 even if scene 1 is
    // slightly longer (YouTube's first-chapter-at-zero rule).
    const t = i === 0 ? 0 : Math.round(cstart);
    chapterLines.push(`${fmtChapterTime(t)} ${label}`);
    cstart += scene.durationSeconds ?? 5;
  }
  const chaptersPath = path.join(OUT_DIR_DEMO, "youtube-chapters.txt");
  await fs.writeFile(chaptersPath, chapterLines.join("\n"));

  // -------- Title / Description / Tags --------
  const totalSec = script.scenes.reduce(
    (a, s) => a + ((s as Scene & { durationSeconds?: number }).durationSeconds ?? 5),
    0,
  );
  const totalMin = Math.floor(totalSec / 60);
  const totalRemSec = Math.round(totalSec - totalMin * 60);

  const descriptionLines: string[] = [
    `Trillions of dollars are flowing into AI — but almost no one understands the actual stack behind it. Twelve layers, four countries, three monopolies. Here's the whole supply chain explained in under two minutes.`,
    ``,
    `From the Dutch lithography giant that no one can replace, to the Korean memory company quietly inside every ChatGPT response, to the foundation labs racing to build superintelligence — this is the map of the AI economy.`,
    ``,
    `📌 CHAPTERS`,
    ...chapterLines,
    ``,
    `📖 SOURCES & FURTHER READING`,
    `- ASML, EUV lithography market: ASML investor relations`,
    `- TSMC global foundry share: TrendForce 2024 reports`,
    `- SK Hynix HBM share: Counterpoint Research`,
    `- AI / data-center energy: IEA 2024 Electricity Report`,
    `- Hyperscaler capex commitments: company earnings calls 2024-2025`,
    ``,
    `🎙 Recorded in iPhone Messages with Memoji. No AI voice — that's me.`,
    `🎵 Background music: original composition, MIDI rendered via FluidR3_GM soundfont.`,
    `🎨 Motion graphics: custom Remotion + ffmpeg pipeline.`,
    ``,
    `🔔 Subscribe — next episode goes inside the Dutch monopoly that controls them all.`,
  ];

  const titleSuggestions = [
    "The 12 Layers of the AI Boom (Explained in 2 Minutes)",
    "Inside the $500B AI Stack: 12 Layers, 4 Countries, 3 Monopolies",
    "Why the AI Economy Lives in Just 4 Countries",
    "The Hidden Map Behind Every ChatGPT Prompt",
  ];

  const tags = [
    "AI",
    "AI infrastructure",
    "AI supply chain",
    "NVIDIA",
    "ASML",
    "TSMC",
    "SK Hynix",
    "AI investing",
    "semiconductor supply chain",
    "AI explained",
    "AI economy",
    "foundation models",
    "OpenAI",
    "Anthropic",
    "data center energy",
    "AI value chain",
    "tech explainer",
    "EUV lithography",
    "HBM memory",
    "AI bubble",
  ];

  const metaLines: string[] = [
    `# Upload metadata — The 12 Layers of the AI Boom`,
    ``,
    `**Length**: ${totalMin}:${String(totalRemSec).padStart(2, "0")} (${totalSec.toFixed(1)}s)`,
    `**Aspect**: 1920x1080 (16:9)`,
    `**Audio**: voice + BGM (sidechain ducked, -14 LUFS-ish)`,
    ``,
    `## Title options (pick one, A/B test if possible)`,
    ...titleSuggestions.map((t, i) => `${i + 1}. ${t}`),
    ``,
    `## Description (copy as-is)`,
    `\`\`\``,
    ...descriptionLines,
    `\`\`\``,
    ``,
    `## Tags (comma-separated for YouTube)`,
    tags.join(", "),
    ``,
    `## Chapter markers (paste into YouTube description — already included above)`,
    `\`\`\``,
    ...chapterLines,
    `\`\`\``,
    ``,
    `## Subtitles`,
    `- demo/final-with-voice.srt — upload as English (CC) on YouTube`,
    ``,
    `## Engagement tips`,
    `- First-3-seconds hook: title scene's narration is the hook line.`,
    `- Pin a comment with one of the most-cited stats (e.g. "ASML's machine costs more than most companies' entire R&D budget").`,
    `- Reply to the first ~20 comments within the first hour to boost ranking.`,
    `- Shorts variant: demo/final-shorts.mp4 (9:16, 60s) — upload separately, link this video in pinned comment.`,
  ];
  const metaPath = path.join(OUT_DIR_DEMO, "youtube-metadata.md");
  await fs.writeFile(metaPath, metaLines.join("\n"));

  console.log(`-> ${path.relative(ROOT, srtPath)} (${cueId - 1} cues)`);
  console.log(`-> ${path.relative(ROOT, chaptersPath)} (${chapterLines.length} chapters)`);
  console.log(`-> ${path.relative(ROOT, metaPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
