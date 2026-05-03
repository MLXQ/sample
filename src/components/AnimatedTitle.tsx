import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Palette } from "../styles/theme";

type Props = {
  text: string;
  subtitle?: string;
  palette: Palette;
  /** Frame to start the animation. */
  delay?: number;
};

const splitWords = (text: string) => text.split(" ");

export const AnimatedTitle: React.FC<Props> = ({
  text,
  subtitle,
  palette,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = splitWords(text);

  const subtitleOpacity = interpolate(
    frame,
    [delay + words.length * 4 + 10, delay + words.length * 4 + 25],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const underlineProgress = spring({
    frame: frame - (delay + words.length * 4 + 6),
    fps,
    config: { damping: 18, stiffness: 80 },
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 120px",
      }}
    >
      <div
        style={{
          fontFamily: palette.serif,
          fontSize: 130,
          fontWeight: 700,
          color: palette.text,
          letterSpacing: -2,
          lineHeight: 1.05,
          textShadow: "0 4px 30px rgba(0,0,0,0.6)",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 24,
        }}
      >
        {words.map((word, i) => {
          const wordFrame = frame - (delay + i * 4);
          const opacity = interpolate(wordFrame, [0, 16], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const ty = interpolate(wordFrame, [0, 22], [40, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <span
              key={`${word}-${i}`}
              style={{
                display: "inline-block",
                opacity,
                transform: `translateY(${ty}px)`,
              }}
            >
              {word}
            </span>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 36,
          height: 3,
          width: `${Math.max(0, Math.min(1, underlineProgress)) * 320}px`,
          background: palette.accent,
          borderRadius: 2,
        }}
      />

      {subtitle ? (
        <div
          style={{
            marginTop: 32,
            fontFamily: palette.sans,
            fontSize: 36,
            fontWeight: 300,
            letterSpacing: 8,
            textTransform: "uppercase",
            color: palette.textMuted,
            opacity: subtitleOpacity,
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
};
