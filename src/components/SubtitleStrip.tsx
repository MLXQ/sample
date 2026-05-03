import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Palette } from "../styles/theme";

type Props = {
  text: string;
  palette: Palette;
};

/**
 * Karaoke-style narration subtitle strip: progressively reveals words
 * timed evenly across the scene's duration. Useful for accessibility
 * and silent-autoplay viewers (most YouTube feeds).
 */
export const SubtitleStrip: React.FC<Props> = ({ text, palette }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const words = text.split(/\s+/).filter(Boolean);
  const revealStart = 6;
  const revealEnd = durationInFrames - 6;
  const span = Math.max(1, revealEnd - revealStart);
  const wordsPerFrame = words.length / span;
  const visibleCount = Math.min(
    words.length,
    Math.max(0, Math.floor((frame - revealStart) * wordsPerFrame)),
  );

  const stripOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 60,
        display: "flex",
        justifyContent: "center",
        opacity: stripOpacity,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          maxWidth: 1500,
          padding: "18px 32px",
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(6px)",
          borderRadius: 8,
          fontFamily: palette.sans,
          fontSize: 34,
          fontWeight: 500,
          color: palette.textMuted,
          textAlign: "center",
          lineHeight: 1.35,
        }}
      >
        {words.map((w, i) => (
          <span
            key={i}
            style={{
              color: i < visibleCount ? palette.text : "rgba(255,255,255,0.25)",
              transition: "color 0.1s linear",
              marginRight: 10,
            }}
          >
            {w}
          </span>
        ))}
      </div>
    </div>
  );
};
