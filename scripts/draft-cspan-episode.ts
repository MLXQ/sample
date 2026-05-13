/**
 * Generates an episode config JSON from a C-SPAN analysis directory.
 * Reads moments.json + transcript.json, asks Claude to write the
 * surrounding commentary (intro, transitions between clips, outro),
 * and stitches everything into a scene list our build-episode
 * pipeline can render.
 *
 * Expected analysis directory layout (produced by transcribe + find-moments):
 *   <dir>/transcript.json
 *   <dir>/moments.json
 *   <dir>/source.mp4               (optional — if present, becomes the
 *                                    file path used in sourceClip scenes)
 *
 * Usage:
 *   npm run draft-cspan-episode -- out/transcripts/altman-hearing/
 *
 * Output:
 *   data/episodes/cspan-<slug>.json   ← review + edit before building
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ROOT, DATA_DIR, slugify } from "./lib/paths.js";

type Moment = {
  rank: number;
  startSeconds: number;
  endSeconds: number;
  speaker?: string;
  quote: string;
  whyItMatters: string;
  commentaryAngle: string;
  shockScore: number;
};

type Transcript = {
  duration: number;
  text: string;
  segments: { start: number; end: number; text: string }[];
};

const commentarySchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  intro: z.object({
    titleLine1: z.string(),
    titleLine2: z.string(),
    eyebrow: z.string(),
    narration: z.string(),
  }),
  // One commentary block per moment — the host's reaction RIGHT AFTER each clip
  reactions: z
    .array(
      z.object({
        forMomentRank: z.number(),
        narration: z.string(),
      }),
    )
    .min(1),
  outro: z.object({
    cta: z.string(),
    narration: z.string(),
  }),
});

const SYSTEM_PROMPT = `You are a senior YouTube writer for a cinematic AI/tech analysis channel. You are given a set of clips (verbatim quotes from a C-SPAN hearing) plus the host's intended commentary angle for each. Your job is to write the SURROUNDING narration that the host will speak in their own voice (a Memoji avatar in the corner of the screen).

Structure of the resulting video:
  Scene 1 — Title card (host intro)
  Scene 2 — Source clip #1 plays
  Scene 3 — Host reaction to clip #1
  Scene 4 — Source clip #2 plays
  Scene 5 — Host reaction to clip #2
  ...
  Scene N-1 — Source clip #last plays
  Scene N   — Host outro (sub + next-episode tease)

Write only the host-spoken parts. Keep each narration to 25-50 words. Voice: confident, slightly dry, anti-establishment but factual. ESL-friendly English. No filler. No hedging.

OUTPUT JSON SHAPE:
{
  "title": "...",                    // 6-9 word YouTube title
  "subtitle": "Explained in 3 minutes",
  "intro": {
    "titleLine1": "...",             // first line of on-screen title
    "titleLine2": "...",             // second line
    "eyebrow": "Why I covered this", // small label
    "narration": "..."               // 30-40 words host-spoken intro
  },
  "reactions": [
    { "forMomentRank": 1, "narration": "..." },  // 25-50 words reaction
    ...
  ],
  "outro": {
    "cta": "Next: X.",
    "narration": "..."
  }
}

Only valid JSON, no preamble.`;

async function writeCommentary(
  moments: Moment[],
  topic: string,
): Promise<z.infer<typeof commentarySchema>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-opus-4-7";

  const momentLines = moments.map(
    (m) =>
      `Clip #${m.rank} — ${m.speaker ?? "speaker"} (shock ${m.shockScore.toFixed(1)}):\n  Quote: "${m.quote}"\n  Why: ${m.whyItMatters}\n  Host angle: ${m.commentaryAngle}`,
  );
  const user = `Topic: ${topic}\n\n${momentLines.join("\n\n")}\n\nWrite the host narration.`;

  const res = await client.messages.create({
    model,
    max_tokens: 3000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Claude returned no text");
  const cleaned = block.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return commentarySchema.parse(JSON.parse(cleaned));
}

async function main() {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) {
    console.error("Usage: npm run draft-cspan-episode -- <analysis-dir>");
    process.exit(1);
  }
  const absDir = path.isAbsolute(dir) ? dir : path.resolve(ROOT, dir);
  const transcript = JSON.parse(
    await fs.readFile(path.join(absDir, "transcript.json"), "utf-8"),
  ) as Transcript;
  const moments = (
    JSON.parse(
      await fs.readFile(path.join(absDir, "moments.json"), "utf-8"),
    ) as { moments: Moment[] }
  ).moments.sort((a, b) => a.startSeconds - b.startSeconds);

  const sourceFile = await (async () => {
    try {
      await fs.access(path.join(absDir, "source.mp4"));
      return path.relative(ROOT, path.join(absDir, "source.mp4"));
    } catch {
      // Look for first mp4 in dir
      const files = await fs.readdir(absDir);
      const mp4 = files.find((f) => f.endsWith(".mp4"));
      return mp4 ? path.relative(ROOT, path.join(absDir, mp4)) : "REPLACE_WITH_SOURCE_MP4_PATH";
    }
  })();

  const topic = `C-SPAN hearing (${(transcript.duration / 60).toFixed(0)} min, ${moments.length} clips chosen)`;
  console.log(`-> Writing commentary for ${moments.length} clips via Claude`);
  const commentary = await writeCommentary(moments, topic);

  // Build episode config
  const slug = slugify(commentary.title);
  const id = `cspan-${slug}`;
  const scenes: unknown[] = [];

  // Scene 1: title
  scenes.push({
    type: "title",
    title: {
      line1: commentary.intro.titleLine1,
      line2: commentary.intro.titleLine2,
      eyebrow: commentary.intro.eyebrow,
    },
    narration: commentary.intro.narration,
    durationSeconds: 10,
  });

  // Alternating sourceClip + narration reaction
  for (const m of moments) {
    const dur = +(m.endSeconds - m.startSeconds).toFixed(2);
    scenes.push({
      type: "sourceClip",
      file: sourceFile,
      trimStart: +m.startSeconds.toFixed(2),
      trimEnd: +m.endSeconds.toFixed(2),
      caption: m.speaker ? `${m.speaker}` : undefined,
      source: "C-SPAN",
      narration: m.quote, // for SRT only; audio comes from source clip
      durationSeconds: dur,
    });
    const reaction = commentary.reactions.find((r) => r.forMomentRank === m.rank);
    if (reaction) {
      scenes.push({
        type: "fact",
        fact: m.whyItMatters,
        source: m.speaker,
        narration: reaction.narration,
        durationSeconds: 10,
      });
    }
  }

  // Final scene: outro
  scenes.push({
    type: "outro",
    cta: commentary.outro.cta,
    narration: commentary.outro.narration,
    durationSeconds: 7,
  });

  const episode = {
    id,
    title: commentary.title,
    subtitle: commentary.subtitle,
    theme: "science",
    memojiDir: `uploads/${id}`,
    bgm: "tech",
    facePosition: "bottom-left",
    source: { kind: "cspan", refId: slug, url: "" },
    scenes,
  };

  const outFile = path.join(DATA_DIR, "episodes", `${id}.json`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(episode, null, 2));
  console.log(`\nDone -> ${path.relative(ROOT, outFile)}`);
  console.log(`\nReview the JSON, then:`);
  console.log(`  1. Record Memoji clips → uploads/${id}/scene-{1..${scenes.length}}.mov`);
  console.log(`     (sourceClip scenes use original speaker audio — skip those when recording)`);
  console.log(`  2. npm run episode -- data/episodes/${id}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
