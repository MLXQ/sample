/**
 * SEC EDGAR scout — monitors the SEC's "submissions" JSON API for new
 * filings from a curated list of AI / semiconductor companies.
 * Flags any 10-Q, 10-K, or 8-K (especially Item 2.02 Results of
 * Operations = earnings) filed in the last N days.
 *
 * EDGAR API: https://data.sec.gov/submissions/CIK0000000000.json
 *   - Free, no auth, must send a User-Agent with contact info per SEC policy
 *   - JSON, well-structured, no rate-limit headers (be polite: 10 req/s)
 *
 * Usage:
 *   npm run scout-edgar                 # default: last 7 days, all watchlist
 *   npm run scout-edgar -- --days 14
 *   npm run scout-edgar -- --types 10-Q,8-K
 *
 * Output:
 *   out/scout/edgar-YYYY-MM-DD.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const UA =
  "video-pipeline-scout/0.1 (contact: video-pipeline@example.com)";

// AI / semiconductor watchlist — names are display, ciks are zero-padded
const WATCHLIST: Array<{ ticker: string; name: string; cik: string }> = [
  { ticker: "NVDA", name: "NVIDIA", cik: "0001045810" },
  { ticker: "AMD", name: "Advanced Micro Devices", cik: "0000002488" },
  { ticker: "MSFT", name: "Microsoft", cik: "0000789019" },
  { ticker: "META", name: "Meta Platforms", cik: "0001326801" },
  { ticker: "GOOGL", name: "Alphabet", cik: "0001652044" },
  { ticker: "AAPL", name: "Apple", cik: "0000320193" },
  { ticker: "AMZN", name: "Amazon", cik: "0001018724" },
  { ticker: "INTC", name: "Intel", cik: "0000050863" },
  { ticker: "AVGO", name: "Broadcom", cik: "0001730168" },
  { ticker: "ARM", name: "Arm Holdings", cik: "0001973239" },
  { ticker: "PLTR", name: "Palantir", cik: "0001321655" },
  { ticker: "ORCL", name: "Oracle", cik: "0001341439" },
  { ticker: "CRWV", name: "CoreWeave", cik: "0001769628" },
];

type Args = { days: number; types: Set<string>; companies?: string[] };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { days: 7, types: new Set(["10-Q", "10-K", "8-K"]) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--days") (out.days = parseInt(v, 10)), i++;
    else if (a === "--types") out.types = new Set(v.split(",").map((s) => s.trim().toUpperCase())), i++;
    else if (a === "--companies")
      out.companies = v.split(",").map((s) => s.trim().toUpperCase()), i++;
  }
  return out;
}

type EdgarFiling = {
  form: string;
  filingDate: string;        // "YYYY-MM-DD"
  reportDate: string;
  acceptanceDateTime: string;
  accessionNumber: string;   // "0001045810-25-000123"
  primaryDocument: string;
  primaryDocDescription: string;
  items?: string;            // for 8-K: "2.02,9.01" etc
};

type EdgarSubmissions = {
  name: string;
  tickers: string[];
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      reportDate: string[];
      acceptanceDateTime: string[];
      accessionNumber: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
      items?: string[];
    };
  };
};

async function fetchSubmissions(cik: string): Promise<EdgarSubmissions> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`EDGAR ${cik}: ${res.status}`);
  return await res.json();
}

function listToFilings(recent: EdgarSubmissions["filings"]["recent"]): EdgarFiling[] {
  const n = recent.form.length;
  const out: EdgarFiling[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate[i],
      acceptanceDateTime: recent.acceptanceDateTime[i],
      accessionNumber: recent.accessionNumber[i],
      primaryDocument: recent.primaryDocument[i],
      primaryDocDescription: recent.primaryDocDescription[i],
      items: recent.items?.[i],
    });
  }
  return out;
}

function scoreFiling(form: string, items?: string): { score: number; reason: string } {
  if (form === "10-K") return { score: 5, reason: "annual report" };
  if (form === "10-Q") return { score: 4, reason: "quarterly results" };
  if (form === "8-K") {
    if (items?.includes("2.02"))
      return { score: 5, reason: "Item 2.02 Results of Operations (earnings)" };
    if (items?.includes("7.01"))
      return { score: 2, reason: "Item 7.01 Regulation FD disclosure" };
    if (items?.includes("5.02"))
      return { score: 3, reason: "Item 5.02 executive officer change" };
    if (items?.includes("1.01"))
      return { score: 3, reason: "Item 1.01 material agreement" };
    return { score: 1, reason: "8-K (minor)" };
  }
  if (form === "DEF 14A") return { score: 2, reason: "proxy (governance)" };
  return { score: 0.5, reason: form };
}

async function main() {
  const args = parseArgs();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - args.days);

  const targets = args.companies
    ? WATCHLIST.filter((c) =>
        args.companies!.includes(c.ticker.toUpperCase()),
      )
    : WATCHLIST;

  console.log(
    `-> Scanning ${targets.length} companies for ${[...args.types].join("/")} filings in last ${args.days}d`,
  );

  type Candidate = {
    rank: number;
    ticker: string;
    company: string;
    form: string;
    filingDate: string;
    items?: string;
    score: number;
    reason: string;
    documentUrl: string;
    indexUrl: string;
  };

  const all: Candidate[] = [];
  for (const t of targets) {
    let subs: EdgarSubmissions;
    try {
      subs = await fetchSubmissions(t.cik);
    } catch (err) {
      console.warn(`! ${t.ticker} fetch failed: ${(err as Error).message}`);
      continue;
    }
    const filings = listToFilings(subs.filings.recent);
    for (const f of filings) {
      if (!args.types.has(f.form.toUpperCase())) continue;
      if (new Date(f.filingDate) < cutoff) continue;
      const { score, reason } = scoreFiling(f.form, f.items);
      const accNoDashes = f.accessionNumber.replace(/-/g, "");
      const documentUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(t.cik, 10)}/${accNoDashes}/${f.primaryDocument}`;
      const indexUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${t.cik}&type=${encodeURIComponent(f.form)}&dateb=&owner=include&count=10`;
      all.push({
        rank: 0,
        ticker: t.ticker,
        company: t.name,
        form: f.form,
        filingDate: f.filingDate,
        items: f.items,
        score,
        reason,
        documentUrl,
        indexUrl,
      });
    }
    // be polite to EDGAR
    await new Promise((r) => setTimeout(r, 120));
  }

  all.sort((a, b) => b.score - a.score || (a.filingDate < b.filingDate ? 1 : -1));
  all.forEach((c, i) => (c.rank = i + 1));

  if (all.length === 0) {
    console.log("(no new filings in window)");
  }
  for (const c of all.slice(0, 25)) {
    console.log("");
    console.log(
      `  #${c.rank}  ${c.ticker.padEnd(5)} ${c.form.padEnd(7)} ${c.filingDate}  score ${c.score.toFixed(1)}`,
    );
    console.log(`        ${c.company}  —  ${c.reason}`);
    if (c.items) console.log(`        Items: ${c.items}`);
    console.log(`        ${c.documentUrl}`);
  }

  await ensureDir(path.join(OUT_DIR, "scout"));
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(OUT_DIR, "scout", `edgar-${date}.json`);
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        daysWindow: args.days,
        types: [...args.types],
        results: all,
      },
      null,
      2,
    ),
  );
  console.log(`\n-> ${path.relative(ROOT, out)}  (${all.length} filings)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
