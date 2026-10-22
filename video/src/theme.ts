import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";

/** Vektor's families (index.html): Inter for display and text, JetBrains Mono for figures. */
export const sans = loadInter("normal", { weights: ["300", "400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const display = sans;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;
export const serif = loadSerif("italic", { weights: ["400"], subsets: ["latin"] }).fontFamily;

/** Vektor's palette, from index.html :root. */
export const C = {
  bg: "#0a0a0a",
  raised: "#111214",
  panel: "#16171a",
  ink: "#ffffff",
  muted: "#c9cbd0",
  faint: "#7d8088",
  mint: "#25FAB0",
  teal: "#25FAB0",
  red: "#F43F5E",
  amber: "#F59E0B",
  paper: "#f3f5f4",
  paperInk: "#0a0a0a",
  paperMuted: "#5a5f66",
  line: "rgba(255,255,255,0.12)",
};

export type Tone = "dark" | "light";
export const TONE: Record<Tone, { bg: string; ink: string; muted: string; line: string; pill: string }> = {
  dark: { bg: C.bg, ink: "#ffffff", muted: "rgba(255,255,255,0.55)", line: "rgba(255,255,255,0.14)", pill: "rgba(10,10,10,0.7)" },
  light: { bg: C.paper, ink: C.paperInk, muted: "rgba(10,10,10,0.5)", line: "rgba(10,10,10,0.12)", pill: "rgba(255,255,255,0.85)" },
};
export const SCENE_TONE: Record<string, Tone> = { gap: "light" };
