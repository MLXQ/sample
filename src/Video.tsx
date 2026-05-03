import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { Script } from "./types";
import { getPalette } from "./styles/theme";
import { SceneRenderer } from "./scenes/SceneRenderer";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadPlayfair } from "@remotion/google-fonts/PlayfairDisplay";

loadInter();
loadPlayfair();

type Props = { script: Script };

export const HistoryVideo: React.FC<Props> = ({ script }) => {
  const { fps } = useVideoConfig();
  const palette = getPalette(script.theme);

  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      {script.scenes.map((scene, i) => {
        const seconds = scene.durationSeconds ?? 5;
        const duration = Math.max(1, Math.round(seconds * fps));
        const seq = (
          <Sequence key={i} from={cursor} durationInFrames={duration}>
            <SceneRenderer scene={scene} palette={palette} index={i} />
          </Sequence>
        );
        cursor += duration;
        return seq;
      })}
    </AbsoluteFill>
  );
};

/** Total video duration in frames, given a script and fps. */
export const totalDurationInFrames = (script: Script, fps: number): number => {
  const total = script.scenes.reduce(
    (sum, s) => sum + Math.max(1, Math.round((s.durationSeconds ?? 5) * fps)),
    0,
  );
  return Math.max(1, total);
};
