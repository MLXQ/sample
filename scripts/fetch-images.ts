import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { GeneratedScript } from "./lib/script-schema.js";
import { ensureDir, IMAGES_DIR, slugify } from "./lib/paths.js";

type WikiSearchResult = {
  query?: { search?: { title: string }[] };
};
type WikiImageInfoResult = {
  query?: {
    pages?: Record<
      string,
      { imageinfo?: { url: string; mime: string; width: number }[] }
    >;
  };
};

const UA =
  "history-fact-videos/0.1 (https://github.com/; education) node-fetch";

async function searchCommons(query: string): Promise<string | null> {
  const searchUrl = new URL("https://commons.wikimedia.org/w/api.php");
  searchUrl.searchParams.set("action", "query");
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("list", "search");
  searchUrl.searchParams.set("srsearch", query);
  searchUrl.searchParams.set("srnamespace", "6"); // File namespace
  searchUrl.searchParams.set("srlimit", "10");

  const sr = (await (
    await fetch(searchUrl, { headers: { "User-Agent": UA } })
  ).json()) as WikiSearchResult;
  const candidates = sr.query?.search ?? [];
  for (const c of candidates) {
    const url = await resolveImageUrl(c.title);
    if (url) return url;
  }
  return null;
}

async function resolveImageUrl(fileTitle: string): Promise<string | null> {
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  u.searchParams.set("action", "query");
  u.searchParams.set("format", "json");
  u.searchParams.set("titles", fileTitle);
  u.searchParams.set("prop", "imageinfo");
  u.searchParams.set("iiprop", "url|mime|size");
  u.searchParams.set("iiurlwidth", "1920");

  const r = (await (
    await fetch(u, { headers: { "User-Agent": UA } })
  ).json()) as WikiImageInfoResult;
  const pages = r.query?.pages ?? {};
  for (const k of Object.keys(pages)) {
    const info = pages[k].imageinfo?.[0];
    if (!info) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) continue;
    return info.url;
  }
  return null;
}

async function downloadTo(url: string, outFile: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outFile, buf);
}

function ext(url: string): string {
  const m = url.match(/\.(jpe?g|png|webp)(?:$|\?)/i);
  return m ? `.${m[1].toLowerCase().replace("jpeg", "jpg")}` : ".jpg";
}

/**
 * Walks the script, finds every imageQuery / backgroundImageQuery,
 * downloads the best Wikimedia match into public/images/, and replaces
 * the query field with a concrete `image` / `backgroundImage` filename
 * the Remotion components consume.
 */
export async function fetchImagesForScript(
  script: GeneratedScript,
): Promise<void> {
  await ensureDir(IMAGES_DIR);

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const sceneAny = scene as Record<string, unknown>;

    const fields: ("imageQuery" | "backgroundImageQuery")[] = [
      "imageQuery",
      "backgroundImageQuery",
    ];

    for (const field of fields) {
      const query = sceneAny[field];
      if (typeof query !== "string" || !query) continue;

      const filenameBase = `${i.toString().padStart(2, "0")}-${slugify(query, 40)}`;
      let url: string | null = null;
      try {
        url = await searchCommons(query);
      } catch (err) {
        console.warn(`! commons search failed for "${query}":`, err);
      }
      if (!url) {
        console.warn(`! no image found for "${query}" — leaving placeholder`);
        continue;
      }
      const filename = `${filenameBase}${ext(url)}`;
      const outFile = path.join(IMAGES_DIR, filename);
      try {
        await downloadTo(url, outFile);
      } catch (err) {
        console.warn(`! download failed for "${query}":`, err);
        continue;
      }
      const target = field === "imageQuery" ? "image" : "backgroundImage";
      sceneAny[target] = filename;
      delete sceneAny[field];
      console.log(`  + ${field} "${query}" -> images/${filename}`);
    }
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run images -- <path-to-script.json>");
    process.exit(1);
  }
  const raw = await fs.readFile(file, "utf-8");
  const script = JSON.parse(raw) as GeneratedScript;
  await fetchImagesForScript(script);
  await fs.writeFile(file, JSON.stringify(script, null, 2), "utf-8");
  console.log(`-> Updated ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
