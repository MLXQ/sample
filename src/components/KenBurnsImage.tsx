import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Props = {
  /** Either a public/images/<file> name, or absolute http(s) URL. */
  src: string;
  /** Slow zoom in (default) or out. */
  direction?: "in" | "out";
  /** Pan direction. */
  pan?: "left" | "right" | "up" | "down" | "none";
  /** Image opacity ceiling. */
  opacity?: number;
  /** Optional vignette overlay strength 0..1. */
  vignette?: number;
};

const isRemote = (s: string) => /^https?:\/\//.test(s);

export const KenBurnsImage: React.FC<Props> = ({
  src,
  direction = "in",
  pan = "right",
  opacity = 1,
  vignette = 0.5,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = frame / Math.max(1, durationInFrames - 1);

  const startScale = direction === "in" ? 1.0 : 1.18;
  const endScale = direction === "in" ? 1.18 : 1.0;
  const scale = interpolate(progress, [0, 1], [startScale, endScale]);

  const panAmount = 40;
  const tx =
    pan === "left"
      ? interpolate(progress, [0, 1], [panAmount, -panAmount])
      : pan === "right"
        ? interpolate(progress, [0, 1], [-panAmount, panAmount])
        : 0;
  const ty =
    pan === "up"
      ? interpolate(progress, [0, 1], [panAmount, -panAmount])
      : pan === "down"
        ? interpolate(progress, [0, 1], [-panAmount, panAmount])
        : 0;

  const fadeIn = interpolate(frame, [0, 18], [0, opacity], {
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 18, durationInFrames],
    [opacity, 0],
    { extrapolateLeft: "clamp" },
  );
  const finalOpacity = Math.min(fadeIn, fadeOut);

  const url = isRemote(src) ? src : staticFile(`images/${src}`);

  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity: finalOpacity }}>
      <Img
        src={url}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
          transformOrigin: "center center",
        }}
      />
      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,${vignette}) 100%)`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
