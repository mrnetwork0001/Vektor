import { useMemo } from "react";
import type { GridState } from "../../quant/gridEngine";
import type { GridPlan } from "../../quant/gridEngine";
import type { DepthAnalysis } from "../../quant/whaleRadar";
import { formatPrice } from "../../math/formatUtils";

interface Props {
  history: number[];
  mark: number;
  plan: GridPlan | null; // preview (before deploy)
  grid: GridState | null; // live state (after deploy)
  liquidationPrice?: number;
  walls?: DepthAnalysis["walls"];
  height?: number;
}

/**
 * Price path with the grid rungs overlaid: resting buys green, resting sells
 * red, empty/filled levels dim, liquidation price orange, whale walls as
 * translucent bands on the right edge.
 */
export function GridLadder({ history, mark, plan, grid, liquidationPrice, walls = [], height = 320 }: Props) {
  const W = 800, H = height, PAD_R = 70, PAD = 8;
  const rungs = grid?.rungs ?? plan?.rungs ?? [];
  const cfg = grid?.plan.config ?? plan?.config;

  const { lo, hi } = useMemo(() => {
    const vals = [...history, mark, ...rungs.map((r) => r.price), ...(liquidationPrice ? [liquidationPrice] : []), ...walls.map((w) => w.price)].filter((v) => v > 0);
    if (!vals.length) return { lo: 0, hi: 1 };
    const min = Math.min(...vals), max = Math.max(...vals);
    const padV = (max - min || max * 0.01) * 0.08;
    return { lo: min - padV, hi: max + padV };
  }, [history, mark, rungs, liquidationPrice, walls]);

  const y = (p: number) => PAD + (H - 2 * PAD) * (1 - (p - lo) / (hi - lo));
  const x = (i: number) => (history.length > 1 ? (i / (history.length - 1)) * (W - PAD_R) : 0);
  const path = history.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ladder" preserveAspectRatio="none">
      {cfg && (
        <rect x={0} y={y(cfg.upperPrice)} width={W - PAD_R} height={Math.max(0, y(cfg.lowerPrice) - y(cfg.upperPrice))} fill="rgba(37,250,176,0.04)" stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
      )}
      {walls.map((w, i) => (
        <rect key={i} x={W - PAD_R - 10 - Math.min(40, w.multipleOfAvg * 6)} y={y(w.price) - 2} width={10 + Math.min(40, w.multipleOfAvg * 6)} height={4}
          fill={w.side === "BID" ? "rgba(37,250,176,0.45)" : "rgba(244,63,94,0.45)"}>
          <title>{w.side} wall ${w.notionalUsd.toLocaleString()} ({w.multipleOfAvg}× avg) @ {formatPrice(w.price)}</title>
        </rect>
      ))}
      {rungs.map((r) => {
        const resting = r.resting[0];
        const color = resting ? (resting.side === "BUY" ? "#25fab0" : "#f43f5e") : r.entrySide === "NONE" ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.28)";
        const dash = resting ? undefined : "2 4";
        return (
          <g key={r.index}>
            <line x1={0} x2={W - PAD_R} y1={y(r.price)} y2={y(r.price)} stroke={color} strokeWidth={resting ? 1.2 : 1} strokeDasharray={dash} />
            <text x={W - PAD_R + 4} y={y(r.price) + 3} fontSize={9} fill={color} fontFamily="monospace">
              {formatPrice(r.price)}{resting ? (resting.role === "x" ? " x" : "") : r.cycles ? ` ·${r.cycles}` : ""}
            </text>
          </g>
        );
      })}
      {liquidationPrice ? (
        <g>
          <line x1={0} x2={W - PAD_R} y1={y(liquidationPrice)} y2={y(liquidationPrice)} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6 3" />
          <text x={W - PAD_R + 4} y={y(liquidationPrice) + 3} fontSize={9} fill="#f59e0b" fontFamily="monospace">LIQ {formatPrice(liquidationPrice)}</text>
        </g>
      ) : null}
      {history.length > 1 && <path d={path} fill="none" stroke="#ffffff" strokeWidth={1.4} opacity={0.9} />}
      {mark > 0 && (
        <g>
          <circle cx={x(Math.max(0, history.length - 1))} cy={y(mark)} r={3} fill="#fff" />
          <rect x={W - PAD_R - 2} y={y(mark) - 7} width={PAD_R} height={14} fill="#fff" rx={2} />
          <text x={W - PAD_R + 2} y={y(mark) + 3.5} fontSize={9.5} fill="#000" fontFamily="monospace" fontWeight={700}>{formatPrice(mark)}</text>
        </g>
      )}
    </svg>
  );
}
