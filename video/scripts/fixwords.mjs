// Caption cleanup after timing.mjs: undo phonetic spellings and join spelled-out letters (U S D C -> USDC).
import { readFileSync, writeFileSync } from "node:fs";
const p = new URL("../src/timing.json", import.meta.url);
const t = JSON.parse(readFileSync(p, "utf8"));
const MAP = { "Vektor-tor": "Vektor", "TWAP-wap": "TWAP", "Aegis-jis": "Aegis", nineteen: "19:59", "fifty-nine": "", "sixty-five": "65", Sixteen: "16", Five: "5", "Ninety-five": "95", try: "tryvektor.vercel.app", dot: "", vercel: "", app: "" };
for (const s of t.scenes) for (const l of s.lines) {
  const out = [];
  for (const w of l.words) {
    const core = w.word.replace(/[.,]$/, ""), tail = w.word.slice(core.length);
    if (s.id === "close" && core === "Vektor-tor" && out.at(-1)?.word === "tryvektor.vercel.app") continue;
    if (core in MAP) { if (MAP[core]) out.push({ ...w, word: MAP[core] + (["try"].includes(core) ? "" : tail) }); else if (out.length) out.at(-1).end = w.end; continue; }
    const prev = out.at(-1);
    if (/^[A-Z]$/.test(core) && prev && /^[A-Z]+$/.test(prev.word)) { prev.word += core; prev.word += tail; prev.end = w.end; continue; }
    out.push(w);
  }
  l.words = out;
}
writeFileSync(p, JSON.stringify(t));
console.log(t.scenes.map((s) => s.lines.flatMap((l) => l.words.map((w) => w.word)).join(" ")).filter((x) => /USDC|UTC|Vektor|tryvektor/.test(x)).join("\n"));
