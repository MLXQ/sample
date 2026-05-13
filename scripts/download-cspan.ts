/**
 * Download an mp4 from a C-SPAN video page URL. C-SPAN doesn't expose
 * a stable API; this scraper:
 *
 *   1. Fetches the video page HTML with a desktop User-Agent
 *   2. Extracts the program/video ID from the URL
 *   3. Hits c-span.org's "jwsetup" XHR endpoint (used by their player)
 *      to get the JWPlayer config — that returns JSON with a list of
 *      progressive mp4 sources at varying bitrates
 *   4. Picks the highest-bitrate mp4 and streams it to disk with a
 *      simple progress indicator
 *
 * If the player endpoint changes, fall back to parsing JSON-LD or
 * <meta property="og:video"> from the HTML.
 *
 * Usage:
 *   npm run download-cspan -- "https://www.c-span.org/video/?527691-1/..."  [output.mp4]
 *
 * Output:
 *   out/cspan/<program-id>/source.mp4
 *   out/cspan/<program-id>/metadata.json
 */
import "dotenv/config";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { OUT_DIR, ROOT, ensureDir } from "./lib/paths.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

type CspanMetadata = {
  programId: string;
  title?: string;
  publishedDate?: string;
  pageUrl: string;
  videoUrl: string;
  durationSeconds?: number;
};

function extractProgramId(url: string): string {
  // URL patterns:
  //   /video/?527691-1/openai-ceo-sam-altman-testifies-...
  //   /video/?527691/openai-ceo-...
  const m = url.match(/\?(\d+)(?:-\d+)?\/?/);
  if (!m) throw new Error(`Cannot extract program id from URL: ${url}`);
  return m[1];
}

type JwSource = { file: string; type?: string; label?: string };
type JwSetup = {
  playlist?: Array<{
    file?: string;
    sources?: JwSource[];
    title?: string;
    image?: string;
    description?: string;
  }>;
};

async function fetchJwSetup(programId: string): Promise<JwSetup> {
  // C-SPAN's player setup endpoint. Returns JSON with playlist+sources.
  const candidates = [
    `https://www.c-span.org/assets/player/ajax-player.php?os=android&html5=program&id=${programId}`,
    `https://www.c-span.org/common/services/flashXml.php?programid=${programId}&style=desktop`,
    `https://static-cdn1.ustream.tv/cspan/setup/program/${programId}.json`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json")) return await res.json();
      // Some endpoints return XML or JSON-as-text
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        // try next
      }
    } catch {
      // try next
    }
  }
  throw new Error(`No working C-SPAN player endpoint for id ${programId}`);
}

async function fetchPageMetadata(url: string): Promise<{
  title?: string;
  publishedDate?: string;
  ogVideo?: string;
}> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`page fetch ${res.status}`);
  const html = await res.text();
  const title = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1];
  const ogVideo = /<meta property="og:video" content="([^"]+)"/.exec(html)?.[1];
  const datePub =
    /<meta property="article:published_time" content="([^"]+)"/.exec(
      html,
    )?.[1] ?? /datetime="([^"]+)"/.exec(html)?.[1];
  return { title, publishedDate: datePub, ogVideo };
}

function pickBestSource(setup: JwSetup): string | null {
  // Walk playlist and find the highest-bitrate mp4 source.
  const playlist = setup.playlist ?? [];
  for (const item of playlist) {
    const srcs = item.sources ?? [];
    // Prefer mp4 with the highest "label" (e.g. "720p", "1080p")
    const mp4s = srcs.filter(
      (s) => s.file?.endsWith(".mp4") || s.type === "video/mp4",
    );
    if (mp4s.length === 0) continue;
    const score = (s: JwSource) => {
      const label = s.label ?? "";
      const m = label.match(/(\d+)\s*p/);
      if (m) return parseInt(m[1], 10);
      if (/high/i.test(label)) return 720;
      return 480;
    };
    mp4s.sort((a, b) => score(b) - score(a));
    if (mp4s[0].file) return mp4s[0].file;
    if (item.file) return item.file;
  }
  return null;
}

async function downloadWithProgress(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  if (!res.body) throw new Error("no response body");
  const totalRaw = res.headers.get("content-length");
  const total = totalRaw ? parseInt(totalRaw, 10) : 0;
  let received = 0;
  let lastReported = 0;

  const out = createWriteStream(outPath);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    out.write(value);
    if (total) {
      const pct = Math.floor((received / total) * 100);
      if (pct >= lastReported + 5) {
        process.stdout.write(
          `\r   ${pct}%  (${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`,
        );
        lastReported = pct;
      }
    }
  }
  out.end();
  process.stdout.write("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const url = argv[0];
  const outOverride = argv[1];
  if (!url) {
    console.error("Usage: npm run download-cspan -- '<c-span URL>' [output.mp4]");
    process.exit(1);
  }
  const programId = extractProgramId(url);
  const dir = path.join(OUT_DIR, "cspan", programId);
  await ensureDir(dir);
  const outPath = outOverride
    ? path.isAbsolute(outOverride)
      ? outOverride
      : path.resolve(ROOT, outOverride)
    : path.join(dir, "source.mp4");

  console.log(`-> Program ID: ${programId}`);
  console.log("-> Resolving player config");
  let videoUrl: string | null = null;
  try {
    const setup = await fetchJwSetup(programId);
    videoUrl = pickBestSource(setup);
  } catch (err) {
    console.warn(`! player setup failed: ${(err as Error).message}`);
  }
  let meta: Awaited<ReturnType<typeof fetchPageMetadata>> = {};
  try {
    meta = await fetchPageMetadata(url);
  } catch (err) {
    console.warn(`! metadata fetch failed: ${(err as Error).message}`);
  }
  if (!videoUrl && meta.ogVideo) {
    console.log("   falling back to og:video meta tag");
    videoUrl = meta.ogVideo;
  }
  if (!videoUrl) {
    console.error(
      "Couldn't find a video URL. C-SPAN may have changed their player. Open the page in a browser, copy the mp4 link from DevTools Network tab, and retry with the direct URL.",
    );
    process.exit(2);
  }

  console.log(`-> Downloading: ${videoUrl}`);
  await downloadWithProgress(videoUrl, outPath);

  const metaOut: CspanMetadata = {
    programId,
    title: meta.title,
    publishedDate: meta.publishedDate,
    pageUrl: url,
    videoUrl,
  };
  await fs.writeFile(
    path.join(path.dirname(outPath), "metadata.json"),
    JSON.stringify(metaOut, null, 2),
  );
  console.log(`\nDone -> ${path.relative(ROOT, outPath)}`);
  console.log(`Next: npm run transcribe -- ${path.relative(ROOT, outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
