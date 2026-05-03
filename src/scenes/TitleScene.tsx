import { AbsoluteFill } from "remotion";
import { TitleScene as TitleSceneData } from "../types";
import { Palette } from "../styles/theme";
import { GradientBackground } from "../components/GradientBackground";
import { KenBurnsImage } from "../components/KenBurnsImage";
import { AnimatedTitle } from "../components/AnimatedTitle";

type Props = { scene: TitleSceneData; palette: Palette };

export const TitleSceneView: React.FC<Props> = ({ scene, palette }) => (
  <AbsoluteFill>
    <GradientBackground palette={palette} />
    {scene.backgroundImage ? (
      <AbsoluteFill style={{ opacity: 0.45 }}>
        <KenBurnsImage
          src={scene.backgroundImage}
          direction="in"
          pan="right"
          vignette={0.7}
        />
      </AbsoluteFill>
    ) : null}
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <AnimatedTitle
        text={scene.title}
        subtitle={scene.subtitle}
        palette={palette}
        delay={6}
      />
    </AbsoluteFill>
  </AbsoluteFill>
);
