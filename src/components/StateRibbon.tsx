import type { Segment } from "../types";
import { stateColor } from "../theme";
import { t } from "../i18n";

// Horizontal state ribbon: each segment is coloured by its state id; `values` overlays the raw series.
export function StateRibbon(props: { segments: Segment[]; T: number; height?: number; values?: number[] }) {
  const { segments, T, values } = props;
  const h = props.height ?? 22;
  const W = 1000;
  let line = "";
  if (values && values.length > 1) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1, pad = 3, n = values.length;
    line = values.map((v, i) => `${i ? "L" : "M"}${((i / n) * W).toFixed(1)},${(pad + (1 - (v - lo) / span) * (h - 2 * pad)).toFixed(1)}`).join("");
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${h}`}
      width="100%"
      height={h}
      preserveAspectRatio="none"
      className="block rounded-[3px] ring-1 ring-black/5"
    >
      {segments.map((s, i) => (
        <rect
          key={i}
          x={(s.start / T) * W}
          y={0}
          width={Math.max(0.5, ((s.end - s.start) / T) * W)}
          height={h}
          fill={stateColor(s.state)}
          fillOpacity={line ? 0.45 : 1}
        >
          <title>{t("viz.stateTip", { state: s.state, start: s.start, end: s.end })}</title>
        </rect>
      ))}
      {line && <path d={line} fill="none" stroke="#1f2937" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
    </svg>
  );
}
