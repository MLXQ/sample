export type Palette = {
  bg: string;
  bgGradientFrom: string;
  bgGradientTo: string;
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  serif: string;
  sans: string;
};

export const themes: Record<string, Palette> = {
  history: {
    bg: "#1a1410",
    bgGradientFrom: "#241a14",
    bgGradientTo: "#0d0907",
    surface: "rgba(60, 42, 28, 0.45)",
    text: "#f4ead5",
    textMuted: "rgba(244, 234, 213, 0.7)",
    accent: "#d4a24c",
    accentSoft: "rgba(212, 162, 76, 0.25)",
    serif: '"Playfair Display", Georgia, serif',
    sans: '"Inter", system-ui, sans-serif',
  },
  science: {
    bg: "#06121f",
    bgGradientFrom: "#0a1f33",
    bgGradientTo: "#02080f",
    surface: "rgba(20, 50, 80, 0.45)",
    text: "#e8f1ff",
    textMuted: "rgba(232, 241, 255, 0.7)",
    accent: "#4cc2ff",
    accentSoft: "rgba(76, 194, 255, 0.25)",
    serif: '"Playfair Display", Georgia, serif',
    sans: '"Inter", system-ui, sans-serif',
  },
  modern: {
    bg: "#0a0a0a",
    bgGradientFrom: "#1a1a1a",
    bgGradientTo: "#000000",
    surface: "rgba(255, 255, 255, 0.06)",
    text: "#ffffff",
    textMuted: "rgba(255, 255, 255, 0.7)",
    accent: "#ff5e3a",
    accentSoft: "rgba(255, 94, 58, 0.25)",
    serif: '"Playfair Display", Georgia, serif',
    sans: '"Inter", system-ui, sans-serif',
  },
};

export const getPalette = (key?: string): Palette =>
  themes[key ?? "history"] ?? themes.history;
