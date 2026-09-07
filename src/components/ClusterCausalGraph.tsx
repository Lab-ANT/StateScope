import type { PCMCIEdge } from "../types";
import { t, useT, dyn } from "../i18n";

// Causal graph of one regime, laid out radially: each pod is a cluster on a large circle,
// with its channel nodes arranged inside. A node's border colour is its pod and its fill is
// the metric kind. Intra-pod edges stay light grey; cross-pod edges arc in the source pod's
// colour. Solid means contemporaneous, dashed means lagged, width is proportional to
// |strength|. The canvas has a fixed maximum width so it is never scaled up.

const SIZE = 700;
const CX = SIZE / 2;
const CY = SIZE / 2;
const SPREAD = 13;
const ALEN = 11;
const AW = 5;

// Short metric label drawn inside a node: translate first, then truncate.
function shortKind(k: string): string {
  const s = dyn(k);
  if (/^[\x00-\x7F]+$/.test(s)) return s.length <= 4 ? s : s.slice(0, 4);
  return s.length <= 2 ? s : s.slice(0, 2);
}

// Pod border colours
const POD_COLORS = ["#3b6fe0", "#d6453c", "#16a34a", "#9333ea", "#e08a1e", "#0891b2", "#c2410c", "#0ea5e9"];
// Metric fill colours, lightened via fillOpacity
const METRIC_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#ca8a04", "#db2777", "#7c3aed"];
const INTRA = "#b9bfca"; // intra-pod edges

type Pt = { x: number; y: number };
const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y });
const unit = (p: Pt): Pt => {
  const L = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / L, y: p.y / L };
};
const trim = (p: Pt, toward: Pt, d: number): Pt => {
  const u = unit(sub(toward, p));
  return { x: p.x + u.x * d, y: p.y + u.y * d };
};

