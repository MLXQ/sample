import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const PUBLIC_DIR = path.join(ROOT, "public");
export const AUDIO_DIR = path.join(PUBLIC_DIR, "audio");
export const IMAGES_DIR = path.join(PUBLIC_DIR, "images");
export const DATA_DIR = path.join(ROOT, "data");
export const OUT_DIR = path.join(ROOT, "out");

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export function slugify(input: string, max = 60): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}
