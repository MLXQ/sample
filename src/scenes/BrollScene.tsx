import {
  AbsoluteFill,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Video,
} from "remotion";
import { BrollScene as BrollSceneData } from "../types";
import { Palette } from "../styles/theme";
import { HeroSubtitle } from "../components/HeroSubtitle";

type Props = { scene: BrollSceneData; palette: Palette };

const isRemote = (s: string) => /^https?:\/\//.test(s);

export const BrollSceneView: React.FC<Props> = ({ scene, palette }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  // Distribute scene duration evenly across clips. Each clip plays
  // muted (narration audio is on top), with a 6-frame crossfade at
  // both ends so the cycling feels smooth.
  const n = Math.max(1, scene.clips.length);
  const clipFrames = Math.ceil(durationInFrames / n);
  const fadeFrames = Math.min(8, Math.floor(clipFrames / 6));

  const chipOpacity = interpolate(frame, [4, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const chipExit = interpolate(
    frame,
    [durationInFrames - 18, durationInFrames - 4],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      {scene.clips.map((clip, i) => {
        const start = i * clipFrames;
        const dur = i === n - 1 ? durationInFrames - start : clipFrames;
        return (
          <Sequence key={i} from={start} durationInFrames={dur}>
            <ClipFader
              src={clip.src}
              trimStart={clip.trimStart}
              trimEnd={clip.trimEnd}
              fadeFrames={fadeFrames}
              isFirst={i === 0}
              isLast={i === n - 1}
            />
          </Sequence>
        );
      })}

      {/* Darken overlay so the subtitle stays readable across any clip */}
      <AbsoluteFill
        style={{ background: "rgba(0,0,0,0.45)", pointerEvents: "none" }}
      />

      {scene.chip ? (
        <div
          style={{
            position: "absolute",
            top: 80,
            left: 80,
            opacity: Math.min(chipOpacity, chipExit),
            padding: "14px 28px",
            background: palette.accent,
            color: "#0a0a0a",
            fontFamily: palette.sans,
            fontWeight: 800,
            fontSize: 28,
            letterSpacing: 4,
            textTransform: "uppercase",
            borderRadius: 6,
            boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
          }}
        >
          {scene.chip}
        </div>
      ) : null}

      <HeroSubtitle
        text={scene.subtitle ?? scene.narration}
        palette={palette}
        position="bottom"
      />
    </AbsoluteFill>
  );
};

const ClipFader: React.FC<{
  src: string;
  trimStart?: number;
  trimEnd?: number;
  fadeFrames: number;
  isFirst: boolean;
  isLast: boolean;
}> = ({ src, trimStart, trimEnd, fadeFrames, isFirst, isLast }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const fadeIn = isFirst
    ? 1
    : interpolate(frame, [0, fadeFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const fadeOut = isLast
    ? 1
    : interpolate(
        frame,
        [durationInFrames - fadeFrames, durationInFrames],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
  const opacity = Math.min(fadeIn, fadeOut);

  // Subtle scale drift so each clip feels alive even when static.
  const scale = interpolate(frame, [0, durationInFrames], [1.03, 1.08]);
  const url = isRemote(src) ? src : staticFile(`videos/${src}`);

  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity }}>
      <Video
        src={url}
        muted
        startFrom={trimStart ? Math.round(trimStart * fps) : 0}
        endAt={trimEnd ? Math.round(trimEnd * fps) : undefined}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
};
