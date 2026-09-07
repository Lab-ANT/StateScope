import { useState } from "react";
import type { TransitionGraph } from "../types";
import { stateColor } from "../theme";
import { useT } from "../i18n";

// System-level transition graph: nodes are global states and edge i->j carries
// P(next = j | current = i). States are laid out left to right along the main line (each
// state's modal successor), which is drawn straight and accented; other transitions arc
// below (forward) or above (back edges). Hovering a node highlights its edges.

const R = 19;
const ALEN = 12;
const AW = 5.5;
const MAIN = "#5363c9"; // accent indigo
const OTHER = "#9aa1ad";

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

export function StateTransitionGraph(props: { graph: TransitionGraph; threshold?: number }) {
  const t = useT();
  const { graph } = props;
  const threshold = props.threshold ?? 0;
  const [hover, setHover] = useState<number | null>(null);
  const states = graph.states;
  const n = states.length;
  if (n === 0) return <div className="text-xs text-fg-faint">{t("align.noTransitions")}</div>;

  // Walk the modal successors from the state with no main-line predecessor to order the spine.
  const mainSucc = new Map<number, number>();
  const hasMainIn = new Set<number>();
  for (const e of graph.edges) {
    if (e.main) {
      mainSucc.set(e.from, e.to);
      hasMainIn.add(e.to);
    }
  }
  const order: number[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = states.find((s) => !hasMainIn.has(s)) ?? states[0];
  while (cur !== undefined && !seen.has(cur)) {
    order.push(cur);
    seen.add(cur);
    cur = mainSucc.get(cur);
  }
  for (const s of states) if (!seen.has(s)) order.push(s);
  const oidx = new Map(order.map((s, i) => [s, i]));

  const W = Math.max(360, 120 * n);
  const H = 240;
  const yMid = H / 2;
  const margin = 46;
  const xOf = (s: number) => (n === 1 ? W / 2 : margin + ((W - 2 * margin) * oidx.get(s)!) / (n - 1));
  const pos = (s: number): Pt => ({ x: xOf(s), y: yMid });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} className="select-none">
      {graph.edges.filter((e) => e.prob >= threshold).map((e, k) => {
        const a = pos(e.from), b = pos(e.to);
        const di = oidx.get(e.to)! - oidx.get(e.from)!;
        const straight = e.main && di === 1;
        const up = di <= 0;
        const bend = straight ? 0 : Math.min(96, 26 + Math.abs(b.x - a.x) * 0.22);
        const ctrl = { x: (a.x + b.x) / 2, y: yMid + (up ? -bend : bend) };
        const start = trim(a, straight ? b : ctrl, R + 3);
        const tip = trim(b, straight ? a : ctrl, R + 5);
        const dir = unit(sub(tip, straight ? a : ctrl));
        const baseC = { x: tip.x - dir.x * ALEN, y: tip.y - dir.y * ALEN };
        const pd = { x: -dir.y, y: dir.x };
        const arrow = `${tip.x},${tip.y} ${baseC.x + pd.x * AW},${baseC.y + pd.y * AW} ${baseC.x - pd.x * AW},${baseC.y - pd.y * AW}`;
        const d = straight
          ? `M${start.x},${start.y} L${baseC.x},${baseC.y}`
          : `M${start.x},${start.y} Q${ctrl.x},${ctrl.y} ${baseC.x},${baseC.y}`;
        const color = e.main ? MAIN : OTHER;
        const w = (e.main ? 2.5 : 1.2) + e.prob * 5;
        const lx = straight ? (a.x + b.x) / 2 : ctrl.x;
        const ly = straight ? yMid - 8 : ctrl.y + (up ? -4 : 12);
        const touches = hover === null || e.from === hover || e.to === hover;
        const op = (e.main ? 1 : 0.55) * (touches ? 1 : 0.12);
        return (
          <g key={k} opacity={op}>
            <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
            <polygon points={arrow} fill={color} />
            {touches && (
              <text x={lx} y={ly} fill={e.main ? "#4250b0" : "#7b828e"} fontSize={9} textAnchor="middle"
                style={{ paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 3 }}
                className="font-mono">
                {e.prob.toFixed(2)}
              </text>
            )}
          </g>
        );
      })}
      {states.map((s) => {
        const p = pos(s);
        const dim = hover !== null && hover !== s;
        return (
          <g key={s} opacity={dim ? 0.35 : 1}
             onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)}
             style={{ cursor: "pointer" }}>
            <circle cx={p.x} cy={p.y} r={R} fill={stateColor(s)} stroke="#ffffff" strokeWidth={2.5} />
            <text x={p.x} y={p.y + 4} fill="#ffffff" fontSize={12} fontWeight={700} textAnchor="middle">
              S{s}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
