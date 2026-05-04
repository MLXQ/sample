import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { GeneratedScript } from "./lib/script-schema.js";
import { ensureDir, IMAGES_DIR, PUBLIC_DIR, slugify } from "./lib/paths.js";
import { fetchImagesForScript } from "./fetch-images.js";

const VIDEOS_DIR = path.join(PUBLIC_DIR, "videos");
const UA = "history-fact-videos/0.1 (education)";

type PexelsVideoFile = {
  link: string;
  width: number;
  height: number;
  quality: string;
  file_type: string;
};
type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  duration: number;
  video_files: PexelsVideoFile[];
};
type PexelsSearchResponse = {
  videos: PexelsVideo[];
};

function pickBestFile(v: PexelsVideo): PexelsVideoFile | null {
  // Prefer mp4 at >= 1080p height, otherwise the highest available.
  const mp4s = v.video_files.filter((f) => f.file_type.includes("mp4"));
  const sorted = [...mp4s].sort((a, b) => b.height - a.height);
  const hd = sorted.find((f) => f.height >= 1080);
  return hd ?? sorted[0] ?? null;
}

async function searchPexels(
  query: string,
  apiKey: string,
): Promise<PexelsVideo | null> {
  const u = new URL("https://api.pexels.com/videos/search");
  u.searchParams.set("query", query);
  u.searchParams.set("per_page", "8");
  u.searchParams.set("orientation", "landscape");
  u.searchParams.set("size", "medium");

  const res = await fetch(u, {
    headers: { Authorization: apiKey, "User-Agent": UA },
  });
  if (!res.ok) {
    console.warn(`! pexels search ${query} -> ${res.status}`);
    return null;
  }
  const data = (await res.json()) as PexelsSearchResponse;
  // Filter to clips between 4-20s long that have a usable mp4.
  const usable = (data.videos ?? []).filter((v) => {
    if (v.duration < 4 || v.duration > 20) return false;
    return pickBestFile(v) !== null;
  });
  return usable[0] ?? null;
}

async function downloadTo(url: string, outFile: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outFile, buf);
}

async function fetchBrollForScript(script: GeneratedScript): Promise<void> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn("! PEXELS_API_KEY missing — skipping B-roll fetch");
    return;
  }
  await ensureDir(VIDEOS_DIR);

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    if (scene.type !== "broll") continue;
    const sceneAny = scene as Record<string, unknown> & {
      brollQueries?: string[];
      clips?: { src: string }[];
    };
    const queries = sceneAny.brollQueries ?? [];
    const clips: { src: string }[] = [];
    for (let j = 0; j < queries.length; j++) {
      const q = queries[j];
      const video = await searchPexels(q, apiKey);
      if (!video) {
        console.warn(`  ! no pexels result for "${q}"`);
        continue;
      }
      const file = pickBestFile(video);
      if (!file) continue;
      const filename = `${i.toString().padStart(2, "0")}-${j.toString().padStart(2, "0")}-${slugify(q, 30)}.mp4`;
      const out = path.join(VIDEOS_DIR, filename);
      try {
        await downloadTo(file.link, out);
      } catch (err) {
        console.warn(`  ! download failed for "${q}":`, err);
        continue;
      }
      clips.push({ src: filename });
      console.log(`  + broll "${q}" -> videos/${filename}`);
    }
    sceneAny.clips = clips;
    delete sceneAny.brollQueries;
  }
}

export async function fetchMediaForScript(
  script: GeneratedScript,
): Promise<void> {
  await fetchImagesForScript(script);
  await fetchBrollForScript(script);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run media -- <path-to-script.json>");
    process.exit(1);
  }
  const raw = await fs.readFile(file, "utf-8");
  const script = JSON.parse(raw) as GeneratedScript;
  await fetchMediaForScript(script);
  await fs.writeFile(file, JSON.stringify(script, null, 2), "utf-8");
  console.log(`-> Updated ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
