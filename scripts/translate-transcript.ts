/**
 * Translate a Whisper transcript's English segments into Korean,
 * preserving timestamps so we can later build a bilingual ASS subtitle
 * track. Sends segments to Claude in batches (50 at a time) so the
 * model can use neighboring context for better translations while
 * staying inside reasonable token budgets.
 *
 * Output schema (bilingual-transcript.json):
 *   {
 *     "language": "english",
 *     "duration": 1234.5,
 *     "segments": [
 *       { "start": 0.0, "end": 4.5, "en": "...", "ko": "..." },
 *       ...
 *     ]
 *   }
 *
 * Usage:
 *   npm run translate-transcript -- out/transcripts/altman/transcript.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ROOT } from "./lib/paths.js";

const BATCH_SIZE = 50;

type Segment = { start: number; end: number; text: string };
type Transcript = {
  language: string;
  duration: number;
  text: string;
  segments: Segment[];
};

const batchSchema = z.object({
  translations: z
    .array(z.object({ idx: z.number(), ko: z.string() }))
    .min(1),
});

const SYSTEM_PROMPT = `You are a professional EN→KO subtitle translator for a Korean-language audience watching English-source AI / tech / political hearings on YouTube. Translate each numbered segment line into NATURAL, COLLOQUIAL Korean — the kind you would read on a Korean news subtitle, not a literal word-for-word translation.

RULES:
- Output ONLY valid JSON, no preamble, no markdown.
- Match the index of every input segment exactly.
- Keep each Korean line UNDER 35 characters when possible (subtitle readability).
- Use 반말체 ("~다") if it's a statement, 의문문 if it's a question.
- Translate proper nouns the standard Korean way (e.g. "Sam Altman" → "샘 올트먼", "OpenAI" → "OpenAI" left as-is, "Congress" → "의회").
- For acronyms (AI, GPU, EUV, TSMC), keep them in English in the Korean line.
- If a segment is just filler ("uh", "you know"), translate as natural Korean equivalent or "음" etc.
- Do NOT add explanatory context. Just translate what's literally said.

OUTPUT SCHEMA:
{
  "translations": [
    { "idx": 0, "ko": "한국어 번역" },
    { "idx": 1, "ko": "..." }
  ]
}`;

async function translateBatch(
  client: Anthropic,
  model: string,
  segments: Segment[],
  offset: number,
): Promise<Map<number, string>> {
  const lines = segments
    .map((s, i) => `${offset + i}. ${s.text}`)
    .join("\n");
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Translate these ${segments.length} segments to Korean:\n\n${lines}\n\nReturn JSON.`,
      },
    ],
  });
  const block = res.content.find((b) => b.type === "text");
  if (!block || block.type !== "text")
    throw new Error("Claude returned no text");
  const cleaned = block.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = batchSchema.parse(JSON.parse(cleaned));
  const map = new Map<number, string>();
  for (const t of parsed.translations) map.set(t.idx, t.ko);
  return map;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY missing in env.");
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const inputPath = argv[0];
  if (!inputPath) {
    console.error("Usage: npm run translate-transcript -- <transcript.json>");
    process.exit(1);
  }
  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(ROOT, inputPath);
  const transcript = JSON.parse(await fs.readFile(abs, "utf-8")) as Transcript;
  console.log(
    `-> Translating ${transcript.segments.length} segments (batches of ${BATCH_SIZE})`,
  );

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-opus-4-7";

  const bilingual: Array<Segment & { en: string; ko: string }> = [];
  for (let i = 0; i < transcript.segments.length; i += BATCH_SIZE) {
    const batch = transcript.segments.slice(i, i + BATCH_SIZE);
    console.log(
      `   batch ${i / BATCH_SIZE + 1}/${Math.ceil(transcript.segments.length / BATCH_SIZE)}  (segs ${i}-${i + batch.length - 1})`,
    );
    const map = await translateBatch(client, model, batch, i);
    for (let j = 0; j < batch.length; j++) {
      const seg = batch[j];
      bilingual.push({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        en: seg.text,
        ko: map.get(i + j) ?? "",
      });
    }
  }

  const outFile = path.join(
    path.dirname(abs),
    "bilingual-transcript.json",
  );
  await fs.writeFile(
    outFile,
    JSON.stringify(
      {
        language: transcript.language,
        duration: transcript.duration,
        segments: bilingual,
      },
      null,
      2,
    ),
  );
  console.log(`\nDone -> ${path.relative(ROOT, outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
