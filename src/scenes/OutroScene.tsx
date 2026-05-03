import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { OutroScene as OutroSceneData } from "../types";
import { Palette } from "../styles/theme";
import { GradientBackground } from "../components/GradientBackground";

type Props = { scene: OutroSceneData; palette: Palette };

export const OutroSceneView: React.FC<Props> = ({ scene, palette }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ctaSpring = spring({
    frame: frame - 8,
    fps,
    config: { damping: 16, stiffness: 110 },
  });
  const buttonGlow = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(frame / 12));

  return (
    <AbsoluteFill>
      <GradientBackground palette={palette} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            transform: `scale(${0.7 + Math.min(1, ctaSpring) * 0.3})`,
            opacity: interpolate(frame, [8, 28], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 50,
          }}
        >
          <div
            style={{
              fontFamily: palette.serif,
              fontSize: 96,
              fontWeight: 700,
              color: palette.text,
              textAlign: "center",
              maxWidth: 1500,
              lineHeight: 1.1,
            }}
          >
            {scene.cta}
          </div>
          <div
            style={{
              fontFamily: palette.sans,
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "#0b0b0b",
              padding: "24px 60px",
              background: palette.accent,
              borderRadius: 999,
              boxShadow: `0 0 ${40 + buttonGlow * 60}px ${palette.accent}`,
            }}
          >
            Subscribe
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
