import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import {
  selectComposition,
  renderMedia,
  RenderMediaOnProgress,
} from "@remotion/renderer";
import { generateScript } from "./generate-script.js";
import { fetchMediaForScript } from "./fetch-media.js";
import { generateNarrationForScript } from "./generate-narration.js";
import { DATA_DIR, ensureDir, OUT_DIR, ROOT, slugify } from "./lib/paths.js";

function step(n: number, total: number, msg: string) {
  console.log(`\n[${n}/${total}] ${msg}`);
}

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) {
    console.error('Usage: npm run create -- "Your topic here"');
    process.exit(1);
  }

  const TOTAL = 5;

  step(1, TOTAL, `Writing script for: ${topic}`);
  const script = await generateScript(topic);
  const slug = slugify(script.title);
  await ensureDir(path.join(DATA_DIR, "generated"));
  const scriptPath = path.join(DATA_DIR, "generated", `${slug}.json`);
  await fs.writeFile(scriptPath, JSON.stringify(script, null, 2), "utf-8");
  console.log(`  ok -> ${path.relative(ROOT, scriptPath)}`);

  step(2, TOTAL, "Downloading photos (Wikimedia) + B-roll videos (Pexels)");
  await fetchMediaForScript(script);
  await fs.writeFile(scriptPath, JSON.stringify(script, null, 2), "utf-8");

  step(3, TOTAL, "Generating English narration (OpenAI TTS)");
  await generateNarrationForScript(script);
  await fs.writeFile(scriptPath, JSON.stringify(script, null, 2), "utf-8");

  step(4, TOTAL, "Bundling Remotion project");
  // Point Root.tsx at the freshly generated script for studio runs as well.
  process.env.REMOTION_SCRIPT_PATH = scriptPath;
  const bundleLocation = await bundle({
    entryPoint: path.join(ROOT, "src/index.ts"),
    webpackOverride: (c) => c,
  });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "HistoryVideo",
    inputProps: { script },
  });

  step(5, TOTAL, `Rendering ${composition.durationInFrames} frames @ ${composition.fps}fps`);
  await ensureDir(OUT_DIR);
  const outFile = path.join(OUT_DIR, `${slug}.mp4`);

  let lastPct = -1;
  const onProgress: RenderMediaOnProgress = ({ progress }) => {
    const pct = Math.floor(progress * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      console.log(`  ... ${pct}%`);
      lastPct = pct;
    }
  };

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: "h264",
    outputLocation: outFile,
    inputProps: { script },
    crf: 17,
    pixelFormat: "yuv420p",
    onProgress,
    concurrency: 4,
  });

  console.log(`\nDone -> ${path.relative(ROOT, outFile)}`);
  console.log(
    `Upload to YouTube directly, or run "npm run studio" to tweak before re-rendering.`,
  );
}

main().catch((err) => {
  console.error("\nPipeline failed:", err);
  process.exit(1);
});
