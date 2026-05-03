export type SceneBase = {
  /** Narration text spoken during this scene. Drives audio + duration. */
  narration: string;
  /** Filename inside public/audio (without extension). Set by narration step. */
  audio?: string;
  /** Duration in seconds. Set by narration step from audio length. */
  durationSeconds?: number;
};

export type TitleScene = SceneBase & {
  type: "title";
  title: string;
  subtitle?: string;
  /** Optional background image filename in public/images. */
  backgroundImage?: string;
};

export type NarrationScene = SceneBase & {
  type: "narration";
  /** Image filename in public/images, or remote URL. */
  image: string;
  /** Lower-third caption (location, date, person, etc.). */
  caption?: string;
  /** Year/era label, e.g. "1453 AD". */
  date?: string;
};

export type TimelineEvent = {
  year: string;
  text: string;
};

export type TimelineScene = SceneBase & {
  type: "timeline";
  heading: string;
  events: TimelineEvent[];
};

export type FactScene = SceneBase & {
  type: "fact";
  fact: string;
  source?: string;
};

export type OutroScene = SceneBase & {
  type: "outro";
  cta: string;
};

export type Scene =
  | TitleScene
  | NarrationScene
  | TimelineScene
  | FactScene
  | OutroScene;

export type Script = {
  title: string;
  subtitle?: string;
  /** Theme palette key. */
  theme?: "history" | "science" | "modern";
  scenes: Scene[];
};
