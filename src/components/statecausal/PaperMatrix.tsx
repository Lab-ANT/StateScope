import { forwardRef } from "react";
import { dyn, useT } from "../../i18n";
import { ENTITY_COLORS, FONT, INK, inkOn, mechKey, paperStateColor, parula, type SCEdge, type SCSeries } from "./model";

// Rows = cause states, columns = effect states. Cell text: trigger lag (⊣ = at cause end) or C / ¬C (condition).

const BAND = 30; // thickness of each header level
const GAP = 3;
const HEAD = 3 * BAND + 3 * GAP; // total header thickness (same on top and left)
const PAD = 6;
const BOX = "#D95319";

interface Axis {
  key: string; // "<series>:<state>"
  entity: string;
  metric: string;
  series: string;
  state: number;
}

const nodeLabel = (n: { entity: string; metric: string; state: number }) =>
  `${dyn(n.entity)}${n.metric ? `.${dyn(n.metric)}` : ""}=${n.state}`;

// runs of equal values [from, to)
function spans<T>(items: T[], key: (x: T) => string): { k: string; from: number; to: number }[] {
  const out: { k: string; from: number; to: number }[] = [];
  items.forEach((x, i) => {
    const k = key(x);
    const last = out[out.length - 1];
    if (last && last.k === k) last.to = i + 1;
    else out.push({ k, from: i, to: i + 1 });
  });
  return out;
}

