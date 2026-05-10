/**
 * Recording-guide video builder. Reads a script JSON (any of our supported
 * scene shapes) and produces a teleprompter-style mp4 the user plays in
 * a DAW (DaVinci Resolve / Descript / OBS / Audacity) while recording
 * narration over it.
 *
 * Each guide scene matches the corresponding source scene's exact
 * `durationSeconds`, so a voice take recorded against the guide will
 * line up frame-for-frame with the pilot mp4 produced by build-pilot.
 *
 * Banner shows: "SCENE k / N · LABEL"  +  large narration text  +
 * scene timer + progress bar + a 3-2-1 countdown in the final 3s of
 * the scene so the speaker knows when to wrap up.
 *
 * Usage:
 *   npm run guide -- data/sample-pilot.json [out/guide-pilot.mp4]
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas, GlobalFonts, SKRSContext2D } from "@napi-rs/canvas";
import { OUT_DIR, ROOT, ensureDir, PUBLIC_DIR, DATA_DIR } from "./lib/paths.js";
import type { Script, Scene } from "../src/types.js";
import { getPalette } from "../src/styles/theme.js";

const W = 1920;
const H = 1080;
const FPS = 30;
const SNAPSHOT_HZ = 5; // overlay refresh rate -> timer ticks 5x/sec

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg ${code}\n${err.slice(-1500)}`)),
    );
  });
}

function wrapText(ctx: SKRSContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > max && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function getSceneLabel(scene: Scene): string {
  switch (scene.type) {
    case "title":
      return "Title";
    case "outro":
      return "Outro";
    case "fact":
      return "Fact";
    case "countUpStat":
      return scene.label ?? "Stat";
    case "stackDiagram":
    case "marketShare":
    case "worldMap":
    case "flowDiagram":
    case "animatedChart":
    case "logoGrid":
    case "timeline":
      return scene.heading;
    case "narration":
      return scene.caption ?? "Narration";
    case "broll":
      return scene.chip ?? "B-roll";
  }
}

function drawTeleprompter(
  ctx: SKRSContext2D,
  scene: Scene,
  sceneNum: number,
  totalScenes: number,
  durSeconds: number,
  elapsed: number,
) {
  const palette = getPalette("explainer");

  // Solid backdrop — quiet, doesn't compete with the script.
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);
  // Subtle accent glow
  const r = ctx.createRadialGradient(W / 2, H * 0.15, 50, W / 2, H * 0.15, 1100);
  r.addColorStop(0, "rgba(255,210,61,0.18)");
  r.addColorStop(1, "transparent");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);

  // Top header bar
  ctx.fillStyle = palette.accent;
  ctx.font = '900 28px "Inter", sans-serif';
  ctx.fillText(
    `SCENE ${sceneNum} / ${totalScenes}  ·  ${getSceneLabel(scene).toUpperCase()}`,
    60,
    50,
  );

  // Scene type badge (top-left below header)
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = '600 22px "Inter", sans-serif';
  ctx.fillText(`type: ${scene.type}`, 60, 84);

  // Scene timer (top-right)
  ctx.fillStyle = palette.accent;
  ctx.font = '900 28px "Inter", sans-serif';
  const timerStr = `${elapsed.toFixed(1)}s / ${durSeconds.toFixed(1)}s`;
  const tw = ctx.measureText(timerStr).width;
  ctx.fillText(timerStr, W - 60 - tw, 50);

  // Big narration script (centered, large readable type)
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = '700 60px "Inter", sans-serif';
  const script = (scene as { narration?: string }).narration ?? "";
  const lines = wrapText(ctx, script, W - 240);
  const lineH = 84;
  const totalH = lines.length * lineH;
  const startY = (H - totalH) / 2 + lineH / 2;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * lineH));
  ctx.textAlign = "start";

  // Word count (small, below script) so user knows how dense it is
  const wc = script.split(/\s+/).filter(Boolean).length;
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = '500 22px "Inter", sans-serif';
  ctx.textAlign = "center";
  const targetWpm = Math.round((wc / durSeconds) * 60);
  ctx.fillText(
    `${wc} words · target ~${targetWpm} wpm`,
    W / 2,
    startY + totalH + 30,
  );
  ctx.textAlign = "start";

  // Progress bar across the bottom of the header band
  const barTop = 120;
  const barW = W - 120;
  const pct = Math.min(1, elapsed / durSeconds);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(60, barTop, barW, 6);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(60, barTop, barW * pct, 6);

  // Last-3-seconds countdown — shows large 3, 2, 1 in the lower right
  const remaining = durSeconds - elapsed;
  if (remaining <= 3 && remaining > 0) {
    const countdownVal = Math.ceil(remaining);
    const cx = W - 200;
    const cy = H - 200;
    // Pulsing red ring
    ctx.strokeStyle = "#ff5e3a";
    ctx.lineWidth = 6;
    const ringR = 90;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 8);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR + pulse * 6, 0, Math.PI * 2);
    ctx.stroke();
    // Number
    ctx.fillStyle = "#ff5e3a";
    ctx.font = '900 110px "Inter", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(String(countdownVal), cx, cy + 38);
    ctx.textAlign = "start";
  }

  // Pre-roll countdown (3-2-1 at start)
  if (elapsed < 1.5) {
    const countdownVal = Math.ceil(1.5 - elapsed);
    if (countdownVal > 0) {
      const cx = W / 2;
      const cy = H / 2;
      ctx.fillStyle = palette.accent;
      ctx.font = '900 240px "Inter", sans-serif';
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 30;
      ctx.fillText(String(countdownVal), cx, cy + 40);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.textAlign = "start";
    }
  }
}

async function renderSceneOverlays(
  scene: Scene,
  sceneNum: number,
  totalScenes: number,
  durSeconds: number,
  outDir: string,
): Promise<{ overlays: { file: string; startFrame: number; endFrame: number }[] }> {
  await ensureDir(outDir);
  const totalFrames = Math.round(durSeconds * FPS);
  const framesPerSnap = Math.round(FPS / SNAPSHOT_HZ);
  const snaps = Math.ceil(totalFrames / framesPerSnap);
  const overlays: { file: string; startFrame: number; endFrame: number }[] = [];

  for (let s = 0; s < snaps; s++) {
    const elapsed = s / SNAPSHOT_HZ;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as SKRSContext2D;
    drawTeleprompter(ctx, scene, sceneNum, totalScenes, durSeconds, elapsed);
    const file = path.join(outDir, `${String(s).padStart(3, "0")}.png`);
    await fs.writeFile(file, await canvas.encode("png"));
    const startFrame = s * framesPerSnap;
    const endFrame = s === snaps - 1 ? totalFrames : (s + 1) * framesPerSnap;
    overlays.push({ file, startFrame, endFrame });
  }
  return { overlays };
}

async function renderSceneClip(
  durSeconds: number,
  overlays: { file: string; startFrame: number; endFrame: number }[],
  outFile: string,
): Promise<void> {
  // Background: solid dark (overlays already render their own backdrop).
  // Loop a single black PNG OR use lavfi color source.
  const args: string[] = ["-y"];
  args.push(
    "-f",
    "lavfi",
    "-i",
    `color=c=0x000000:s=${W}x${H}:r=${FPS}`,
  );
  for (const o of overlays) args.push("-loop", "1", "-i", o.file);

  const filters: string[] = [];
  filters.push(
    `[0:v]trim=duration=${durSeconds.toFixed(3)},setpts=PTS-STARTPTS[base]`,
  );
  let prev = "[base]";
  const totalFrames = Math.round(durSeconds * FPS);
  for (let i = 0; i < overlays.length; i++) {
    const o = overlays[i];
    const out = i === overlays.length - 1 ? "[v]" : `[ov${i}]`;
    const t1 = (o.startFrame / FPS).toFixed(3);
    const t2 = (o.endFrame / FPS).toFixed(3);
    filters.push(
      `${prev}[${i + 1}:v]overlay=0:0:enable='between(t,${t1},${t2})'${out}`,
    );
    prev = out;
  }

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    "-frames:v",
    String(totalFrames),
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-crf",
    "20",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outFile,
  );
  await ffmpeg(args);
}

async function concatClips(inputs: string[], outFile: string): Promise<void> {
  const listFile = path.join(path.dirname(outFile), "concat-list.txt");
  await fs.writeFile(
    listFile,
    inputs.map((f) => `file '${path.resolve(f)}'`).join("\n"),
  );
  await ffmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    outFile,
  ]);
  await fs.unlink(listFile).catch(() => undefined);
}

async function writeScriptMarkdown(
  script: Script,
  outFile: string,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# ${script.title}`);
  if (script.subtitle) lines.push(`*${script.subtitle}*`);
  lines.push("");
  lines.push(
    `Total scenes: ${script.scenes.length}. Read each scene's text aloud during the matching window in the recording-guide video. Bold timer means you have under 3 seconds left.`,
  );
  lines.push("");

  let cumul = 0;
  for (let i = 0; i < script.scenes.length; i++) {
    const s = script.scenes[i] as Scene & { narration?: string; durationSeconds?: number };
    const dur = s.durationSeconds ?? 5;
    const start = cumul;
    const end = cumul + dur;
    cumul = end;
    const wc = (s.narration ?? "").split(/\s+/).filter(Boolean).length;
    const wpm = Math.round((wc / dur) * 60);
    lines.push(
      `## Scene ${i + 1}  ·  ${getSceneLabel(s)}  ·  ${start.toFixed(1)}s → ${end.toFixed(1)}s  (${dur.toFixed(1)}s, ${wc} words ≈ ${wpm} wpm)`,
    );
    lines.push("");
    lines.push(`> ${s.narration ?? "(no narration)"}`);
    lines.push("");
  }
  await fs.writeFile(outFile, lines.join("\n"));
}

async function main() {
  const argv = process.argv.slice(2);
  const scriptPath =
    argv[0] ?? path.join(DATA_DIR, "sample-pilot.json");
  const outVideo =
    argv[1] ?? path.join(OUT_DIR, "recording-guide-pilot.mp4");

  for (const f of [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ]) {
    try {
      await fs.access(f);
      GlobalFonts.registerFromPath(f, "Inter");
      break;
    } catch {
      // try next
    }
  }

  const raw = await fs.readFile(scriptPath, "utf-8");
  const script = JSON.parse(raw) as Script;

  const tmpDir = path.join(OUT_DIR, "guide-pilot-clips");
  const ovlDir = path.join(OUT_DIR, "guide-pilot-overlays");
  await ensureDir(tmpDir);
  await ensureDir(ovlDir);

  console.log(`-> Building guide for ${script.scenes.length} scenes`);
  const clips: string[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const s = script.scenes[i] as Scene & { durationSeconds?: number };
    const dur = s.durationSeconds ?? 5;
    const sceneOvlDir = path.join(ovlDir, String(i).padStart(2, "0"));
    const sceneClip = path.join(tmpDir, `${String(i).padStart(2, "0")}.mp4`);
    const start = Date.now();
    const { overlays } = await renderSceneOverlays(
      s,
      i + 1,
      script.scenes.length,
      dur,
      sceneOvlDir,
    );
    await renderSceneClip(dur, overlays, sceneClip);
    clips.push(sceneClip);
    console.log(
      `   [${i + 1}/${script.scenes.length}] ${s.type.padEnd(15)} ${dur.toFixed(1)}s (${Date.now() - start}ms)`,
    );
  }

  console.log("-> Concatenating");
  await concatClips(clips, outVideo);

  // Drop the markdown alongside
  const mdOut = outVideo.replace(/\.mp4$/, ".md");
  await writeScriptMarkdown(script, mdOut);

  console.log(`\nDone:`);
  console.log(`  video  -> ${path.relative(ROOT, outVideo)}`);
  console.log(`  script -> ${path.relative(ROOT, mdOut)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