export function ClusterCausalGraph(props: {
  varNames: string[];
  podOf: string[];
  kindOf: string[];
  pods: string[];
  edges: PCMCIEdge[];
  threshold?: number;
  showSelf?: boolean;
  nodeR?: number; // node radius
  chSpread?: number; // channel spacing inside a pod
  bow?: number; // curvature of cross-pod edges
  maxWidth?: number;
  stride?: number; // downsample factor: lag * stride = raw steps
  gtEdges?: { src: string; dst: string }[]; // reference topology, drawn underneath
  gtDirected?: boolean; // call graph and flow are directed; co-location is not
}) {
  useT(); // redraw labels when the language changes
  const { varNames, podOf, kindOf, pods, edges, threshold = 0, showSelf = false } = props;
  const gtEdges = props.gtEdges ?? [];
  const gtDirected = props.gtDirected ?? true;
  const stride = props.stride ?? 1;
  const nodeR = props.nodeR ?? 24;
  const chSpread = props.chSpread ?? 2.4;
  const bow = props.bow ?? 0.14;
  const maxWidth = props.maxWidth ?? 680;
  const kinds = [...new Set(kindOf)];
  const metricColor = (k: string) => METRIC_COLORS[Math.max(0, kinds.indexOf(k)) % METRIC_COLORS.length];
  const podColor = (p: string) => POD_COLORS[Math.max(0, pods.indexOf(p)) % POD_COLORS.length];

  // Node size drives cluster size, and the pod ring adapts so nothing leaves the canvas.
  const NODE_R = nodeR;
  const CH_R = Math.round(nodeR * chSpread);
  const HALO = CH_R + nodeR + 12;
  const nPods = pods.length;
  const podRing = Math.max(HALO + 14, SIZE / 2 - HALO - 26);
  const chOfPod: Record<string, number[]> = {};
  varNames.forEach((_, i) => (chOfPod[podOf[i]] ??= []).push(i));
  const podCenter: Pt[] = [];
  const posOf: Pt[] = new Array(varNames.length);
  pods.forEach((pod, pi) => {
    const a = -Math.PI / 2 + (2 * Math.PI * pi) / nPods;
    const C = { x: CX + podRing * Math.cos(a), y: CY + podRing * Math.sin(a) };
    podCenter[pi] = C;
    const list = chOfPod[pod] ?? [];
    list.forEach((ci, k) => {
      if (list.length === 1) {
        posOf[ci] = C;
      } else {
        const a2 = -Math.PI / 2 + (2 * Math.PI * k) / list.length;
        posOf[ci] = { x: C.x + CH_R * Math.cos(a2), y: C.y + CH_R * Math.sin(a2) };
      }
    });
  });

  const idx = (nm: string) => varNames.indexOf(nm);
  const shown = edges.filter(
    (e) => (showSelf || e.src !== e.dst) && Math.abs(e.strength) >= threshold,
  );

  // Multiple edges between the same pair get parallel lanes
  type Lane = { perp: Pt; off: number };
  const lane = new Map<number, Lane>();
  const groups = new Map<string, number[]>();
  shown.forEach((e, k) => {
    const a = idx(e.src);
    const b = idx(e.dst);
    if (a < 0 || b < 0 || a === b) return;
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(k);
  });
  for (const [key, ks] of groups) {
    const [lo, hi] = key.split("-").map(Number);
    const perp = unit({ x: -(posOf[hi].y - posOf[lo].y), y: posOf[hi].x - posOf[lo].x });
    ks.forEach((k, i) => lane.set(k, { perp, off: (i - (ks.length - 1) / 2) * SPREAD }));
  }

  // Arrow at `node` pointing away from `ctrl`; returns its base and triangle points.
  const arrowAt = (node: Pt, ctrl: Pt) => {
    const tip = trim(node, ctrl, NODE_R + 3);
    const dir = unit(sub(tip, ctrl));
    const base = { x: tip.x - dir.x * ALEN, y: tip.y - dir.y * ALEN };
    const pd = { x: -dir.y, y: dir.x };
    return { base, pts: `${tip.x},${tip.y} ${base.x + pd.x * AW},${base.y + pd.y * AW} ${base.x - pd.x * AW},${base.y - pd.y * AW}` };
  };

  // doubleHead draws an arrow at both ends; otherwise only the target end has one.
  const geom = (a: Pt, b: Pt, ln: Lane, bow: number, doubleHead: boolean) => {
    const ctrl = {
      x: (a.x + b.x) / 2 + ln.perp.x * (ln.off + bow),
      y: (a.y + b.y) / 2 + ln.perp.y * (ln.off + bow),
    };
    const end = arrowAt(b, ctrl);
    let p0: Pt;
    let startArrow: string | null = null;
    if (doubleHead) {
      const st = arrowAt(a, ctrl);
      p0 = st.base;
      startArrow = st.pts;
    } else {
      p0 = trim(a, ctrl, NODE_R + 2);
    }
    // Anchor the label at t=0.5 and rotate it along source->target, flipped to stay upright.
    const mid = {
      x: 0.25 * p0.x + 0.5 * ctrl.x + 0.25 * end.base.x,
      y: 0.25 * p0.y + 0.5 * ctrl.y + 0.25 * end.base.y,
    };
    let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (angle > 90 || angle < -90) angle += 180;
    return { d: `M${p0.x},${p0.y} Q${ctrl.x},${ctrl.y} ${end.base.x},${end.base.y}`, arrow: end.pts, startArrow, mid, angle };
  };

  if (varNames.length === 0) return null;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ maxWidth }} className="mx-auto block overflow-visible">
      {/* Reference topology: grey dashed pod-to-pod arcs, drawn underneath */}
      {gtEdges.map((e, k) => {
        const si = pods.indexOf(e.src);
        const di = pods.indexOf(e.dst);
        if (si < 0 || di < 0 || si === di) return null;
        const A = podCenter[si];
        const B = podCenter[di];
        const perp = unit({ x: -(B.y - A.y), y: B.x - A.x });
        const len = Math.hypot(B.x - A.x, B.y - A.y);
        const ctrl = { x: (A.x + B.x) / 2 + perp.x * len * 0.12, y: (A.y + B.y) / 2 + perp.y * len * 0.12 };
        const a0 = trim(A, ctrl, HALO);
        const b0 = trim(B, ctrl, HALO + ALEN);
        const dir = unit(sub(b0, ctrl));
        const pd = { x: -dir.y, y: dir.x };
        const tip = trim(B, ctrl, HALO);
        const end = gtDirected ? b0 : trim(B, ctrl, HALO); // undirected: no room for an arrow
        return (
          <g key={`gt${k}`} opacity={0.5}>
            <path d={`M${a0.x},${a0.y} Q${ctrl.x},${ctrl.y} ${end.x},${end.y}`} fill="none"
              stroke="#8b93a1" strokeWidth={2} strokeDasharray="2 5" strokeLinecap="round" />
            {gtDirected && (
              <polygon points={`${tip.x},${tip.y} ${b0.x + pd.x * 4},${b0.y + pd.y * 4} ${b0.x - pd.x * 4},${b0.y - pd.y * 4}`}
                fill="#8b93a1" />
            )}
            <title>
              {gtDirected
                ? t("cluster.gtTipDirected", { src: dyn(e.src), dst: dyn(e.dst) })
                : t("cluster.gtTipUndirected", { src: dyn(e.src), dst: dyn(e.dst) })}
            </title>
          </g>
        );
      })}

      {/* Pod halo and name, placed directly above or below the cluster */}
      {pods.map((pod, pi) => {
        const C = podCenter[pi];
        const col = podColor(pod);
        const above = C.y <= CY;
        const ly = above ? C.y - HALO - 8 : C.y + HALO + 18;
        return (
          <g key={pod}>
            <circle cx={C.x} cy={C.y} r={HALO} fill={col} fillOpacity={0.05} stroke={col} strokeOpacity={0.28} strokeWidth={1.2} />
            <text x={C.x} y={ly} textAnchor="middle" fontSize={13} fontWeight={600} fill={col}>
              {(() => {
                const nm = dyn(pod);
                return nm.length > 18 ? nm.slice(0, 17) + "…" : nm;
              })()}
            </text>
          </g>
        );
      })}

      {/* Causal edges */}
      {shown.map((e, k) => {
        const a = idx(e.src);
        const b = idx(e.dst);
        if (a < 0 || b < 0 || a === b) return null;
        const ln = lane.get(k);
        if (!ln) return null;
        const inter = podOf[a] !== podOf[b];
        const color = inter ? podColor(podOf[a]) : INTRA;
        // Width scales with |strength| over a wide range so weak and strong edges differ.
        const w = Math.max(1, Math.min(6.5, 1 + Math.abs(e.strength) * 6));
        const len = Math.hypot(posOf[b].x - posOf[a].x, posOf[b].y - posOf[a].y);
        const bowAmt = inter ? len * bow : 0; // bow cross-pod chords away from the centre
        const sync = e.lag === 0;
        const steps = e.lag * stride; // in raw sampling steps
        // Both contemporaneous and lagged edges are directed, so all get a single arrow;
        // solid vs dashed distinguishes them.
        const { d, arrow, mid, angle } = geom(posOf[a], posOf[b], ln, bowAmt, false);
        const fz = Math.max(8, Math.round(nodeR * 0.4));
        // Label: signed strength, plus the lag in raw steps when lagged.
        const label = sync
          ? e.strength.toFixed(2)
          : `${e.strength.toFixed(2)} ${t("cluster.edgeLagSuffix", { n: steps })}`;
        return (
          <g key={k}>
            <g opacity={inter ? 0.82 : 0.5}>
              <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round"
                strokeDasharray={sync ? "0" : "5 4"} />
              <polygon points={arrow} fill={color} />
            </g>
            <text x={mid.x} y={mid.y - 2} textAnchor="middle" fontSize={fz} fontWeight={600}
              transform={`rotate(${angle.toFixed(1)} ${mid.x} ${mid.y})`} fill={color}
              style={{ paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 3, pointerEvents: "none" }}>
              {label}
            </text>
            <title>
              {t("cluster.edgeTip", {
                src: dyn(e.src), dst: dyn(e.dst),
                mode: sync ? t("cluster.edgeTipSync") : t("cluster.edgeTipLag", { n: steps }),
                strength: e.strength,
              })}
            </title>
          </g>
        );
      })}

      {/* Channel nodes */}
      {varNames.map((nm, i) => {
        const p = posOf[i];
        return (
          <g key={nm}>
            <circle cx={p.x} cy={p.y} r={NODE_R}
              fill={metricColor(kindOf[i])} fillOpacity={0.3}
              stroke={podColor(podOf[i])} strokeWidth={2.6}>
              <title>{dyn(nm)}</title>
            </circle>
            <text x={p.x} y={p.y + nodeR * 0.32} textAnchor="middle"
              fontSize={Math.max(7, Math.round(nodeR * 0.52))} fontWeight={600}
              fill="#334155" style={{ pointerEvents: "none" }}>
              {shortKind(kindOf[i])}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Metric legend (node fill colours)
export function KindLegend(props: { kinds: string[] }) {
  const t = useT();
  const uniq = [...new Set(props.kinds)];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      <span className="text-fg-faint">{t("cluster.kindLegend")}</span>
      {uniq.map((k, i) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: METRIC_COLORS[i % METRIC_COLORS.length], opacity: 0.5 }} />
          {dyn(k)}
        </span>
      ))}
    </div>
  );
}
