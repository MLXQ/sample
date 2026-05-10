import { z } from "zod";

const baseFields = {
  narration: z.string().min(1),
};

export const titleSceneSchema = z.object({
  ...baseFields,
  type: z.literal("title"),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  backgroundImageQuery: z.string().optional(),
});

export const narrationSceneSchema = z.object({
  ...baseFields,
  type: z.literal("narration"),
  imageQuery: z.string().min(1),
  caption: z.string().optional(),
  date: z.string().optional(),
});

export const timelineSceneSchema = z.object({
  ...baseFields,
  type: z.literal("timeline"),
  heading: z.string().min(1),
  events: z
    .array(z.object({ year: z.string(), text: z.string() }))
    .min(2)
    .max(8),
});

export const factSceneSchema = z.object({
  ...baseFields,
  type: z.literal("fact"),
  fact: z.string().min(1),
  source: z.string().optional(),
});

export const outroSceneSchema = z.object({
  ...baseFields,
  type: z.literal("outro"),
  cta: z.string().min(1),
});

export const brollSceneSchema = z.object({
  ...baseFields,
  type: z.literal("broll"),
  /** 2-5 specific search queries for stock-video B-roll clips. */
  brollQueries: z.array(z.string().min(2)).min(2).max(5),
  /** Hero subtitle. Wrap keywords in **bold** to highlight in accent color. */
  subtitle: z.string().optional(),
  /** Small chip label, e.g. "Step 1", "1903", "The Twist". */
  chip: z.string().optional(),
});

export const countUpSceneSchema = z.object({
  ...baseFields,
  type: z.literal("countUpStat"),
  value: z.number(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  label: z.string().optional(),
  caption: z.string().optional(),
});

export const stackSceneSchema = z.object({
  ...baseFields,
  type: z.literal("stackDiagram"),
  heading: z.string(),
  layers: z
    .array(z.object({ label: z.string(), note: z.string().optional() }))
    .min(3)
    .max(14),
});

export const chartSceneSchema = z.object({
  ...baseFields,
  type: z.literal("animatedChart"),
  heading: z.string(),
  bars: z.array(z.object({ label: z.string(), value: z.number() })).min(2).max(8),
  unit: z.string().optional(),
});

export const logoGridSceneSchema = z.object({
  ...baseFields,
  type: z.literal("logoGrid"),
  heading: z.string(),
  logos: z.array(z.string().min(1)).min(2).max(9),
});

export const worldMapSceneSchema = z.object({
  ...baseFields,
  type: z.literal("worldMap"),
  heading: z.string(),
  pins: z
    .array(
      z.object({
        country: z.string(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        label: z.string().optional(),
        highlight: z.boolean().optional(),
      }),
    )
    .min(2)
    .max(8),
  connect: z.boolean().optional(),
});

export const marketShareSceneSchema = z.object({
  ...baseFields,
  type: z.literal("marketShare"),
  heading: z.string(),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        leader: z.string(),
        sharePercent: z.number().min(0).max(100),
      }),
    )
    .min(1)
    .max(4),
});

export const flowDiagramSceneSchema = z.object({
  ...baseFields,
  type: z.literal("flowDiagram"),
  heading: z.string(),
  steps: z
    .array(z.object({ label: z.string(), note: z.string().optional() }))
    .min(2)
    .max(7),
});

export const sceneSchema = z.discriminatedUnion("type", [
  titleSceneSchema,
  narrationSceneSchema,
  timelineSceneSchema,
  factSceneSchema,
  outroSceneSchema,
  brollSceneSchema,
  countUpSceneSchema,
  stackSceneSchema,
  chartSceneSchema,
  logoGridSceneSchema,
  worldMapSceneSchema,
  marketShareSceneSchema,
  flowDiagramSceneSchema,
]);

export const generatedScriptSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  theme: z.enum(["history", "science", "modern", "explainer"]).optional(),
  scenes: z.array(sceneSchema).min(3).max(20),
});

export type GeneratedScene = z.infer<typeof sceneSchema>;
export type GeneratedScript = z.infer<typeof generatedScriptSchema>;
