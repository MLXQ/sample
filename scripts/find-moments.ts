/**
 * Reads a Whisper transcript JSON and asks Claude to pick the N most
 * engaging 15-30 second moments for an explainer-video clip. Returns
 * a candidates JSON with start/end timestamps, the verbatim quote, a
 * one-line "why this matters" reason, and a suggested commentary
 * angle (what the host could say after playing the clip).
 *
 * Usage:
 *   npm run find-moments -- path/to/transcript.json [--top 5] [--topic "AI safety"]
 *
 * Output:
 *   out/transcripts/<name>/moments.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ROOT, ensureDir } from "./lib/paths.js";

type Args = { transcript: string; top: number; topic?: string };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { transcript: "", top: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--top") (out.top = parseInt(v, 10)), i++;
    else if (a === "--topic") (out.topic = v), i++;
    else if (!out.transcript) out.transcript = a;
  }
  return out;
}

const momentSchema = z.object({
  rank: z.number(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  speaker: z.string().optional(),
  quote: z.string(),
  whyItMatters: z.string(),
  commentaryAngle: z.string(),
  shockScore: z.number().min(0).max(10),
});
const momentsSchema = z.object({ moments: z.array(momentSchema) });

const SYSTEM_PROMPT = `You are a senior YouTube video editor at a cinematic AI/tech channel (Cleo Abram, Asianometry, Real Engineering style). Given a Whisper transcript of a long hearing / speech / interview, your job is to identify the N MOST CLIPPABLE moments for an explainer video.

A clippable moment is:
- 15-30 seconds long (Whisper segment timestamps are the source of truth)
- Self-contained — viewers can understand it without the full context
- Has at least ONE of: a stunning specific number, a counterintuitive admission, a heated exchange, a slip of the tongue, a clear thesis statement, a viral-quotable line
- Carries forward into a host commentary (what's the host going to SAY after this clip?)

HARD RULES:
- Output ONLY valid JSON, no markdown, no preamble.
- Use the exact segment timestamps from the transcript. Snap to segment boundaries.
- Avoid clips that require off-screen context the viewer won't have.
- Rank by shockScore (0-10) where 10 = "this clip alone could carry the entire video."

OUTPUT SCHEMA:
{
  "moments": [
    {
      "rank": 1,
      "startSeconds": 142.3,
      "endSeconds": 168.7,
      "speaker": "Senator Hawley" | "Sam Altman" | "unknown",
      "quote": "the verbatim text of this clip",
      "whyItMatters": "one sentence — what this reveals or admits",
      "commentaryAngle": "one sentence — what the host should say RIGHT AFTER this clip plays",
      "shockScore": 8.5
    }
  ]
}`;

async function findMoments(
  transcript: { text: string; duration: number; segments: { start: number; end: number; text: string }[] },
  top: number,
  topic?: string,
): Promise<z.infer<typeof momentsSchema>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing in env.");
  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-opus-4-7";

  // Build a compact transcript representation for the model:
  // "[start-end] text" per segment.
  const lines = transcript.segments.map(
    (s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`,
  );
  const compact = lines.join("\n");
  const topicLine = topic ? `Focus angle: ${topic}\n\n` : "";

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `${topicLine}Pick the top ${top} clippable moments from this transcript (total ${(
          transcript.duration / 60
        ).toFixed(1)} min):\n\n${compact}\n\nReturn JSON.`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Claude returned no text");
  const cleaned = block.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  return momentsSchema.parse(parsed);
}

async function main() {
  const args = parseArgs();
  if (!args.transcript) {
    console.error(
      "Usage: npm run find-moments -- <transcript.json> [--top 5] [--topic 'AI safety']",
    );
    process.exit(1);
  }
  const transcriptPath = path.isAbsolute(args.transcript)
    ? args.transcript
    : path.resolve(ROOT, args.transcript);
  const raw = await fs.readFile(transcriptPath, "utf-8");
  const transcript = JSON.parse(raw);
  console.log(
    `-> Analyzing transcript: ${path.relative(ROOT, transcriptPath)} (${transcript.segments.length} segments)`,
  );

  const result = await findMoments(transcript, args.top, args.topic);

  for (const m of result.moments) {
    console.log("");
    console.log(
      `  #${m.rank}  shock ${m.shockScore.toFixed(1)}  [${m.startSeconds.toFixed(1)}-${m.endSeconds.toFixed(1)}] ${m.speaker ?? ""}`,
    );
    console.log(`        "${m.quote.slice(0, 120)}${m.quote.length > 120 ? "…" : ""}"`);
    console.log(`        Matters: ${m.whyItMatters}`);
    console.log(`        Host says: ${m.commentaryAngle}`);
  }

  const outFile = path.join(
    path.dirname(transcriptPath),
    "moments.json",
  );
  await fs.writeFile(outFile, JSON.stringify(result, null, 2));
  console.log(`\nDone -> ${path.relative(ROOT, outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
