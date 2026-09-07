import { useEffect, useRef, useState } from "react";
import type { Channel } from "../types";
import { useT, dyn } from "../i18n";

// Small multiples: one row per channel with its own y-axis, so noisy and useful channels are
// both legible instead of one dominating a shared scale. Selected channels are coloured and
// thicker, dropped ones grey.
//
// The width is measured with ResizeObserver and drawn in real pixels rather than scaled via
// viewBox, so row height and type size stay absolute and only the time axis stretches.
// Long channel names are truncated (hover for the full name) so they never overlap the plot.
const trunc = (s: string, k = 13) => (s.length > k ? s.slice(0, k - 1) + "…" : s);

export function SeriesChart(props: { channels: Channel[]; rowHeight?: number }) {
  useT(); // redraw channel names when the language changes
  const { channels } = props;
  const rowH = props.rowHeight ?? 34;
  const labelW = 78; // gutter for channel names
  const padX = 6;
  const padY = 4;

  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = channels.length * rowH;
  const plotW = Math.max(1, W - labelW - padX);
  const palette = ["#3b6fe0", "#2ca35a", "#e08a1e", "#9a52d6", "#2f9ec4"];
  const n = channels[0]?.values.length ?? 1;

  // Normalise each channel on its own min/max, within its own row
  const path = (vals: number[], top: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    const innerH = rowH - 2 * padY;
    return vals
      .map((v, i) => {
        const x = labelW + (i / (n - 1)) * plotW;
        const y = top + padY + (1 - (v - lo) / span) * innerH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  let selIdx = -1;
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={W} height={H} style={{ display: "block" }}>
        {channels.map((c, i) => {
          const top = i * rowH;
          const color = c.selected ? palette[++selIdx % palette.length] : "#aab0ba";
          return (
            <g key={c.name}>
              {/* Row separator */}
              {i > 0 && <line x1={labelW} y1={top} x2={W} y2={top} stroke="#ededef" strokeWidth={1} />}
              {/* Channel name */}
              <text x={0} y={top + rowH / 2} dominantBaseline="middle" fontSize={11}
                fill={c.selected ? color : "#9aa0aa"} fontWeight={c.selected ? 600 : 400}>
                {trunc(dyn(c.name))}
                <title>{dyn(c.name)}</title>
              </text>
              {/* Waveform */}
              <path d={path(c.values, top)} fill="none" stroke={color}
                strokeWidth={c.selected ? 1.4 : 0.8} opacity={c.selected ? 1 : 0.75} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
