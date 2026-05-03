import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { TimelineScene as TimelineSceneData } from "../types";
import { Palette } from "../styles/theme";
import { GradientBackground } from "../components/GradientBackground";
import { SubtitleStrip } from "../components/SubtitleStrip";

type Props = { scene: TimelineSceneData; palette: Palette };

export const TimelineSceneView: React.FC<Props> = ({ scene, palette }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const headingOpacity = interpolate(frame, [6, 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const eventCount = scene.events.length;
  const stagger = Math.max(8, Math.floor((durationInFrames - 60) / Math.max(1, eventCount)));
  const lineProgress = spring({
    frame: frame - 24,
    fps,
    config: { damping: 22, stiffness: 70 },
  });

  return (
    <AbsoluteFill>
      <GradientBackground palette={palette} />
      <AbsoluteFill
        style={{
          padding: "120px 160px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            opacity: headingOpacity,
            fontFamily: palette.serif,
            fontSize: 78,
            fontWeight: 700,
            color: palette.text,
            letterSpacing: -1,
            marginBottom: 60,
          }}
        >
          {scene.heading}
        </div>

        <div style={{ position: "relative", flex: 1 }}>
          <div
            style={{
              position: "absolute",
              left: 18,
              top: 0,
              bottom: 0,
              width: 3,
              background: palette.accent,
              transformOrigin: "top",
              transform: `scaleY(${Math.max(0, Math.min(1, lineProgress))})`,
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 36,
              paddingLeft: 70,
            }}
          >
            {scene.events.map((event, i) => {
              const start = 30 + i * stagger;
              const opacity = interpolate(frame, [start, start + 18], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              const tx = interpolate(frame, [start, start + 22], [40, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              return (
                <div
                  key={i}
                  style={{
                    position: "relative",
                    opacity,
                    transform: `translateX(${tx}px)`,
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: -64,
                      top: 14,
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: palette.accent,
                      boxShadow: `0 0 0 8px ${palette.accentSoft}`,
                    }}
                  />
                  <div
                    style={{
                      fontFamily: palette.sans,
                      fontSize: 30,
                      fontWeight: 700,
                      color: palette.accent,
                      letterSpacing: 4,
                    }}
                  >
                    {event.year}
                  </div>
                  <div
                    style={{
                      fontFamily: palette.serif,
                      fontSize: 44,
                      fontWeight: 500,
                      color: palette.text,
                      lineHeight: 1.25,
                      marginTop: 8,
                      maxWidth: 1400,
                    }}
                  >
                    {event.text}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>
      <SubtitleStrip text={scene.narration} palette={palette} />
    </AbsoluteFill>
  );
};
