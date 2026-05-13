/**
 * arXiv scout — fetches the latest cs.AI / cs.LG papers (or any
 * configurable arXiv category), parses the Atom feed, ranks each
 * paper by a simple "interest score", and writes a candidates JSON
 * the user can browse to pick the day's video subject.
 *
 * arXiv API: http://export.arxiv.org/api/query
 *   - No auth, no rate-limit headers (just be polite: 1 req / 3 sec)
 *   - Returns Atom XML
 *
 * Usage:
 *   npm run scout-arxiv                                 # default: cs.AI, 24h, top 10
 *   npm run scout-arxiv -- --category cs.LG --days 2 --top 15
 *   npm run scout-arxiv -- --query "all:GPT AND cat:cs.AI"
 *
 * Output:
 *   out/scout/arxiv-YYYY-MM-DD.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

type ArxivPaper = {
  rank: number;
  id: string; // bare arxiv id, e.g. "2401.12345"
  versionId: string; // e.g. "2401.12345v1"
  title: string;
  authors: string[];
  publishedDate: string; // ISO
  updatedDate: string;
  categories: string[];
  primaryCategory: string;
  abstract: string;
  abstractUrl: string;
  pdfUrl: string;
  interestScore: number;
  hookCues: string[];
};

type Args = {
  category: string;
  query?: string;
  days: number;
  top: number;
  outFile?: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { category: "cs.AI", days: 1, top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--category") out.category = v, i++;
    else if (a === "--query") out.query = v, i++;
    else if (a === "--days") out.days = parseInt(v, 10), i++;
    else if (a === "--top") out.top = parseInt(v, 10), i++;
    else if (a === "--out") out.outFile = v, i++;
  }
  return out;
}

async function fetchArxiv(query: string, maxResults: number): Promise<string> {
  const url = new URL("http://export.arxiv.org/api/query");
  url.searchParams.set("search_query", query);
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");
  url.searchParams.set("max_results", String(maxResults));
  const res = await fetch(url, {
    headers: { "User-Agent": "video-pipeline-scout/0.1" },
  });
  if (!res.ok) throw new Error(`arXiv API: ${res.status} ${await res.text()}`);
  return await res.text();
}

/** Light interest scoring: rewards specific keywords that tend to make
 *  for good explainer-video material. Heuristic, not ML. */
function scoreAbstract(title: string, abstract: string): { score: number; cues: string[] } {
  const text = `${title} ${abstract}`.toLowerCase();
  const SIGNAL: Array<[RegExp, number, string]> = [
    [/state[- ]of[- ]the[- ]art|sota|outperform|best performance/g, 1.0, "SOTA claim"],
    [/(\d{1,3}(?:\.\d+)?)\s*%/g, 0.8, "specific % numbers"],
    [/(\d{1,3})\s*x\b|(\d{1,3})x\s*(?:faster|smaller|cheaper)/g, 0.9, "Nx multiplier"],
    [/\$\s*\d[\d,.]*\s*(?:m|million|b|billion|k|trillion)/g, 1.0, "$ amount"],
    [/(\d{1,3}(?:,\d{3})*)\s*(?:gpu|tpu|h100|a100|node)/g, 1.0, "hardware scale"],
    [/(\d+)\s*(?:b|billion|m|million)\s*parameter/g, 1.0, "model size"],
    [/zero[- ]shot|few[- ]shot/g, 0.5, "few-shot framing"],
    [/we\s+(?:introduce|propose|present)/g, 0.4, "introduces method"],
    [/benchmark|evaluation|leaderboard/g, 0.3, "benchmarking"],
    [/scaling law|emergent/g, 0.7, "scaling / emergence"],
    [/agent|tool[- ]use|multi[- ]step/g, 0.4, "agentic"],
    [/safety|alignment|interpretab/g, 0.4, "safety / alignment"],
    [/open[- ]source|publicly available|we release/g, 0.5, "open release"],
    [/reasoning|chain[- ]of[- ]thought|chain of thought/g, 0.4, "reasoning"],
    [/transformer|diffusion|reinforcement learning|rlhf/g, 0.2, "core arch"],
  ];

  let score = 0;
  const cues: string[] = [];
  for (const [pat, weight, label] of SIGNAL) {
    const m = text.match(pat);
    if (m) {
      score += weight * Math.min(3, m.length);
      cues.push(`${label} (${m.length}x)`);
    }
  }
  // Bonus for short, specific titles (10-90 chars sweet spot)
  if (title.length >= 10 && title.length <= 90) score += 0.5;
  // Penalty for super-long abstracts (suggests dense/hard topic)
  if (abstract.length > 1800) score -= 0.5;
  return { score: +score.toFixed(2), cues };
}

