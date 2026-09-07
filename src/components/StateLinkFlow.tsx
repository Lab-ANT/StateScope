import { useEffect, useRef, useState } from "react";
import type { Aligned, Segment, StateLink } from "../types";
import { stateColor } from "../theme";
import { Card, Note, SegToggle } from "./ui";
import { ThresholdSlider } from "./ThresholdSlider";
import { t, useT, tr, dyn } from "../i18n";

// Service-state influence flow (state_link, Corr_Partial of StaCo eq. 4+5): one state
// ribbon per service, stacked on a shared time axis.
//   - lagged influence: a C-shaped arc with an arrow from source to target state (a larger
//     lag spans further horizontally); the end dots take the state colours;
//   - contemporaneous co-occurrence: each of the paired state segments gets a dashed box,
//     with one colour and dash style per pair.
// Layout is in real pixels (width measured with ResizeObserver); the service names are HTML
// so they wrap and stay crisp.

const LABEL_W = 88; // width of the service-name column, px
const ROW_H = 42; // row height, px
const BAR_H = 18;
const N_LEAD = 7;
const N_SYNC = 6;
const INK_LAG = "#3f4654";
const HALO = "#ffffff";
// Co-occurrence boxes: one colour and dash style per pair
const FRAME_COLORS = ["#d6453c", "#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
const FRAME_DASH = ["5 3", "2 2.5", "8 3 2 3", "6 4", "3 3 1 3", "10 4"];

type Filter = "all" | "lead-lag" | "synchronous";

// Anchor times of the best-overlapping segment pair, with the target shifted by lag.
function anchorTimes(
  src: Segment[],
  tgt: Segment[],
  sa: number,
  sb: number,
  lag: number,
): { sx: number; tx: number } | null {
  const seg = bestPair(src, tgt, sa, sb, lag);
  if (!seg) return null;
  if (seg.ov > 0) {
    const lo = Math.max(seg.ss.start + lag, seg.ts.start);
    const hi = Math.min(seg.ss.end + lag, seg.ts.end);
    const c = (lo + hi) / 2;
    return { sx: c - lag, tx: c };
  }
  return { sx: (seg.ss.start + seg.ss.end) / 2, tx: (seg.ts.start + seg.ts.end) / 2 };
}

// Find the same-state segment pair with the largest temporal overlap at the given lag.
function bestPair(src: Segment[], tgt: Segment[], sa: number, sb: number, lag: number) {
  let best: { ss: Segment; ts: Segment; ov: number } | null = null;
  for (const ss of src) {
    if (ss.state !== sa) continue;
    for (const ts of tgt) {
      if (ts.state !== sb) continue;
      const ov = Math.min(ss.end + lag, ts.end) - Math.max(ss.start + lag, ts.start);
      if (!best || ov > best.ov) best = { ss, ts, ov };
    }
  }
  return best;
}

export function StateLinkFlow(props: {
  aligned: Aligned;
  links: StateLink[];
  T: number;
  // Controlled thresholds, defaulted per dataset by App.
  lagMin: number;
  syncMin: number;
  onLagMin: (v: number) => void;
  onSyncMin: (v: number) => void;
}) {
  const t = useT();
  const { aligned, links, T, lagMin, syncMin, onLagMin, onSyncMin } = props;
  const [filter, setFilter] = useState<Filter>("all");

  // Measure the plot width and lay out in pixels, so nothing is scaled and blurred.
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(720);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) setPlotW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = aligned.sequences;
  const rowOf = new Map(rows.map((s, i) => [s.name, i]));
  const H = rows.length * ROW_H;
  const x = (t: number) => (t / T) * plotW;
  const yc = (i: number) => i * ROW_H + ROW_H / 2;

  const pick = (type: StateLink["type"], n: number, thr: number) =>
    links
      .filter((l) => l.type === type && l.score >= thr)
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  const lead = pick("lead-lag", N_LEAD, lagMin);
  const sync = pick("synchronous", N_SYNC, syncMin);
  const showLead = filter !== "synchronous";
  const showSync = filter !== "lead-lag";

  // Lagged influence -> C-shaped arcs
  const arcs = (showLead ? lead : [])
    .map((l) => {
      const si = rowOf.get(l.from_series);
      const ti = rowOf.get(l.to_series);
      if (si === undefined || ti === undefined || si === ti) return null;
      const at = anchorTimes(rows[si].segments, rows[ti].segments, l.from_state, l.to_state, l.lag);
      if (!at) return null;
      const dir = ti > si ? 1 : -1;
      const x0 = x(at.sx);
      const x3 = x(at.tx);
      const y0 = yc(si) + (dir * BAR_H) / 2;
      const y3 = yc(ti) - (dir * BAR_H) / 2;
      const my = (y0 + y3) / 2;
      const cxp = (x0 + x3) / 2 + 20 + Math.abs(ti - si) * 9;
      const d = `M ${x0} ${y0} Q ${cxp} ${my} ${x3} ${y3}`;
      return {
        l,
        d,
        x0,
        y0,
        x3,
        y3,
        width: 1.3 + l.score * 2.0,
        labelX: 0.25 * (x0 + x3) + 0.5 * cxp,
        labelY: my,
      };
    })
    .filter(Boolean) as {
    l: StateLink;
    d: string;
    x0: number;
    y0: number;
    x3: number;
    y3: number;
    width: number;
    labelX: number;
    labelY: number;
  }[];

  // Contemporaneous co-occurrence -> a pair of dashed boxes
  const frameRect = (seg: Segment, rowi: number) => ({
    x: x(seg.start) - 1.5,
    y: yc(rowi) - BAR_H / 2 - 3,
    w: Math.max(4, x(seg.end) - x(seg.start)) + 3,
    h: BAR_H + 6,
  });
  const frames = (showSync ? sync : [])
    .map((l, k) => {
      const si = rowOf.get(l.from_series);
      const ti = rowOf.get(l.to_series);
      if (si === undefined || ti === undefined) return null;
      const seg = bestPair(rows[si].segments, rows[ti].segments, l.from_state, l.to_state, 0);
      if (!seg) return null;
      return {
        l,
        color: FRAME_COLORS[k % FRAME_COLORS.length],
        dash: FRAME_DASH[k % FRAME_DASH.length],
        r1: frameRect(seg.ss, si),
        r2: frameRect(seg.ts, ti),
      };
    })
    .filter(Boolean) as {
    l: StateLink;
    color: string;
    dash: string;
    r1: { x: number; y: number; w: number; h: number };
    r2: { x: number; y: number; w: number; h: number };
  }[];

  if (rows.length === 0) return null;
  const tableRows = filter === "lead-lag" ? lead : filter === "synchronous" ? sync : [...sync, ...lead];

  return (
    <Card title={t("flow.title")}>
      <Note>{tr("flow.note")}</Note>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-muted">
        <SegToggle
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("flow.all") },
            { value: "lead-lag", label: t("flow.lead", { n: lead.length }) },
            { value: "synchronous", label: t("flow.sync", { n: sync.length }) },
          ]}
        />
        <ThresholdSlider value={lagMin} onChange={onLagMin} label={t("flow.lagStrength")} />
        <ThresholdSlider value={syncMin} onChange={onSyncMin} label={t("flow.syncStrength")} />
        <span className="tabular-nums">{t("flow.shown", { n: arcs.length + frames.length })}</span>
      </div>

      <div className="mt-3">
        <Legend />
      </div>

      {/* SVG ribbons and links on the left, HTML service names on the right */}
      <div className="mt-2 flex">
        <div ref={plotRef} className="min-w-0 flex-1">
          <svg width={plotW} height={H} viewBox={`0 0 ${plotW} ${H}`} className="block overflow-visible">
            <defs>
              <marker
                id="slf-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="13.5"
                markerHeight="13.5"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M1.5,2 L8.5,5 L1.5,8 z" fill="context-stroke" />
              </marker>
            </defs>

            {/* One state ribbon per service */}
            {rows.map((seq, i) => (
              <g key={seq.name}>
                {seq.segments.map((s, j) => (
                  <rect
                    key={j}
                    x={x(s.start)}
                    y={yc(i) - BAR_H / 2}
                    width={Math.max(0.6, x(s.end) - x(s.start))}
                    height={BAR_H}
                    fill={stateColor(s.state)}
                    rx={1}
                  >
                    <title>{t("viz.seriesStateTip", { name: dyn(seq.name), state: s.state, start: s.start, end: s.end })}</title>
                  </rect>
                ))}
              </g>
            ))}

            {/* Co-occurrence: paired dashed boxes */}
            {frames.map((f, idx) => (
              <g key={`fr${idx}`} fill="none" stroke={f.color} strokeWidth={1.8} strokeDasharray={f.dash}>
                <rect x={f.r1.x} y={f.r1.y} width={f.r1.w} height={f.r1.h} rx={3}>
                  <title>{syncTip(f.l)}</title>
                </rect>
                <rect x={f.r2.x} y={f.r2.y} width={f.r2.w} height={f.r2.h} rx={3}>
                  <title>{syncTip(f.l)}</title>
                </rect>
              </g>
            ))}

            {/* Lagged influence: white halo underneath */}
            {arcs.map((c, idx) => (
              <path key={`halo${idx}`} d={c.d} fill="none" stroke={HALO} strokeWidth={c.width + 2.6} strokeLinecap="round" opacity={0.95} />
            ))}

            {/* Lagged influence: the arc and its arrow */}
            {arcs.map((c, idx) => (
              <path
                key={`line${idx}`}
                d={c.d}
                fill="none"
                stroke={INK_LAG}
                strokeWidth={c.width}
                strokeLinecap="round"
                markerEnd="url(#slf-arrow)"
                opacity={0.95}
              >
                <title>
                  {t("flow.tipLead", {
                    from: dyn(c.l.from), to: dyn(c.l.to), lag: c.l.lag,
                    score: c.l.score.toFixed(3), support: c.l.support.toFixed(3),
                  })}
                </title>
              </path>
            ))}

            {/* Lagged influence: state-coloured end dots */}
            {arcs.map((c, idx) => (
              <g key={`dot${idx}`}>
                <circle cx={c.x0} cy={c.y0} r={3} fill={stateColor(c.l.from_state)} stroke={HALO} strokeWidth={1.2} />
                <circle cx={c.x3} cy={c.y3} r={3} fill={stateColor(c.l.to_state)} stroke={HALO} strokeWidth={1.2} />
              </g>
            ))}

            {/* Lagged influence: the lag value */}
            {arcs.map((c, idx) => (
              <text
                key={`lab${idx}`}
                x={c.labelX}
                y={c.labelY + 3}
                textAnchor="middle"
                fontSize={9}
                className="fill-fg-muted"
                style={{ paintOrder: "stroke", stroke: HALO, strokeWidth: 2.8 }}
              >
                {c.l.lag}
              </text>
            ))}
          </svg>
        </div>

        <div className="shrink-0" style={{ width: LABEL_W }}>
          {rows.map((seq) => (
            <div
              key={seq.name}
              className="flex items-center justify-start pl-2 text-left text-[11px] leading-tight text-fg-muted [overflow-wrap:anywhere]"
              style={{ height: ROW_H }}
              title={dyn(seq.name)}
            >
              <span>{dyn(seq.name)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detail table */}
      {tableRows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-fg-muted">
                <th className="py-1 pr-3 text-left font-medium">{t("flow.colSource")}</th>
                <th className="py-1 pr-3 text-left font-medium">{t("flow.colTarget")}</th>
                <th className="py-1 pr-3 text-left font-medium">{t("flow.colType")}</th>
                <th className="py-1 pr-3 text-right font-medium">lag</th>
                <th className="py-1 pr-3 text-right font-medium">{t("flow.colStrength")}</th>
                <th className="py-1 text-right font-medium">{t("flow.colSupport")}</th>
              </tr>
            </thead>
            <tbody>
              {[...tableRows]
                .sort((a, b) => b.score - a.score)
                .map((l, i) => (
                  <tr key={i} className="border-t border-black/5">
                    <td className="py-1 pr-3">
                      <Chip series={l.from_series} state={l.from_state} />
                    </td>
                    <td className="py-1 pr-3">
                      <Chip series={l.to_series} state={l.to_state} />
                    </td>
                    <td className="py-1 pr-3">
                      <span className={l.type === "synchronous" ? "text-fg-muted" : "text-fg"}>
                        {l.type === "synchronous" ? t("flow.typeSync") : t("flow.typeLead")}
                      </span>
                    </td>
                    <td className="py-1 pr-3 text-right">{l.lag}</td>
                    <td className="py-1 pr-3 text-right">{l.score.toFixed(3)}</td>
                    <td className="py-1 text-right text-fg-muted">{l.support.toFixed(3)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Tooltip shared by both boxes of a co-occurrence pair.
function syncTip(l: StateLink): string {
  return t("flow.tipSync", {
    from: dyn(l.from), to: dyn(l.to),
    score: l.score.toFixed(3), support: l.support.toFixed(3),
  });
}

// Legend explaining the arcs and dashed boxes.
function Legend() {
  const t = useT();
  return (
    <div className="inline-grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border border-border-soft bg-app-bg/60 px-3 py-2 text-[11px] leading-tight text-fg-muted">
      <div className="flex items-center gap-2">
        <svg width="40" height="15" viewBox="0 0 40 15" className="shrink-0">
          <path d="M2,12 Q20,1 34,8" fill="none" stroke={INK_LAG} strokeWidth="2" strokeLinecap="round" />
          <path d="M30,4.5 L38,8 L30,11.5 z" fill={INK_LAG} />
          <circle cx="2" cy="12" r="2.6" fill="#2563eb" stroke={HALO} strokeWidth="1" />
          <circle cx="34" cy="8" r="2.6" fill="#16a34a" stroke={HALO} strokeWidth="1" />
        </svg>
        <span>{tr("flow.legendLead")}</span>
      </div>
      <div className="flex items-center gap-2">
        <svg width="40" height="15" viewBox="0 0 40 15" className="shrink-0">
          <rect x="1" y="3" width="14" height="9" rx="2" fill="none" stroke="#d6453c" strokeWidth="1.6" strokeDasharray="4 2" />
          <rect x="25" y="3" width="14" height="9" rx="2" fill="none" stroke="#d6453c" strokeWidth="1.6" strokeDasharray="4 2" />
        </svg>
        <span>{tr("flow.legendSync")}</span>
      </div>
      <div className="flex items-center gap-2">
        <svg width="40" height="15" viewBox="0 0 40 15" className="shrink-0">
          <circle cx="11" cy="7.5" r="3.4" fill="#9a52d6" stroke={HALO} strokeWidth="1" />
          <circle cx="29" cy="7.5" r="3.4" fill="#e08a1e" stroke={HALO} strokeWidth="1" />
        </svg>
        <span>{t("flow.legendDot")}</span>
      </div>
    </div>
  );
}

function Chip(props: { series: string; state: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: stateColor(props.state) }} />
      <span className="text-fg">{dyn(props.series)}</span>
      <span className="text-fg-muted">S{props.state}</span>
    </span>
  );
}
