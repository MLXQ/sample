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

export const sceneSchema = z.discriminatedUnion("type", [
  titleSceneSchema,
  narrationSceneSchema,
  timelineSceneSchema,
  factSceneSchema,
  outroSceneSchema,
]);

export const generatedScriptSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  theme: z.enum(["history", "science", "modern"]).optional(),
  scenes: z.array(sceneSchema).min(3).max(20),
});

export type GeneratedScene = z.infer<typeof sceneSchema>;
export type GeneratedScript = z.infer<typeof generatedScriptSchema>;
