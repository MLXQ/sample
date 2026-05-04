import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Palette } from "../styles/theme";

type Props = {
  /**
   * Subtitle text. Words wrapped in **double asterisks** are highlighted
   * in the accent color (Veritasium / Cleo Abram style keyword pop).
   */
  text: string;
  palette: Palette;
  /** "center" floats the subtitle in the middle, "bottom" sits in lower third. */
  position?: "center" | "bottom";
};

type Token = { text: string; highlight: boolean };

function tokenize(text: string): Token[] {
  // Split on **...** while keeping the fragments
  const out: Token[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index), highlight: false });
    }
    out.push({ text: m[1], highlight: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), highlight: false });
  return out;
}

function flattenWords(tokens: Token[]): { word: string; highlight: boolean }[] {
  const words: { word: string; highlight: boolean }[] = [];
  for (const t of tokens) {
    const parts = t.text.split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) {
        if (words.length) words[words.length - 1].word += p;
        continue;
      }
      words.push({ word: p, highlight: t.highlight });
    }
  }
  return words;
}

export const HeroSubtitle: React.FC<Props> = ({
  text,
  palette,
  position = "bottom",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const words = flattenWords(tokenize(text));

  const revealStart = 4;
  const revealEnd = durationInFrames - 6;
  const span = Math.max(1, revealEnd - revealStart);
  const wordsPerFrame = words.length / span;

  const containerOpacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const containerStyle: React.CSSProperties =
    position === "center"
      ? {
          position: "absolute",
          left: 0,
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          padding: "0 120px",
        }
      : {
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 120,
          padding: "0 120px",
        };

  return (
    <div
      style={{
        ...containerStyle,
        display: "flex",
        justifyContent: "center",
        opacity: containerOpacity,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          maxWidth: 1600,
          textAlign: "center",
          fontFamily: palette.sans,
          fontSize: 84,
          fontWeight: 800,
          lineHeight: 1.15,
          letterSpacing: -1.5,
          color: palette.text,
          textShadow:
            "0 4px 24px rgba(0,0,0,0.85), 0 1px 0 rgba(0,0,0,0.6)",
        }}
      >
        {words.map((w, i) => {
          const reveal = (frame - revealStart) * wordsPerFrame;
          const wordProgress = reveal - i;
          const opacity = interpolate(wordProgress, [-0.2, 0.4], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const ty = interpolate(wordProgress, [-0.2, 0.4], [12, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                opacity,
                transform: `translateY(${ty}px)`,
                color: w.highlight ? palette.accent : palette.text,
                whiteSpace: "pre",
              }}
            >
              {w.word}
            </span>
          );
        })}
      </div>
    </div>
  );
};
