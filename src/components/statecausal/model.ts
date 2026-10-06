
export interface SCNode {
  name: string; // "<series>:<state>"
  series: string; // "<entity>.<metric>"
  entity: string;
  metric: string;
  state: number;
}

export interface SCMech {
  child: string;
  triggers: string[];
  cond: [string, boolean][]; // [state event, negated]
  matches: [string, number, number][]; // [parent event, parent occurrence time, child start time]
}

// A two-parent mechanism splits into two edges sharing gain and mechanism.
export interface SCEdge {
  cause: SCNode;
  effect: SCNode;
  role: "trigger" | "cond" | "cond_neg";
  gain: number;
  lag: number | null; // mean trigger lag
  atEnd: boolean; // trigger time is the end of the cause state
  mech: SCMech;
}

export interface SCSeries {
  name: string; // "<entity>.<metric>"
  entity: string;
  metric: string;
  T: number;
  x: number[]; // time indices after downsampling
  values: number[];
  segments: [number, number, number][]; // [start, end, state]
}

export const mechKey = (m: SCMech): string =>
  `${m.child}|${m.triggers.join(",")}|${m.cond.map(([c, n]) => `${n ? "!" : ""}${c}`).join(",")}`;

// Cycles beyond 4 states
export const PAPER_STATE_COLORS = ["#E6EDF2", "#F3C66B", "#C5AFE0", "#A8CF87", "#F2A38A", "#9CC9E8", "#E7D27C", "#C9B6A5", "#B5D8CC", "#E3A7C9"];
export const paperStateColor = (st: number) => PAPER_STATE_COLORS[st % PAPER_STATE_COLORS.length];
// MATLAB color order, assigned by entity order of appearance
export const ENTITY_COLORS = ["#0072BD", "#D95319", "#77AC30", "#7E2F8E", "#A2142F", "#4DBEEE", "#EDB120", "#3B5B92"];
export const FONT = "Helvetica, Arial, sans-serif";
export const INK = "#262626";

// Approximate parula: 0.5 → dark blue, 1 → yellow
const PARULA = ["#352A87", "#2354A1", "#1C79AB", "#25A2AD", "#55BF94", "#8DCE66", "#C9D94B", "#F9E721"];
export function parula(strength: number): string {
  const t = Math.max(0, Math.min(1, (strength - 0.5) / 0.5)) * (PARULA.length - 1);
  const lo = Math.min(Math.floor(t), PARULA.length - 2);
  const f = t - lo;
  const a = PARULA[lo], b = PARULA[lo + 1];
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * f).toString(16).padStart(2, "0")).join("");
}
export function inkOn(fill: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 145 ? "#FFFFFF" : INK;
}

export function downloadSvg(svg: SVGSVGElement | null, filename: string): void {
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width) {
    clone.setAttribute("width", String(vb.width));
    clone.setAttribute("height", String(vb.height));
  }
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
