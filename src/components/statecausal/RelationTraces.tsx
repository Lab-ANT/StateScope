import { forwardRef, useId } from "react";
import { dyn } from "../../i18n";
import { FONT, INK, mechKey, paperStateColor, type SCEdge, type SCSeries } from "./model";

// Arrows: trigger = solid (from cause start, or end for ⊣); condition = dashed.

const VW = 1200;
const LABEL_FONT = 17;
const RIGHT = 14;
const ROW = 62; // color band height
const GAP = 34;
const TOP = 12;
const MAX_ARROWS = 400;

export const RelationTraces = forwardRef<SVGSVGElement, {
  series: SCSeries[];
  edges: SCEdge[]; // only edges of the selected mechanisms
  range: [number, number]; // displayed time window [t0, t1)
}>(function RelationTraces({ series, edges, range: [t0, t1] }, ref) {
  const uid = useId().replace(/:/g, "");
  const byName = new Map(series.map((s) => [s.name, s]));

  const order: string[] = [];
  const push = (s: string) => { if (!order.includes(s) && byName.has(s)) order.push(s); };
  const mechs = [...new Map(edges.map((e) => [mechKey(e.mech), e.mech])).values()];
  const nodeOf = new Map(edges.flatMap((e) => [[e.cause.name, e.cause], [e.effect.name, e.effect]] as const));
  for (const m of mechs) {
    m.triggers.forEach((p) => push(nodeOf.get(p)?.series ?? ""));
    push(nodeOf.get(m.child)?.series ?? "");
    m.cond.forEach(([p]) => push(nodeOf.get(p)?.series ?? ""));
  }
  const rowY = new Map(order.map((s, i) => [s, TOP + i * (ROW + GAP)]));
  // ~0.6 em per char (CJK = 1 em), clamped to [150, 380]
  const labelOf = (name: string) => { const s = byName.get(name)!; return s.metric ? `${dyn(s.entity)} · ${dyn(s.metric)}` : dyn(s.entity); };
  const em = (txt: string) => [...txt].reduce((w, ch) => w + (/[\u2E80-\uFFFF]/.test(ch) ? 1 : 0.6), 0);
  const LABEL = Math.min(380, Math.max(150, Math.max(0, ...order.map((n) => em(labelOf(n)))) * LABEL_FONT + 28));
  const H = TOP + order.length * (ROW + GAP) - GAP + 26;
  const span = Math.max(1, t1 - t0);
  const X = (v: number) => LABEL + ((Math.min(Math.max(v, t0), t1) - t0) / span) * (VW - LABEL - RIGHT);
  const inWin = (v: number) => v >= t0 && v <= t1;

  const involved = new Set(edges.flatMap((e) => [e.cause.name, e.effect.name]));

  type Arrow = { x1: number; y1: number; x2: number; y2: number; dashed: boolean };
  const arrows: Arrow[] = [];
  const link = (from: string, to: string, ta: number, tb: number, dashed: boolean) => {
    const ya = rowY.get(from), yb = rowY.get(to);
    if (ya === undefined || yb === undefined || !inWin(ta) || !inWin(tb)) return;
    const down = yb > ya;
    arrows.push({ x1: X(ta), y1: down ? ya + ROW : ya, x2: X(tb), y2: down ? yb : yb + ROW, dashed });
  };
  const segsOf = (name: string) => {
    const n = nodeOf.get(name);
    return n ? (byName.get(n.series)?.segments ?? []).filter((g) => g[2] === n.state) : [];
  };
  for (const m of mechs) {
    const child = nodeOf.get(m.child);
    if (!child) continue;
    if (m.triggers.length) {
      for (const [p, pt, ct] of m.matches) {
        const pn = nodeOf.get(p);
        if (!pn) continue;
        link(pn.series, child.series, pt, ct, false);
        // Conditioned trigger: condition points to the same effect at the trigger time
        for (const [c] of m.cond) {
          const cn = nodeOf.get(c);
          if (cn) link(cn.series, child.series, pt, ct, true);
        }
      }
    } else {
      // Pure condition: vertical line at the effect start
      for (const [s] of segsOf(m.child)) {
        for (const [c, neg] of m.cond) {
          const cn = nodeOf.get(c);
          if (!cn) continue;
          const on = segsOf(c).some(([u, v]) => u <= s && s < v);
          if (on !== neg) link(cn.series, child.series, s, s, true);
        }
      }
    }
  }
  const shown = arrows.slice(0, MAX_ARROWS);

  const row = (name: string) => {
    const s = byName.get(name)!;
    const y = rowY.get(name)!;
    const segs = s.segments.filter(([a, b]) => b > t0 && a < t1);
    // Normalized by the in-window range to 80% of the band height
    const pts = s.x.map((x, i) => [x, s.values[i]] as const).filter(([x]) => x >= t0 && x <= t1);
    const vs = pts.map(([, v]) => v);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const Yv = (v: number) => y + ROW / 2 - (hi === lo ? 0 : ((v - lo) / (hi - lo) - 0.5) * ROW * 0.8);
    const path = pts.map(([x, v], i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Yv(v).toFixed(1)}`).join("");
    return (
      <g key={name}>
        {segs.map(([a, b, st], i) => (
          <rect key={i} x={X(a)} y={y} width={Math.max(0.5, X(b) - X(a))} height={ROW} fill={paperStateColor(st)}
            fillOpacity={0.9} stroke="#FFFFFF" strokeWidth={1.2} />
        ))}
        {pts.length > 1 && <path d={path} fill="none" stroke="#1769AA" strokeWidth={1.8} strokeLinejoin="round" />}
        <text x={LABEL - 12} y={y + ROW / 2} textAnchor="end" dominantBaseline="central" fontFamily={FONT}
          fontSize={LABEL_FONT} fontWeight={700} fill={INK}>{labelOf(name)}</text>
      </g>
    );
  };
  // Outlines last so curves and arrows don't cover them
  const outlines = order.flatMap((name) => {
    const s = byName.get(name)!;
    const y = rowY.get(name)!;
    return s.segments
      .filter(([a, b, st]) => b > t0 && a < t1 && involved.has(`${name}:${st}`))
      .map(([a, b], i) => (
        <rect key={`${name}-o${i}`} x={X(a)} y={y} width={Math.max(0.5, X(b) - X(a))} height={ROW}
          fill="none" stroke={INK} strokeWidth={2.4} />
      ));
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(t0 + f * span));
  const yAxis = H - 20;

  return (
    <svg ref={ref} viewBox={`0 0 ${VW} ${H}`} width="100%" className="block h-auto" role="img">
      <defs>
        <marker id={`ra-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={INK} />
        </marker>
      </defs>
      <rect width={VW} height={H} fill="#FFFFFF" />
      {order.map(row)}
      {shown.map((a, i) => (
        <line key={i} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={INK} strokeWidth={2} strokeOpacity={0.75}
          strokeDasharray={a.dashed ? "7 5" : undefined} markerEnd={`url(#ra-${uid})`} />
      ))}
      {outlines}
      <line x1={LABEL} x2={VW - RIGHT} y1={yAxis} y2={yAxis} stroke="#9CA3AF" />
      {ticks.map((v) => (
        <g key={v}>
          <line x1={X(v)} x2={X(v)} y1={yAxis} y2={yAxis + 4} stroke="#9CA3AF" />
          <text x={X(v)} y={yAxis + 15} textAnchor="middle" fontFamily={FONT} fontSize={11} fill="#6B7280">{v.toLocaleString()}</text>
        </g>
      ))}
    </svg>
  );
});

export const RELATION_TRACES_MAX_ARROWS = MAX_ARROWS;
