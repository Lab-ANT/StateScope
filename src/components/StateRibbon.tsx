import type { Segment } from "../types";
import { stateColor } from "../theme";
import { t } from "../i18n";

// Horizontal state ribbon: each segment is coloured by its state id.
export function StateRibbon(props: { segments: Segment[]; T: number; height?: number }) {
  const { segments, T } = props;
  const h = props.height ?? 22;
  const W = 1000;
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
        >
          <title>{t("viz.stateTip", { state: s.state, start: s.start, end: s.end })}</title>
        </rect>
      ))}
    </svg>
  );
}

export function StateLegend(props: { states: number[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-muted">
      {props.states.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px]" style={{ background: stateColor(s) }} />
          state {s}
        </span>
      ))}
    </div>
  );
}
