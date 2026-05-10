/**
 * Procedural BGM generator. Writes a short MIDI file using
 * midi-writer-js, renders it to WAV via timidity (FluidR3_GM
 * soundfont), then encodes to MP3 with ffmpeg. Output lives in
 * public/audio/bgm/<mood>.mp3 and is loopable.
 *
 * The "moods" map to scene-mood chips in our scripts:
 *  - curious        -> default backbone, 84 BPM, A-minor piano arpeggios + pad
 *  - dramatic       -> "The Twist" / climax, 76 BPM, low piano + cello pad
 *  - calm           -> intro/outro, 70 BPM, gentle Rhodes + sustained strings
 *
 * Each track is ~32 bars (~75-90 seconds) and starts/ends on the
 * tonic so a hard loop sounds clean.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
// midi-writer-js is CJS; tsx handles the interop.
import MidiWriter from "midi-writer-js";
import { ROOT, ensureDir, PUBLIC_DIR } from "./lib/paths.js";

const BGM_DIR = path.join(PUBLIC_DIR, "audio", "bgm");

type Mood = "curious" | "dramatic" | "calm" | "tech";

type ChordVoicing = number[]; // MIDI numbers, low-to-high

// MIDI helpers ----------------------------------------------------

const NOTE_DURATIONS = {
  whole: "1",
  half: "2",
  quarter: "4",
  eighth: "8",
  sixteenth: "16",
} as const;

function midiNote(n: number): string {
  // midi-writer-js wants pitch strings (e.g. "C4"), but it also accepts
  // raw MIDI numbers as numbers. Use numbers to skip name conversion.
  return String(n) as unknown as string;
}

// Common voicings used across moods. All in C as reference, transpose
// per-mood by adding semitone offsets when emitting.
const VOICINGS: Record<string, ChordVoicing> = {
  i: [60, 63, 67], // C minor
  iv: [65, 68, 72], // F minor
  VI: [56, 60, 63], // Ab major (relative)
  V: [55, 59, 62], // G major
  III: [51, 55, 58], // Eb major
  VII: [58, 62, 65], // Bb major
};

type ProgressionStep = { chord: keyof typeof VOICINGS; bars: number };

function makeArpeggio(
  voicing: ChordVoicing,
  octaveShift: number,
  pattern: number[],
): number[] {
  const expanded: number[] = [];
  for (const idx of pattern) {
    expanded.push(voicing[idx % voicing.length] + 12 * octaveShift);
  }
  return expanded;
}

function makeMoodTrack(mood: Mood): MidiWriter.Track[] {
  // Tempo + key per mood
  const tempos: Record<Mood, number> = {
    curious: 84,
    dramatic: 70,
    calm: 66,
  };
  const transpose: Record<Mood, number> = {
    curious: 0, // C minor
    dramatic: -3, // A minor (lower, brooding)
    calm: 2, // D minor (slightly brighter)
  };
  const t = transpose[mood];
  const bpm = tempos[mood];

  // Progression (8 bars, looped 4x = 32 bars)
  const progression: ProgressionStep[] = [
    { chord: "i", bars: 2 },
    { chord: "VI", bars: 2 },
    { chord: "iv", bars: 2 },
    { chord: "V", bars: 2 },
  ];

  // ----- Track 1: piano arpeggios -----
  const piano = new MidiWriter.Track();
  piano.setTempo(bpm);
  piano.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: mood === "calm" ? 5 : 1 }));
  // 1 = Acoustic Grand, 5 = Electric Piano

  // 16th-note arpeggio pattern indices into [bass, mid, top]
  const arpPattern =
    mood === "dramatic"
      ? [0, 1, 2, 1, 0, 2, 1, 2]
      : mood === "calm"
        ? [0, 2, 1, 2, 0, 2, 1, 2]
        : [0, 1, 2, 1, 2, 0, 1, 2];

  const loops = 4;
  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const v = VOICINGS[step.chord].map((n) => n + t);
      const notes = makeArpeggio(v, 0, arpPattern); // 8 notes per bar
      for (let bar = 0; bar < step.bars; bar++) {
        for (const n of notes) {
          piano.addEvent(
            new MidiWriter.NoteEvent({
              pitch: [midiNote(n)],
              duration: NOTE_DURATIONS.eighth,
              velocity: 38 + Math.floor(Math.random() * 10),
            }),
          );
        }
      }
    }
  }

  // ----- Track 2: sustained pad / strings -----
  const pad = new MidiWriter.Track();
  pad.setTempo(bpm);
  pad.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: mood === "dramatic" ? 42 : 49 }));
  // 42 = Cello, 49 = String Ensemble 1

  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const v = VOICINGS[step.chord].map((n) => n + t - 12);
      // One whole-note voicing per bar
      for (let bar = 0; bar < step.bars; bar++) {
        pad.addEvent(
          new MidiWriter.NoteEvent({
            pitch: v.map(midiNote),
            duration: NOTE_DURATIONS.whole,
            velocity: 28,
          }),
        );
      }
    }
  }

  // ----- Track 3: low bass -----
  const bass = new MidiWriter.Track();
  bass.setTempo(bpm);
  bass.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 33 })); // Electric Bass

  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const root = VOICINGS[step.chord][0] + t - 24;
      for (let bar = 0; bar < step.bars; bar++) {
        // Half-note root
        bass.addEvent(
          new MidiWriter.NoteEvent({
            pitch: [midiNote(root)],
            duration: NOTE_DURATIONS.half,
            velocity: 50,
          }),
        );
        // Octave-up rest of the bar
        bass.addEvent(
          new MidiWriter.NoteEvent({
            pitch: [midiNote(root + 12)],
            duration: NOTE_DURATIONS.half,
            velocity: 36,
          }),
        );
      }
    }
  }

  return [piano, pad, bass];
}

// Renderers -------------------------------------------------------

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exit ${code}\n${err.slice(-1500)}`)),
    );
  });
}

async function midiToMp3(midiFile: string, mp3File: string): Promise<void> {
  const wav = midiFile.replace(/\.mid$/, ".wav");
  await run("timidity", [
    midiFile,
    "-Ow",
    "-o",
    wav,
    "--output-stereo",
    "-A120",
    "-EFreverb=1,80",
    "-EFchorus=2,40",
    "-s",
    "44100",
  ]);
  // Apply a soft compressor + light EQ + fade in/out, encode to mp3.
  await run("ffmpeg", [
    "-y",
    "-i",
    wav,
    "-filter:a",
    "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=20:release=200,afade=t=in:st=0:d=2,afade=t=out:st=70:d=2",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "192k",
    mp3File,
  ]);
  await fs.unlink(wav).catch(() => undefined);
}

/**
 * Bright tech/explainer track — fundamentally different from the
 * other moods (which are minor-key piano + cello). Major key (C),
 * 108 BPM, saw-lead 16th-note arpeggios, warm pad, synth bass, and
 * a 4-on-the-floor drum kit. Designed for AI / startup / tech
 * explainer videos where the existing dramatic track felt too somber.
 */
