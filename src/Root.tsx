import { Composition } from "remotion";
import { HistoryVideo, totalDurationInFrames } from "./Video";
import { Script } from "./types";
import sampleScript from "../data/sample-script.json";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="HistoryVideo"
      component={HistoryVideo}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ script: sampleScript as Script }}
      calculateMetadata={({ props }) => ({
        durationInFrames: totalDurationInFrames(props.script, FPS),
      })}
    />
  );
};
