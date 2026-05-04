import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { generatedScriptSchema, GeneratedScript } from "./lib/script-schema.js";
import { DATA_DIR, ensureDir, ROOT, slugify } from "./lib/paths.js";

const SYSTEM_PROMPT = `You are a senior writer for a cinematic English-language YouTube channel that explains history, science, and curiosity-driven facts in 60-180 second videos.

Your job: given a topic, produce a COMPLETE shot-by-shot script as JSON, optimized to be turned directly into a motion-graphics video with stock B-roll and historical imagery.

HARD RULES:
- Output ONLY valid JSON. No prose, no markdown, no code fences.
- All narration MUST be in clear, vivid English suitable for native and ESL viewers.
- Narration must be FACTUALLY ACCURATE. Never invent dates, names, quotes, or statistics. If you are not sure, omit the detail or speak in safer general terms.
- Each scene's narration is exactly what the narrator will literally say. Punchy, declarative, present tense for immediacy.
- Pacing target: ~150 words per minute. Keep total narration under ~280 words for a ~110s video.
- Use a rich variety of scene types — at least 3 different scene types per script.

SCHEMA (TypeScript):
type Script = {
  title: string;            // short, magnetic (<= 8 words). Curiosity hook for explainers, e.g. "Why airplane food tastes worse"
  subtitle?: string;        // 2-4 word subtitle, e.g. "Explained in 90 seconds"
  theme?: "history" | "science" | "modern" | "explainer";
  scenes: Scene[];          // 6-10 scenes
};

type Scene =
  | { type: "title"; title: string; subtitle?: string; backgroundImageQuery?: string; narration: string; }
  | { type: "narration"; imageQuery: string; caption?: string; date?: string; narration: string; }
  | { type: "broll"; brollQueries: string[]; subtitle?: string; chip?: string; narration: string; }
  | { type: "timeline"; heading: string; events: { year: string; text: string }[]; narration: string; }
  | { type: "fact"; fact: string; source?: string; narration: string; }
  | { type: "outro"; cta: string; narration: string; };

THEME SELECTION:
- "history" → past events, civilizations, biographies (sepia/gold tone)
- "science" → physics/space/biology (deep blue tone)
- "explainer" → curiosity / "why does X" / how-things-work topics (modern dark + yellow accent) — DEFAULT for "why" / "how" topics
- "modern" → contemporary culture / tech (neutral dark)

GUIDELINES:
- Scene 1 MUST be type "title". Last scene MUST be type "outro".
- For "why does X" / "how does X work" topics, use 3-5 "broll" scenes as the spine of the video, plus a "fact" or "timeline" for variety.
- For history topics, use mostly "narration" scenes with "timeline" + "fact" for variety.
- imageQuery / backgroundImageQuery: specific Wikimedia Commons search phrases (e.g. "Hagia Sophia interior 19th century painting", not "old church").
- brollQueries: 2-4 SHORT generic stock-footage phrases ideal for Pexels (e.g. "airplane window cloud", "chef plating food close up", "brain MRI scan", NOT historical/proper nouns). Keep each under 4 words.
- broll.subtitle: large hero text shown over the clips. Wrap 1-3 KEY words in **double asterisks** to highlight them in the accent color, e.g. "Your sense of **smell** drops by 30% in flight." Aim for one short sentence (8-14 words). If omitted, narration is used.
- broll.chip: short upper-left label like "Step 1", "The Twist", "1903" — only when it adds clarity.
- caption (lower-third) should be a short noun phrase: a person, place, or event name. Not a full sentence.
- date: a real date/era only when the scene is anchored to one moment.
- timeline events: 3-6 entries, chronological, year + one-line text.
- fact.source: a real, verifiable source (book, paper, museum) when possible — otherwise omit.
- outro.cta: 4-8 words, e.g. "Subscribe for more curiosity."`;

async function generate(topic: string): Promise<GeneratedScript> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env.");
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL ?? "claude-opus-4-7";

  const response = await client.messages.create({
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
        content: `Topic: ${topic}\n\nWrite the JSON script now.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content.");
  }
  const raw = textBlock.text.trim();
  // Tolerate the model wrapping output in code fences despite instructions.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Claude output was not valid JSON:\n${cleaned.slice(0, 500)}\n\n${err}`,
    );
  }

  const script = generatedScriptSchema.parse(parsed);
  return script;
}

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) {
    console.error('Usage: npm run script -- "Your topic here"');
    process.exit(1);
  }

  console.log(`-> Generating script for: ${topic}`);
  const script = await generate(topic);

  await ensureDir(path.join(DATA_DIR, "generated"));
  const slug = slugify(script.title);
  const outPath = path.join(DATA_DIR, "generated", `${slug}.json`);
  await fs.writeFile(outPath, JSON.stringify(script, null, 2), "utf-8");

  console.log(`-> Wrote ${path.relative(ROOT, outPath)}`);
  console.log(`-> Title: ${script.title}`);
  console.log(`-> Scenes: ${script.scenes.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { generate as generateScript };
