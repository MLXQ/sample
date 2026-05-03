import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FactScene as FactSceneData } from "../types";
import { Palette } from "../styles/theme";
import { GradientBackground } from "../components/GradientBackground";
import { SubtitleStrip } from "../components/SubtitleStrip";

type Props = { scene: FactSceneData; palette: Palette };

export const FactCardSceneView: React.FC<Props> = ({ scene, palette }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardScale = spring({
    frame: frame - 4,
    fps,
    config: { damping: 14, stiffness: 90, mass: 0.9 },
  });
  const factOpacity = interpolate(frame, [22, 38], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sourceOpacity = interpolate(frame, [40, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <GradientBackground palette={palette} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            transform: `scale(${0.85 + Math.min(1, cardScale) * 0.15})`,
            background: palette.surface,
            border: `1px solid ${palette.accent}`,
            borderRadius: 24,
            padding: "70px 90px",
            maxWidth: 1500,
            backdropFilter: "blur(20px)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              fontFamily: palette.sans,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 8,
              textTransform: "uppercase",
              color: palette.accent,
              marginBottom: 24,
            }}
          >
            Did you know?
          </div>
          <div
            style={{
              fontFamily: palette.serif,
              fontSize: 72,
              fontWeight: 600,
              color: palette.text,
              lineHeight: 1.2,
              opacity: factOpacity,
            }}
          >
            {scene.fact}
          </div>
          {scene.source ? (
            <div
              style={{
                marginTop: 36,
                fontFamily: palette.sans,
                fontSize: 24,
                fontStyle: "italic",
                color: palette.textMuted,
                opacity: sourceOpacity,
              }}
            >
              Source: {scene.source}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
      <SubtitleStrip text={scene.narration} palette={palette} />
    </AbsoluteFill>
  );
};