export const PaperMatrix = forwardRef<SVGSVGElement, {
  series: SCSeries[]; // determines the entity → metric ordering
  edges: SCEdge[];
  selected: Set<string>; // mechanism keys (mechKey)
  onToggle?: (key: string) => void;
}>(function PaperMatrix({ series, edges, selected, onToggle }, ref) {
  const t = useT();
  const order = new Map(series.map((s, i) => [s.name, i]));
  const axis = (pick: (e: SCEdge) => SCEdge["cause"]): Axis[] => {
    const m = new Map<string, Axis>();
    for (const e of edges) {
      const n = pick(e);
      m.set(n.name, { key: n.name, entity: n.entity, metric: n.metric, series: n.series, state: n.state });
    }
    return [...m.values()].sort((a, b) => (order.get(a.series) ?? 0) - (order.get(b.series) ?? 0) || a.state - b.state);
  };
  const rows = axis((e) => e.cause);
  const cols = axis((e) => e.effect);
  const entityColor = new Map<string, string>();
  for (const s of series) if (!entityColor.has(s.entity)) entityColor.set(s.entity, ENTITY_COLORS[entityColor.size % ENTITY_COLORS.length]);

  const cell = Math.max(24, Math.min(46, Math.floor(860 / Math.max(rows.length, cols.length, 1))));
  const X0 = PAD + HEAD, Y0 = PAD + HEAD;
  const W = X0 + cols.length * cell + PAD;
  const H = Y0 + rows.length * cell + PAD;
  const X = (j: number) => X0 + j * cell;
  const Y = (i: number) => Y0 + i * cell;
  const ri = new Map(rows.map((r, i) => [r.key, i]));
  const ci = new Map(cols.map((c, j) => [c.key, j]));

  // multiple edges in one cell: keep the highest gain
  const cells = new Map<string, SCEdge>();
  for (const e of edges) {
    const k = `${ri.get(e.cause.name)},${ci.get(e.effect.name)}`;
    if (!cells.has(k) || cells.get(k)!.gain < e.gain) cells.set(k, e);
  }
  const gmax = Math.max(1, ...edges.map((e) => e.gain));

  const sel = edges.filter((e) => selected.has(mechKey(e.mech)));
  const box = sel.length > 0 && {
    r0: Math.min(...sel.map((e) => ri.get(e.cause.name)!)), r1: Math.max(...sel.map((e) => ri.get(e.cause.name)!)) + 1,
    c0: Math.min(...sel.map((e) => ci.get(e.effect.name)!)), c1: Math.max(...sel.map((e) => ci.get(e.effect.name)!)) + 1,
  };

  // Shrink font with span, then truncate at MIN_FONT (full name in <title>)
  const MIN_FONT = 10;
  const fit = (label: string, span: number, max: number): [string, number] => {
    const size = Math.min(max, (span * 1.35) / Math.max(label.length, 1));
    if (size >= MIN_FONT) return [label, size];
    const n = Math.max(1, Math.floor((span * 1.35) / MIN_FONT) - 1);
    return [label.slice(0, n) + "…", MIN_FONT];
  };

  const header = (items: Axis[], horizontal: boolean) => {
    const at = (level: number) => PAD + level * (BAND + GAP); // start of the given level (0 = entity)
    const out: JSX.Element[] = [];
    const rect = (k: string, level: number, from: number, to: number, fill: string) => {
      const a = (horizontal ? X0 : Y0) + from * cell, len = (to - from) * cell - 1.5;
      out.push(horizontal
        ? <rect key={k} x={a} y={at(level)} width={len} height={BAND} fill={fill} />
        : <rect key={k} x={at(level)} y={a} width={BAND} height={len} fill={fill} />);
      return { mid: a + len / 2, len };
    };
    const text = (k: string, level: number, mid: number, s: string, size: number, fill: string, full?: string) => {
      const c = at(level) + BAND / 2;
      out.push(
        <text key={k} x={horizontal ? mid : c} y={horizontal ? c : mid} fill={fill} fontSize={size} fontWeight={700}
          fontFamily={FONT} textAnchor="middle" dominantBaseline="central"
          transform={horizontal ? undefined : `rotate(-90 ${c} ${mid})`}>
          {full && full !== s && <title>{full}</title>}
          {s}
        </text>,
      );
    };
    for (const sp of spans(items, (x) => x.entity)) {
      const { mid, len } = rect(`e-${sp.k}`, 0, sp.from, sp.to, entityColor.get(sp.k)!);
      const full = dyn(sp.k);
      const [label, size] = fit(full, len, 15);
      text(`et-${sp.k}`, 0, mid, label, size, "#FFFFFF", full);
    }
    for (const sp of spans(items, (x) => x.series)) {
      const it = items[sp.from];
      const { mid, len } = rect(`m-${sp.k}`, 1, sp.from, sp.to, "#F2F2F2");
      const full = dyn(it.metric);
      const [label, size] = fit(full, len, 13);
      text(`mt-${sp.k}`, 1, mid, label, size, entityColor.get(it.entity)!, full);
    }
    items.forEach((it, i) => {
      const { mid } = rect(`s-${it.key}`, 2, i, i + 1, paperStateColor(it.state));
      text(`st-${it.key}`, 2, mid, String(it.state), 13, INK);
    });
    return out;
  };

  // separators: entity boundaries thickest, metric medium, state thinnest
  const lines = (items: Axis[], horizontal: boolean) =>
    Array.from({ length: items.length + 1 }, (_, p) => {
      const ent = p === 0 || p === items.length || items[p - 1].entity !== items[p].entity;
      const met = !ent && items[p - 1].series !== items[p].series;
      const [stroke, w] = ent ? ["#303030", 2] : met ? ["#858585", 1.3] : ["#CBCBCB", 0.7];
      return horizontal
        ? <line key={`vl${p}`} x1={X(p)} x2={X(p)} y1={Y0} y2={Y(rows.length)} stroke={stroke} strokeWidth={w} />
        : <line key={`hl${p}`} x1={X0} x2={X(cols.length)} y1={Y(p)} y2={Y(p)} stroke={stroke} strokeWidth={w} />;
    });

  const cornerY = (level: number) => PAD + level * (BAND + GAP) + BAND / 2;
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} className="block h-auto"
      role="img" aria-label={t("scf.matrixAria")}>
      <rect width={W} height={H} fill="#FFFFFF" />
      {[t("scf.cornerEntity"), t("scf.cornerMetric"), t("scf.cornerState")].map((s, i) => (
        <text key={s} x={X0 - 8} y={cornerY(i)} textAnchor="end" dominantBaseline="central" fontFamily={FONT}
          fontSize={11} fontWeight={700} fill="#777777">{s}</text>
      ))}
      {header(cols, true)}
      {header(rows, false)}
      <rect x={X0} y={Y0} width={cols.length * cell} height={rows.length * cell} fill="#FFFFFF" />
      {lines(cols, true)}
      {lines(rows, false)}
      {[...cells.entries()].map(([k, e]) => {
        const [i, j] = k.split(",").map(Number);
        const fill = parula(0.5 + (0.5 * e.gain) / gmax);
        const label = e.role === "trigger"
          ? `${e.atEnd ? "⊣" : ""}${e.lag === null ? "·" : Math.round(e.lag)}`
          : e.role === "cond_neg" ? "¬C" : "C";
        const how = e.role === "trigger"
          ? t(e.atEnd ? "mc.tipLagEnd" : "mc.tipLag", { lag: e.lag === null ? "—" : e.lag.toFixed(1) })
          : t(e.role === "cond" ? "mc.tipCond" : "mc.tipCondNeg");
        return (
          <g key={k} className={onToggle ? "cursor-pointer" : undefined} onClick={() => onToggle?.(mechKey(e.mech))}>
            <title>{`${nodeLabel(e.cause)} → ${nodeLabel(e.effect)}\n${how} · ${e.gain.toFixed(1)} bits`}</title>
            <rect x={X(j) + 1.5} y={Y(i) + 1.5} width={cell - 3} height={cell - 3} fill={fill} />
            <text x={X(j) + cell / 2} y={Y(i) + cell / 2} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}
              fontWeight={700} fontSize={Math.min(16, cell * 0.4)} fill={inkOn(fill)}>{label}</text>
          </g>
        );
      })}
      {box && (
        <rect x={X(box.c0)} y={Y(box.r0)} width={(box.c1 - box.c0) * cell} height={(box.r1 - box.r0) * cell}
          fill="none" stroke={BOX} strokeWidth={4} pointerEvents="none" />
      )}
    </svg>
  );
});
