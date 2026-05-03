import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Palette } from "../styles/theme";

type Props = {
  caption?: string;
  date?: string;
  palette: Palette;
};

/**
 * Lower-third caption: date label + location/person line, slides in
 * from the left, fades out near the end.
 */
export const AnimatedCaption: React.FC<Props> = ({
  caption,
  date,
  palette,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const slideIn = interpolate(frame, [10, 30], [-60, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeIn = interpolate(frame, [10, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 25, durationInFrames - 5],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const opacity = Math.min(fadeIn, fadeOut);

  if (!caption && !date) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        bottom: 110,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        transform: `translateX(${slideIn}px)`,
        opacity,
      }}
    >
      {date ? (
        <div
          style={{
            fontFamily: palette.sans,
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: palette.accent,
            padding: "8px 18px",
            background: "rgba(0,0,0,0.55)",
            border: `1px solid ${palette.accent}`,
            alignSelf: "flex-start",
            backdropFilter: "blur(8px)",
          }}
        >
          {date}
        </div>
      ) : null}
      {caption ? (
        <div
          style={{
            fontFamily: palette.serif,
            fontSize: 56,
            fontWeight: 600,
            color: palette.text,
            textShadow: "0 2px 14px rgba(0,0,0,0.85)",
            maxWidth: 1200,
            lineHeight: 1.15,
          }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
};
