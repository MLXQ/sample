/**
 * VOA scout — Voice of America RSS feeds (English + Korean) covering
 * AI, tech, semiconductor, and geopolitics topics. VOA is fully PD
 * (US federal government work product), so all clips are usable
 * without license concerns.
 *
 * Usage:
 *   npm run scout-voa                  # default: last 7 days
 *   npm run scout-voa -- --lang en     # English only
 *   npm run scout-voa -- --lang ko     # Korean only
 *
 * Output:
 *   out/scout/voa-YYYY-MM-DD.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const UA = "video-pipeline-scout/0.1";

type Feed = { lang: "en" | "ko"; name: string; url: string };

// VOA exposes multiple RSS endpoints by section. AI / tech / Asia
// geopolitics are most relevant for our channel.
const FEEDS: Feed[] = [
  // English
  { lang: "en", name: "VOA Tech", url: "https://www.voanews.com/api/zomieuyiey" },
  { lang: "en", name: "VOA Economy", url: "https://www.voanews.com/api/zybyieueki" },
  { lang: "en", name: "VOA East Asia", url: "https://www.voanews.com/api/zkjvqe$lqi" },
  // Korean (한국어 VOA — same federal-PD status)
  { lang: "ko", name: "VOA Korea News", url: "https://www.voakorea.com/api/zriqveutpi" },
  { lang: "ko", name: "VOA Korea Tech", url: "https://www.voakorea.com/api/zoijvevtoq" },
];

type Args = { days: number; lang?: "en" | "ko" };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { days: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--days") (out.days = parseInt(v, 10)), i++;
    else if (a === "--lang") (out.lang = v as "en" | "ko"), i++;
  }
  return out;
}

function scoreText(title: string, description: string, lang: "en" | "ko"): { score: number; cues: string[] } {
  const text = `${title} ${description}`.toLowerCase();
  const SIGNALS_EN: Array<[RegExp, number, string]> = [
    [/\b(ai|artificial intelligence|machine learning)\b/g, 2.0, "AI"],
    [/semiconductor|chip|sk hynix|tsmc|asml|samsung|nvidia/g, 2.0, "chip"],
    [/openai|anthropic|deepseek|meta|google|microsoft/g, 1.5, "AI lab"],
    [/china|taiwan|korea|export control|sanction/g, 1.2, "geopolitics"],
    [/altman|huang|pichai|zuckerberg|musk/g, 2.5, "named CEO"],
    [/quantum|robot|autonomous|deepfake|cybersec/g, 0.8, "frontier"],
  ];
  // Korean version of the same signals
  const SIGNALS_KO: Array<[RegExp, number, string]> = [
    [/인공지능|AI|머신러닝/g, 2.0, "AI"],
    [/반도체|칩|SK하이닉스|TSMC|ASML|삼성|엔비디아/g, 2.0, "chip"],
    [/오픈AI|앤트로픽|딥시크|메타|구글|마이크로소프트/g, 1.5, "AI lab"],
    [/중국|대만|한국|수출 통제|제재/g, 1.2, "geopolitics"],
    [/올트먼|황|피차이|저커버그|머스크/g, 2.5, "named CEO"],
    [/양자|로봇|자율주행|딥페이크|사이버/g, 0.8, "frontier"],
  ];
  const signals = lang === "ko" ? SIGNALS_KO : SIGNALS_EN;
  let score = 0;
  const cues: string[] = [];
  for (const [pat, w, label] of signals) {
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
  enclosure?: { "@url"?: string; "@type"?: string };
  "media:content"?: { "@url"?: string };
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
  const feeds = args.lang ? FEEDS.filter((f) => f.lang === args.lang) : FEEDS;
  console.log(`-> Scanning ${feeds.length} VOA feeds (last ${args.days}d)`);

  type Candidate = {
    rank: number;
    feed: string;
    lang: "en" | "ko";
    title: string;
    link: string;
    date: string;
    description: string;
    score: number;
    cues: string[];
    videoUrl?: string;
  };

  const all: Candidate[] = [];
  for (const feed of feeds) {
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
      const { score, cues } = scoreText(title, desc, feed.lang);
      if (score < 1) continue;
      // Some VOA items have an enclosure (mp3 or mp4) we could grab
      const videoUrl =
        it.enclosure?.["@type"]?.startsWith("video")
          ? it.enclosure["@url"]
          : it["media:content"]?.["@url"];
      all.push({
        rank: 0,
        feed: feed.name,
        lang: feed.lang,
        title,
        link: it.link,
        date: pub.toISOString().slice(0, 10),
        description: desc.slice(0, 300),
        score,
        cues,
        videoUrl,
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
      `  #${c.rank}  score ${c.score.toFixed(2)}  ${c.date}  [${c.lang}] ${c.feed}`,
    );
    console.log(`        ${c.title}`);
    if (c.cues.length) console.log(`        Cues: ${c.cues.slice(0, 4).join(", ")}`);
    console.log(`        ${c.link}`);
    if (c.videoUrl) console.log(`        Video: ${c.videoUrl}`);
  }

  await ensureDir(path.join(OUT_DIR, "scout"));
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(OUT_DIR, "scout", `voa-${date}.json`);
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
