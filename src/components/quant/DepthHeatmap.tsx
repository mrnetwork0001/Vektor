import { useEffect, useRef } from "react";
import type { DepthFrame } from "../../hooks/useVektor";
import { formatPrice } from "../../math/formatUtils";

/**
 * Bookmap-style liquidity heatmap: x = time, y = price, brightness = resting
 * notional at that level. Bids green, asks red, mark in white.
 */
export function DepthHeatmap({ frames, height = 200 }: { frames: DepthFrame[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, W, H);
    if (frames.length < 2) return;

    let lo = Infinity, hi = -Infinity, maxN = 0;
    for (const f of frames) {
      for (const [p, q] of [...f.bids, ...f.asks]) { lo = Math.min(lo, p); hi = Math.max(hi, p); maxN = Math.max(maxN, p * q); }
    }
    if (!(hi > lo) || !(maxN > 0)) return;
    const pad = (hi - lo) * 0.03;
    lo -= pad; hi += pad;
    const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
    const colW = W / frames.length;
    const levelH = Math.max(1.5, (H / ((hi - lo) / ((hi - lo) / 60))) );

    frames.forEach((f, i) => {
      const x = i * colW;
      for (const [side, levels] of [["bid", f.bids], ["ask", f.asks]] as const) {
        for (const [p, q] of levels) {
          const a = Math.min(1, Math.pow((p * q) / maxN, 0.5));
          ctx.fillStyle = side === "bid" ? `rgba(37,250,176,${0.08 + a * 0.9})` : `rgba(244,63,94,${0.08 + a * 0.9})`;
          ctx.fillRect(x, y(p) - levelH / 2, Math.ceil(colW), levelH);
        }
      }
    });
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    frames.forEach((f, i) => { const px = i * colW + colW / 2, py = y(f.mark); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); });
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "10px monospace";
    ctx.fillText(formatPrice(hi - pad), 4, 11);
    ctx.fillText(formatPrice(lo + pad), 4, H - 4);
  }, [frames]);

  return (
    <div className="heatmap-wrap">
      <canvas ref={ref} width={800} height={height} className="heatmap" />
      {frames.length < 2 && <div className="heatmap-empty text-secondary text-xs">Collecting order-book frames…</div>}
    </div>
  );
}
