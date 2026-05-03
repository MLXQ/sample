import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Palette } from "../styles/theme";

type Props = {
  palette: Palette;
  /** Subtle animated drift on the gradient. */
  drift?: boolean;
};

export const GradientBackground: React.FC<Props> = ({
  palette,
  drift = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const angle = drift ? 135 + Math.sin(t * 0.15) * 8 : 135;

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${angle}deg, ${palette.bgGradientFrom} 0%, ${palette.bgGradientTo} 100%)`,
      }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 30% 20%, ${palette.accentSoft} 0%, transparent 55%)`,
          opacity: 0.6,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};
