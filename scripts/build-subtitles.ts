/**
 * Build a bilingual ASS subtitle file from a bilingual transcript.
 * English on top (larger, white) + Korean below (smaller, yellow).
 *
 * ASS gives us per-line style + per-cue positioning — better than SRT
 * for the stacked bilingual look. Burns into video cleanly via
 * ffmpeg's `subtitles` filter.
 *
 * Usage:
 *   tsx scripts/build-subtitles.ts <bilingual-transcript.json> \
 *        --start 142.3 --end 168.7 --offset 0 \
 *        --out out/transcripts/altman/clip-01.ass
 *
 * When --start/--end are given, only segments overlapping that range
 * are exported, and timestamps are shifted by --offset so the ASS
 * timestamps start at 0 (so ffmpeg burns them in correctly when the
 * source clip itself starts at 0 after trimming).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib/paths.js";

type BilingualSegment = {
  start: number;
  end: number;
  en: string;
  ko: string;
};

type Args = {
  input: string;
  start: number;
  end: number;
  offset: number;
  outFile?: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { input: "", start: -Infinity, end: Infinity, offset: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--start") (out.start = parseFloat(v)), i++;
    else if (a === "--end") (out.end = parseFloat(v)), i++;
    else if (a === "--offset") (out.offset = parseFloat(v)), i++;
    else if (a === "--out") (out.outFile = v), i++;
    else if (!out.input) out.input = a;
  }
  return out;
}

function fmtAssTime(sec: number): string {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Escape special characters that ASS treats as control codes. */
function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function buildAss(
  segments: BilingualSegment[],
  start: number,
  end: number,
  offset: number,
): string {
  // Header: PlayResX/Y match our 1920x1080 canvas so margins line up
  // with the rendered video.
  const header = `[Script Info]
Title: Bilingual subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: English,Inter,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,2,2,120,120,140,1
Style: Korean,Inter,40,&H004CC2FF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,2,2,120,120,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];
  for (const s of segments) {
    if (s.end < start || s.start > end) continue;
    const segStart = Math.max(0, s.start - offset);
    const segEnd = Math.max(segStart + 0.1, s.end - offset);
    const en = escapeAss(s.en.trim());
    const ko = escapeAss(s.ko.trim());
    if (en) {
      events.push(
        `Dialogue: 0,${fmtAssTime(segStart)},${fmtAssTime(segEnd)},English,,0,0,0,,${en}`,
      );
    }
    if (ko) {
      events.push(
        `Dialogue: 0,${fmtAssTime(segStart)},${fmtAssTime(segEnd)},Korean,,0,0,0,,${ko}`,
      );
    }
  }
  return header + events.join("\n") + "\n";
}

async function main() {
  const args = parseArgs();
  if (!args.input) {
    console.error(
      "Usage: tsx scripts/build-subtitles.ts <bilingual-transcript.json> [--start S] [--end E] [--offset O] [--out file.ass]",
    );
    process.exit(1);
  }
  const abs = path.isAbsolute(args.input)
    ? args.input
    : path.resolve(ROOT, args.input);
  const raw = JSON.parse(await fs.readFile(abs, "utf-8")) as {
    segments: BilingualSegment[];
  };
  // Default offset = start, so the ASS timeline begins at 0
  const offset = isFinite(args.offset) ? args.offset : args.start;
  const finalStart = isFinite(args.start) ? args.start : 0;
  const finalEnd = isFinite(args.end) ? args.end : Infinity;
  const ass = buildAss(raw.segments, finalStart, finalEnd, offset);
  const outFile = args.outFile
    ? path.isAbsolute(args.outFile)
      ? args.outFile
      : path.resolve(ROOT, args.outFile)
    : abs.replace(/\.json$/, ".ass");
  await fs.writeFile(outFile, ass);
  console.log(`-> ${path.relative(ROOT, outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
