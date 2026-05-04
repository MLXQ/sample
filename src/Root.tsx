import { Composition } from "remotion";
import { HistoryVideo, totalDurationInFrames } from "./Video";
import { Script } from "./types";
import sampleHistory from "../data/sample-script.json";
import sampleExplainer from "../data/sample-explainer.json";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="HistoryVideo"
        component={HistoryVideo}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ script: sampleHistory as Script }}
        calculateMetadata={({ props }) => ({
          durationInFrames: totalDurationInFrames(props.script, FPS),
        })}
      />
      <Composition
        id="ExplainerVideo"
        component={HistoryVideo}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ script: sampleExplainer as Script }}
        calculateMetadata={({ props }) => ({
          durationInFrames: totalDurationInFrames(props.script, FPS),
        })}
      />
    </>
  );
};
