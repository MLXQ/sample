import { Audio, staticFile } from "remotion";
import { Scene } from "../types";
import { Palette } from "../styles/theme";
import { TitleSceneView } from "./TitleScene";
import { NarrationSceneView } from "./NarrationScene";
import { TimelineSceneView } from "./TimelineScene";
import { FactCardSceneView } from "./FactCardScene";
import { OutroSceneView } from "./OutroScene";

type Props = { scene: Scene; palette: Palette; index: number };

export const SceneRenderer: React.FC<Props> = ({ scene, palette, index }) => {
  const view = (() => {
    switch (scene.type) {
      case "title":
        return <TitleSceneView scene={scene} palette={palette} />;
      case "narration":
        return (
          <NarrationSceneView scene={scene} palette={palette} index={index} />
        );
      case "timeline":
        return <TimelineSceneView scene={scene} palette={palette} />;
      case "fact":
        return <FactCardSceneView scene={scene} palette={palette} />;
      case "outro":
        return <OutroSceneView scene={scene} palette={palette} />;
    }
  })();

  return (
    <>
      {view}
      {scene.audio ? <Audio src={staticFile(`audio/${scene.audio}`)} /> : null}
    </>
  );
};
