import { AbsoluteFill } from "remotion";
import { NarrationScene as NarrationSceneData } from "../types";
import { Palette } from "../styles/theme";
import { KenBurnsImage } from "../components/KenBurnsImage";
import { AnimatedCaption } from "../components/AnimatedCaption";
import { SubtitleStrip } from "../components/SubtitleStrip";

type Props = {
  scene: NarrationSceneData;
  palette: Palette;
  index: number;
};

const PANS = ["right", "left", "up", "down"] as const;

export const NarrationSceneView: React.FC<Props> = ({
  scene,
  palette,
  index,
}) => {
  const pan = PANS[index % PANS.length];
  const direction = index % 2 === 0 ? "in" : "out";

  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      <KenBurnsImage
        src={scene.image}
        direction={direction}
        pan={pan}
        vignette={0.55}
      />
      <AnimatedCaption
        caption={scene.caption}
        date={scene.date}
        palette={palette}
      />
      <SubtitleStrip text={scene.narration} palette={palette} />
    </AbsoluteFill>
  );
};
