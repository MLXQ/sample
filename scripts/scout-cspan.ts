/**
 * C-SPAN scout — scrapes the c-span.org search page for the latest
 * AI / semiconductor / tech-CEO hearings and prints the top results
 * with URL, date, and a "looks promising" score based on title
 * keywords. C-SPAN has no public API; this is best-effort HTML
 * parsing and may need adjusting if they redesign the page.
 *
 * The user's manual workflow afterward:
 *   1. Open one of the result URLs in a browser
 *   2. Use the "Download" button on the C-SPAN player to save the
 *      full hearing as .mp4 (this also strips out the chat overlay
 *      and gets a clean copy)
 *   3. Run: npm run transcribe -- path/to/hearing.mp4
 *   4. Run: npm run find-moments -- out/transcripts/hearing/transcript.json
 *   5. Review out/transcripts/hearing/moments.json
 *   6. npm run draft-cspan-episode -- out/transcripts/hearing/
 *
 * Usage:
 *   npm run scout-cspan                                  # default: AI search
 *   npm run scout-cspan -- --query "semiconductor"
 *   npm run scout-cspan -- --query "Sam Altman" --top 20
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

type CspanResult = {
  rank: number;
  url: string;
  title: string;
  date?: string;
  promiseScore: number;
  cues: string[];
};

type Args = { query: string; top: number };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { query: "artificial intelligence", top: 15 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--query") (out.query = argv[i + 1]), i++;
    else if (argv[i] === "--top") (out.top = parseInt(argv[i + 1], 10)), i++;
  }
  return out;
}

function scoreTitle(title: string): { score: number; cues: string[] } {
  const lower = title.toLowerCase();
  const SIGNAL: Array<[RegExp, number, string]> = [
    [/sam altman|jensen huang|sundar pichai|mark zuckerberg|tim cook|elon musk/, 3.0, "tech CEO"],
    [/ai safety|ai regulation|ai oversight/, 2.0, "AI safety angle"],
    [/openai|anthropic|google|meta|nvidia/, 1.5, "frontier lab/co"],
    [/semiconductor|chip|tsmc|asml|sk hynix|export control/, 2.0, "semiconductor"],
    [/oversight|hearing|testimony/, 1.0, "formal hearing"],
    [/cybersec|surveillance|national security/, 1.0, "security"],
    [/election|deepfake|misinformation/, 1.0, "election AI"],
    [/labor|workforce|displacement/, 0.7, "labor impact"],
    [/copyright|fair use|content/, 0.7, "copyright"],
    [/markup|amendment|vote/, -0.5, "procedural (low value)"],
  ];
  let score = 0;
  const cues: string[] = [];
  for (const [pat, w, label] of SIGNAL) {
    if (pat.test(lower)) {
      score += w;
      cues.push(label);
    }
  }
  return { score: +score.toFixed(2), cues };
}

/**
 * Parse a C-SPAN search page. C-SPAN renders results as
 * <li class="search-result">…</li> blocks under <ul class="search-results">.
 * Each result has an <a class="thumb"> link with href and a <span class="meta">
 * with the date. Pulled empirically from the live site; if the markup
 * changes, this function needs updating.
 */
function parseResults(html: string): Array<{ url: string; title: string; date?: string }> {
  const out: Array<{ url: string; title: string; date?: string }> = [];
  // Each <li.search-result> ... </li>
  const liRe = /<li class="search-result[^"]*">([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const block = m[1];
    const urlMatch = /<a[^>]+href="(\/video\/\?[^"]+)"/.exec(block);
    const titleMatch = /<h(?:3|4)[^>]*>\s*<a[^>]*>([^<]+)<\/a>/.exec(block);
    const dateMatch = /<span class="date[^"]*">\s*([^<]+?)\s*<\/span>/.exec(block);
    if (!urlMatch || !titleMatch) continue;
    out.push({
      url: `https://www.c-span.org${urlMatch[1]}`,
      title: titleMatch[1].replace(/\s+/g, " ").trim(),
      date: dateMatch ? dateMatch[1].trim() : undefined,
    });
  }
  // Fallback: try a more generic anchor pattern in case markup changed
  if (out.length === 0) {
    const altRe = /<a[^>]+href="(\/video\/\?[^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>/g;
    while ((m = altRe.exec(html)) !== null) {
      const title = m[2].replace(/\s+/g, " ").trim();
      if (title.length < 12) continue; // too short, probably a chrome link
      out.push({ url: `https://www.c-span.org${m[1]}`, title });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const url =
    `https://www.c-span.org/search/?searchtype=Videos` +
    `&query=${encodeURIComponent(args.query)}`;
  console.log(`-> Fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`C-SPAN: ${res.status}`);
  const html = await res.text();
  const raw = parseResults(html);
  if (raw.length === 0) {
    console.error(
      "(no results parsed — C-SPAN markup may have changed; inspect HTML manually)",
    );
  }

  const ranked: CspanResult[] = raw
    .map((r) => {
      const { score, cues } = scoreTitle(r.title);
      return { ...r, rank: 0, promiseScore: score, cues };
    })
    .sort((a, b) => b.promiseScore - a.promiseScore)
    .slice(0, args.top)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  for (const r of ranked) {
    console.log("");
    console.log(
      `  #${r.rank}  score ${r.promiseScore.toFixed(2)}  ${r.date ?? "—"}`,
    );
    console.log(`        ${r.title}`);
    if (r.cues.length) console.log(`        Cues: ${r.cues.join(", ")}`);
    console.log(`        ${r.url}`);
  }

  await ensureDir(path.join(OUT_DIR, "scout"));
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(OUT_DIR, "scout", `cspan-${date}.json`);
  await fs.writeFile(
    out,
    JSON.stringify(
      { fetchedAt: new Date().toISOString(), query: args.query, results: ranked },
      null,
      2,
    ),
  );
  console.log(`\n-> ${path.relative(ROOT, out)}`);
  if (ranked.length > 0) {
    console.log(`\nNext:`);
    console.log(`  1. Open one of the URLs in your browser`);
    console.log(
      `  2. Use the C-SPAN "Download" button to save the mp4 locally`,
    );
    console.log(`  3. npm run transcribe -- path/to/hearing.mp4`);
    console.log(
      `  4. npm run find-moments -- out/transcripts/<name>/transcript.json`,
    );
    console.log(
      `  5. npm run draft-cspan-episode -- out/transcripts/<name>/`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