function pickHookSentences(abstract: string): string[] {
  // Return up to 3 sentences that contain numbers, percentages,
  // or "we " — typically the strongest hooks for an explainer.
  const sentences = abstract
    .replace(/\s+/g, " ")
    .split(/(?<=\. )/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);
  const scored = sentences.map((s) => {
    let score = 0;
    if (/\d/.test(s)) score += 1;
    if (/\d+\s*%/.test(s)) score += 1;
    if (/^we\s+(?:propose|introduce|present|find|show)/i.test(s)) score += 1;
    if (/outperform|state[- ]of[- ]the[- ]art|sota/i.test(s)) score += 1;
    return { s, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.s);
}

function parseFeed(xml: string, daysFilter: number): ArxivPaper[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
  });
  const json = parser.parse(xml);
  const entries = json?.feed?.entry;
  if (!entries) return [];
  const arr = Array.isArray(entries) ? entries : [entries];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysFilter);

  const papers: ArxivPaper[] = [];
  for (const e of arr) {
    const published = new Date(e.published);
    if (published < cutoff) continue;

    const versionedId = (e.id as string).split("/").pop()!; // e.g. "2401.12345v1"
    const bareId = versionedId.replace(/v\d+$/, "");
    const authors = (
      Array.isArray(e.author) ? e.author : [e.author]
    ).map((a: { name: string }) => a.name);

    const links = Array.isArray(e.link) ? e.link : [e.link];
    const pdfLink = links.find((l: { "@title"?: string }) => l["@title"] === "pdf");
    const abstractLink = links.find(
      (l: { "@rel"?: string }) => l["@rel"] === "alternate",
    );

    const categories = (
      Array.isArray(e.category) ? e.category : [e.category]
    ).map((c: { "@term": string }) => c["@term"]);

    const title = (e.title as string).replace(/\s+/g, " ").trim();
    const abstract = (e.summary as string).replace(/\s+/g, " ").trim();
    const { score, cues } = scoreAbstract(title, abstract);

    papers.push({
      rank: 0,
      id: bareId,
      versionId: versionedId,
      title,
      authors,
      publishedDate: e.published,
      updatedDate: e.updated,
      categories,
      primaryCategory: e["arxiv:primary_category"]?.["@term"] ?? categories[0],
      abstract,
      abstractUrl:
        abstractLink?.["@href"] ?? `https://arxiv.org/abs/${bareId}`,
      pdfUrl: pdfLink?.["@href"] ?? `https://arxiv.org/pdf/${bareId}`,
      interestScore: score,
      hookCues: cues,
    });
  }

  papers.sort((a, b) => b.interestScore - a.interestScore);
  papers.forEach((p, i) => (p.rank = i + 1));
  return papers;
}

function printSummary(papers: ArxivPaper[]) {
  if (papers.length === 0) {
    console.log("(no papers in the window)");
    return;
  }
  for (const p of papers) {
    console.log("");
    console.log(
      `  #${p.rank}  score ${p.interestScore.toFixed(2)}  ${p.id}  ${p.publishedDate.slice(0, 10)}`,
    );
    console.log(`        ${p.title}`);
    console.log(
      `        ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? ", …" : ""}`,
    );
    const hooks = pickHookSentences(p.abstract);
    if (hooks.length > 0) {
      console.log(`        Hook: "${hooks[0].slice(0, 140)}${hooks[0].length > 140 ? "…" : ""}"`);
    }
    if (p.hookCues.length > 0) {
      console.log(`        Cues: ${p.hookCues.slice(0, 4).join(", ")}`);
    }
    console.log(`        ${p.abstractUrl}`);
  }
}

async function main() {
  const args = parseArgs();
  const query =
    args.query ?? `cat:${args.category}`;
  console.log(
    `-> Fetching arXiv: query="${query}", days=${args.days}, top=${args.top}`,
  );
  const xml = await fetchArxiv(query, Math.max(args.top * 3, 50));
  const papers = parseFeed(xml, args.days).slice(0, args.top);
  printSummary(papers);

  await ensureDir(path.join(OUT_DIR, "scout"));
  const date = new Date().toISOString().slice(0, 10);
  const outFile = args.outFile
    ? path.resolve(args.outFile)
    : path.join(OUT_DIR, "scout", `arxiv-${date}.json`);
  await fs.writeFile(
    outFile,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        query,
        daysWindow: args.days,
        candidates: papers,
      },
      null,
      2,
    ),
  );
  console.log(`\n-> wrote ${path.relative(ROOT, outFile)}  (${papers.length} candidates)`);
  if (papers.length > 0) {
    console.log(
      `\nNext: pick a paper id (e.g. ${papers[0].id}) and run:`,
    );
    console.log(`  npm run draft-episode -- arxiv ${papers[0].id}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
