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

export type BrollClip = {
  /** Filename in public/videos, or absolute http(s) URL. */
  src: string;
  /** Optional in/out trim within the clip, in seconds. */
  trimStart?: number;
  trimEnd?: number;
};

export type BrollScene = SceneBase & {
  type: "broll";
  /** 2+ stock clips that cycle within this scene. */
  clips: BrollClip[];
  /**
   * Hero subtitle text. Defaults to `narration` if omitted. Keywords
   * wrapped in **double asterisks** are highlighted in the accent color.
   */
  subtitle?: string;
  /** Optional small upper-left chip label, e.g. "Step 1", "1903". */
  chip?: string;
};

/**
 * A single big number that animates up from 0 to `value` over the first
 * ~1.5 seconds of the scene. Used for stats like "$200B", "1000 TWh".
 */
export type CountUpScene = SceneBase & {
  type: "countUpStat";
  value: number;
  /** Optional prefix glyph (e.g. "$"). */
  prefix?: string;
  /** Optional suffix (e.g. "B", "%", " TWh"). */
  suffix?: string;
  /** Smaller line above the big number. */
  label?: string;
  /** Smaller italic line below the big number. */
  caption?: string;
};

/**
 * Vertical stack of N labeled layers, each revealing top-to-bottom.
 * Used to visualize a value chain or hierarchy.
 */
export type StackLayer = { label: string; note?: string };
export type StackScene = SceneBase & {
  type: "stackDiagram";
  heading: string;
  layers: StackLayer[];
};

/**
 * Bar chart with N bars. Bars grow from 0 to their target height,
 * staggered by ~150ms.
 */
export type ChartBar = { label: string; value: number };
export type ChartScene = SceneBase & {
  type: "animatedChart";
  heading: string;
  /** Bars in order. */
  bars: ChartBar[];
  /** Optional unit displayed on the y-axis (e.g. "TWh"). */
  unit?: string;
};

/**
 * Grid of company / brand labels (no actual logo art needed). Each
 * tile fades in with stagger.
 */
export type LogoGridScene = SceneBase & {
  type: "logoGrid";
  heading: string;
  /** 4-9 short labels. */
  logos: string[];
};

/**
 * Geographic concentration view. 3-6 country pins on a stylized world
 * grid; pins appear with stagger and (optional) connection lines pulse
 * between them. Great for "AI is concentrated in 4 countries" stories.
 */
export type WorldPin = {
  country: string;
  /** 0..1 horizontal position on the canvas. */
  x: number;
  /** 0..1 vertical position on the canvas. */
  y: number;
  /** Featured companies / role at this pin. */
  label?: string;
  /** Highlight ring + larger dot. */
  highlight?: boolean;
};
export type WorldMapScene = SceneBase & {
  type: "worldMap";
  heading: string;
  pins: WorldPin[];
  /** Connect pins in order with animated lines. */
  connect?: boolean;
};

/**
 * Side-by-side donut charts showing market concentration / monopoly.
 * Each donut has a leader's percentage and a small caption.
 */
export type MarketShareMetric = {
  /** Industry / segment name (e.g. "EUV Lithography"). */
  label: string;
  /** Dominant company name (e.g. "ASML"). */
  leader: string;
  /** 0..100 share percentage held by leader. */
  sharePercent: number;
};
export type MarketShareScene = SceneBase & {
  type: "marketShare";
  heading: string;
  /** 2-4 metrics shown side by side. */
  metrics: MarketShareMetric[];
};

/**
 * Horizontal supply-chain / process flow. Boxes appear left-to-right
 * with animated arrows drawing between them.
 */
export type FlowStep = {
  label: string;
  note?: string;
};
export type FlowDiagramScene = SceneBase & {
  type: "flowDiagram";
  heading: string;
  /** 3-7 sequential steps. */
  steps: FlowStep[];
};

export type Scene =
  | TitleScene
  | NarrationScene
  | TimelineScene
  | FactScene
  | OutroScene
  | BrollScene
  | CountUpScene
  | StackScene
  | ChartScene
  | LogoGridScene
  | WorldMapScene
  | MarketShareScene
  | FlowDiagramScene;

export type Script = {
  title: string;
  subtitle?: string;
  /** Theme palette key. */
  theme?: "history" | "science" | "modern" | "explainer";
  scenes: Scene[];
};
