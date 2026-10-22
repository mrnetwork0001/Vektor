import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAt } from "./timing";
import { C } from "./theme";
import { Captions } from "./ui/Captions";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { SCENES } from "./scenes/All";

const OVERLAP = 12; // frames each scene starts early, to dissolve over the last

/** Each scene eases in (a short rise, un-blur and settle) over the tail of the previous one, holding its first frame. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.04 - 0.04 * p})`, filter: p < 1 ? `blur(${(1 - p) * 12}px)` : undefined }}>{body}</AbsoluteFill>;
};

// --- Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 20], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 50, end], [1, 0], clamp);
  return (0.6 - 0.4 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, n = 0) => wordAt(id, word, n);
  const fx: Fx[] = [
    ...["Sideways", "Funding", "Liquidations", "tab"].map((x) => ({ file: "pop", at: w("problem", x) - 6, vol: 0.35 })),
    { file: "tabclose", at: w("problem", "closes.") - 2, vol: 0.4 },
    { file: "whoosh", at: sc("strike") - 8, vol: 0.3 },
    ...["central", "Funding", "Builder", "Trading", "Cardano", "Ethereum", "Solana"].map((x) => ({ file: "tick", at: w("strike", x) - 4, vol: 0.35 })),
    { file: "swoosh_up", at: sc("gap") - 8, vol: 0.3 },
    { file: "denied", at: w("gap", "grid") + 6, vol: 0.4 }, { file: "denied", at: w("gap", "TWAP") + 6, vol: 0.4 },
    { file: "riser", at: sc("turn") - 70, vol: 0.4 },
    { file: "impact", at: w("turn", "Vektor") - 4, vol: 0.55 },
    { file: "whoosh", at: sc("grid") - 8, vol: 0.3 },
    { file: "click", at: w("grid", "batch,") - 4, vol: 0.4 }, { file: "fill", at: w("grid", "fills,") - 2, vol: 0.4 },
    { file: "whoosh", at: sc("backtest") - 8, vol: 0.3 },
    { file: "whoosh", at: sc("harvester") - 8, vol: 0.3 }, { file: "coin", at: w("harvester", "mainnet") + 4, vol: 0.35 },
    { file: "glitch", at: sc("shield") + 4, vol: 0.25 }, { file: "lock", at: w("shield", "cancels") - 2, vol: 0.4 }, { file: "lock", at: w("shield", "trims") - 2, vol: 0.4 },
    { file: "click", at: w("autopilot", "box,") - 2, vol: 0.5 }, { file: "lock", at: w("autopilot", "encrypted") - 2, vol: 0.35 },
    { file: "tabclose", at: w("autopilot", "tab.") - 4, vol: 0.5 }, { file: "fill", at: w("autopilot", "bought") - 2, vol: 0.5 },
    { file: "swoosh_up", at: sc("proof") - 8, vol: 0.3 },
    ...["16", "5", "95"].map((x) => ({ file: "pop", at: w("proof", x) - 6, vol: 0.4 })),
    { file: "coin", at: w("proof", "fill,") - 4, vol: 0.45 },
    { file: "whoosh", at: sc("under") - 8, vol: 0.3 },
    { file: "whoosh", at: sc("next") - 8, vol: 0.3 },
    { file: "whoosh", at: sc("close") - 8, vol: 0.3 }, { file: "chime", at: w("close", "Vektor") - 2, vol: 0.45 },
  ];
  return fx.filter((x) => x.at >= 0 && x.at < T.totalFrames);
}

export const Film: React.FC = () => {
  // Captions sit out where big type already carries the words.
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || ["turn", "close", "next"].includes(s.id);
  };
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {T.scenes.map((s, i) => {
        const S = SCENES[s.id];
        const from = i === 0 ? s.from : s.from - OVERLAP;
        const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
        return S ? (
          <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
            <SceneIn S={S} first={i === 0} />
          </Sequence>
        ) : null;
      })}
      <Grain opacity={0.06} />
      <Captions hidden={hideCaptions} />
      <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} />
      {T.scenes.flatMap((s) => s.lines).map((l, i) => (
        <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
          <Audio src={staticFile(l.file)} volume={1} />
        </Sequence>
      ))}
      {effects().map((x, i) => (
        <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 150} name={`fx ${x.file}`}>
          <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 8, x.dur - 20, x.dur], [0, 1, 1, 0], clamp) : 1)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