function makeTechTrack(): MidiWriter.Track[] {
  const bpm = 108;

  // I - V - vi - IV in C major (the universal pop / cinematic-tech progression)
  const CHORDS: Record<string, number[]> = {
    I: [60, 64, 67], // C major
    V: [55, 59, 62], // G major
    vi: [57, 60, 64], // A minor
    IV: [53, 57, 60], // F major
  };
  type Step = { chord: keyof typeof CHORDS; bars: number };
  const progression: Step[] = [
    { chord: "I", bars: 2 },
    { chord: "V", bars: 2 },
    { chord: "vi", bars: 2 },
    { chord: "IV", bars: 2 },
  ];
  const loops = 4; // ~75s at 108 BPM, perfect loop length for a 2-min video

  // Track 1: saw lead 16th-note arpeggio (the "tech" signature sound)
  const lead = new MidiWriter.Track();
  lead.setTempo(bpm);
  lead.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 82 })); // Saw Lead
  // up-down arpeggio of the chord's 3 voices, plus an octave-up climb
  const arpPattern = [0, 1, 2, 1, 0, 2, 1, 2]; // 8 sixteenth notes per bar pair
  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const v = CHORDS[step.chord];
      for (let bar = 0; bar < step.bars; bar++) {
        for (const idx of arpPattern) {
          lead.addEvent(
            new MidiWriter.NoteEvent({
              pitch: [midiNote(v[idx] + 12)],
              duration: NOTE_DURATIONS.eighth,
              velocity: 34 + Math.floor(Math.random() * 10),
            }),
          );
        }
      }
    }
  }

  // Track 2: warm pad sustained
  const pad = new MidiWriter.Track();
  pad.setTempo(bpm);
  pad.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 90 })); // Warm Pad
  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const v = CHORDS[step.chord];
      for (let bar = 0; bar < step.bars; bar++) {
        pad.addEvent(
          new MidiWriter.NoteEvent({
            pitch: v.map(midiNote),
            duration: NOTE_DURATIONS.whole,
            velocity: 30,
          }),
        );
      }
    }
  }

  // Track 3: synth bass — root + octave alternation, quarter notes
  const bass = new MidiWriter.Track();
  bass.setTempo(bpm);
  bass.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 39 })); // Synth Bass 1
  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const root = CHORDS[step.chord][0] - 24;
      for (let bar = 0; bar < step.bars; bar++) {
        // 1: root, 1.5: octave, 2: root, 2.5: octave, ... pumping eighth-bass
        for (let beat = 0; beat < 8; beat++) {
          const pitch = beat % 2 === 0 ? root : root + 12;
          bass.addEvent(
            new MidiWriter.NoteEvent({
              pitch: [midiNote(pitch)],
              duration: NOTE_DURATIONS.eighth,
              velocity: beat % 2 === 0 ? 55 : 38,
            }),
          );
        }
      }
    }
  }

  // Track 4: drums on channel 10 (GM drum kit auto-selected by timidity)
  // Pattern: kick on 1/3, snare on 2/4, hi-hat on every 8th
  const drums = new MidiWriter.Track();
  drums.setTempo(bpm);
  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      for (let bar = 0; bar < step.bars; bar++) {
        // 8 eighth notes per bar:
        //   1   1.5  2    2.5  3    3.5  4    4.5
        //   K+H H    S+H  H    K+H  H    S+H  H
        const beats: number[][] = [
          [36, 42],
          [42],
          [38, 42],
          [42],
          [36, 42],
          [42],
          [38, 42],
          [42],
        ];
        for (const pitches of beats) {
          drums.addEvent(
            new MidiWriter.NoteEvent({
              pitch: pitches.map(midiNote),
              duration: NOTE_DURATIONS.eighth,
              velocity: 65,
              channel: 10,
            }),
          );
        }
      }
    }
  }

  // Track 5: bright pluck on top (electric piano) — sparse, every 2 bars on beat 1
  const pluck = new MidiWriter.Track();
  pluck.setTempo(bpm);
  pluck.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 5 })); // Electric Piano 1
  for (let loop = 0; loop < loops; loop++) {
    for (const step of progression) {
      const v = CHORDS[step.chord];
      for (let bar = 0; bar < step.bars; bar++) {
        // Beat 1: top note of chord, an octave up
        pluck.addEvent(
          new MidiWriter.NoteEvent({
            pitch: [midiNote(v[2] + 12)],
            duration: NOTE_DURATIONS.half,
            velocity: 32,
          }),
        );
        // Rest of bar = silence (handled by next loop iteration's tempo)
        pluck.addEvent(
          new MidiWriter.NoteEvent({
            pitch: [midiNote(v[2] + 12)],
            duration: NOTE_DURATIONS.half,
            velocity: 0, // effectively silent
          }),
        );
      }
    }
  }

  return [lead, pad, bass, drums, pluck];
}

async function main() {
  await ensureDir(BGM_DIR);
  const moods: Mood[] = ["curious", "dramatic", "calm", "tech"];
  for (const mood of moods) {
    console.log(`-> ${mood}`);
    const tracks = mood === "tech" ? makeTechTrack() : makeMoodTrack(mood);
    const writer = new MidiWriter.Writer(tracks);
    const midiPath = path.join(BGM_DIR, `${mood}.mid`);
    const mp3Path = path.join(BGM_DIR, `${mood}.mp3`);
    await fs.writeFile(midiPath, writer.buildFile());
    await midiToMp3(midiPath, mp3Path);
    console.log(`   wrote ${path.relative(ROOT, mp3Path)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
