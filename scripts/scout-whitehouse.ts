/**
 * White House scout — fetches whitehouse.gov RSS feeds and surfaces
 * recent items that look AI / tech / chip / semiconductor relevant.
 * Every whitehouse.gov item is public-domain (federal government work
 * product) so anything here can be quoted, embedded, or used as
 * source video without license concerns.
 *
 * Usage:
 *   npm run scout-whitehouse                  # default: last 7 days, all feeds
 *   npm run scout-whitehouse -- --days 30
 *
 * Output:
 *   out/scout/whitehouse-YYYY-MM-DD.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const UA = "video-pipeline-scout/0.1";

// Multiple White House feeds — each covers a different content type.
// If WH changes their feed structure, add/remove URLs here.
const FEEDS: Array<{ name: string; url: string }> = [
  { name: "Briefing Room", url: "https://www.whitehouse.gov/feed/" },
  { name: "Statements & Releases", url: "https://www.whitehouse.gov/briefing-room/statements-releases/feed/" },
  { name: "Speeches & Remarks", url: "https://www.whitehouse.gov/briefing-room/speeches-remarks/feed/" },
  { name: "Press Briefings", url: "https://www.whitehouse.gov/briefing-room/press-briefings/feed/" },
];

type Args = { days: number };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { days: 7 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") (out.days = parseInt(argv[i + 1], 10)), i++;
  }
  return out;
}

function scoreTitle(title: string, description: string): { score: number; cues: string[] } {
  const text = `${title} ${description}`.toLowerCase();
  const SIGNAL: Array<[RegExp, number, string]> = [
    [/ai|artificial intelligence/g, 2.0, "AI"],
    [/semiconductor|chip|chips act|fab/g, 2.0, "semiconductor"],
    [/export control|tariff|technology transfer/g, 1.5, "tech policy"],
    [/openai|nvidia|google|microsoft|meta|anthropic|tsmc|asml|sk hynix|samsung/g, 1.8, "named co"],
    [/jensen huang|sam altman|sundar pichai|mark zuckerberg|tim cook/g, 2.5, "tech CEO"],
    [/executive order|signed into law|directive/g, 1.5, "policy action"],
    [/cybersecurity|surveillance|deepfake|misinformation/g, 1.0, "security"],
    [/quantum|biotech|robotics|autonomous/g, 0.8, "frontier tech"],
    [/climate|energy|nuclear|grid|power/g, 0.8, "energy / AI infra"],
    [/china|taiwan|korea|netherlands|japan/g, 1.0, "geopolitics"],
    [/research and development|r&d|innovation/g, 0.5, "R&D"],
  ];
  let score = 0;
  const cues: string[] = [];
  for (const [pat, w, label] of SIGNAL) {
    const m = text.match(pat);
    if (m) {
      score += w * Math.min(2, m.length);
      cues.push(`${label} (${m.length}x)`);
    }
  }
  return { score: +score.toFixed(2), cues };
}

type RssItem = {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  category?: string[];
  enclosure?: { "@url"?: string; "@type"?: string };
};

async function fetchFeed(url: string): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml" },
  });
  if (!res.ok) throw new Error(`RSS ${url}: ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
  });
  const json = parser.parse(xml);
  const items = json?.rss?.channel?.item ?? [];
  return Array.isArray(items) ? items : [items];
}

async function main() {
  const args = parseArgs();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - args.days);
  console.log(`-> Scanning ${FEEDS.length} White House feeds (last ${args.days}d)`);

  type Candidate = {
    rank: number;
    feed: string;
    title: string;
    link: string;
    date: string;
    description: string;
    score: number;
    cues: string[];
  };

  const all: Candidate[] = [];
  for (const feed of FEEDS) {
    let items: RssItem[] = [];
    try {
      items = await fetchFeed(feed.url);
    } catch (err) {
      console.warn(`! ${feed.name}: ${(err as Error).message}`);
      continue;
    }
    for (const it of items) {
      const pub = new Date(it.pubDate ?? 0);
      if (pub < cutoff) continue;
      const title = (it.title ?? "").replace(/<[^>]+>/g, "").trim();
      const desc = (it.description ?? "").replace(/<[^>]+>/g, "").trim();
      const { score, cues } = scoreTitle(title, desc);
      if (score < 1) continue; // filter out unrelated WH items
      all.push({
        rank: 0,
        feed: feed.name,
        title,
        link: it.link,
        date: pub.toISOString().slice(0, 10),
        description: desc.slice(0, 300),
        score,
        cues,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  all.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  all.forEach((c, i) => (c.rank = i + 1));

  if (all.length === 0) {
    console.log("(no AI/tech-relevant items in window)");
  }
  for (const c of all.slice(0, 20)) {
    console.log("");
    console.log(
      `  #${c.rank}  score ${c.score.toFixed(2)}  ${c.date}  ${c.feed}`,
    );
    console.log(`        ${c.title}`);
    if (c.cues.length) console.log(`        Cues: ${c.cues.slice(0, 4).join(", ")}`);
    console.log(`        ${c.link}`);
  }

  await ensureDir(path.join(OUT_DIR, "scout"));
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(OUT_DIR, "scout", `whitehouse-${date}.json`);
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        daysWindow: args.days,
        results: all,
      },
      null,
      2,
    ),
  );
  console.log(`\n-> ${path.relative(ROOT, out)}  (${all.length} items)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
