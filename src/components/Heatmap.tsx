import { heatColor, heatText } from "../theme";
import { Card } from "./ui";
import { useT, dyn } from "../i18n";
import { ENTITY_COLORS } from "./statecausal/model";

// Symmetric matrices draw only the lower triangle without the diagonal (always 1, halves duplicate).
const CELL = 50;
const BAND = 20; // entity band thickness
const LABEL_W = 70; // row label width

function isSymmetric(m: number[][]): boolean {
  return m.every((row, i) => row.every((v, j) => Math.abs(v - m[j][i]) < 1e-9));
}

// fill: width adapts to the card, capped at maxScale (default 1.3) to avoid oversized cells; 1 = shrink only.
export function Heatmap(props: {
  matrix: number[][]; labels: string[]; title: string; groups?: (string | undefined)[]; fill?: boolean; maxScale?: number;
  className?: string;
}) {
  const t = useT(); // redraw labels on language switch
  const { matrix, title } = props;
  const n = props.labels.length;
  const groups = props.groups && props.groups.length === n && props.groups.every(Boolean) ? (props.groups as string[]) : null;
  const tri = n >= 3 && isSymmetric(matrix); // lower-triangle mode
  const labels = props.labels.map((l, i) => {
    const g = groups?.[i];
    return dyn(g && l.startsWith(`${g}.`) ? l.slice(g.length + 1) : l);
  });
  const trunc = (s: string, k: number) => (s.length > k ? s.slice(0, k - 1) + "…" : s);
  const rotate = labels.some((l) => l.length > 8); // horizontal column labels when metric names are short

  // Lower-triangle: rows = 1..n-1, columns = 0..n-2
  const rows = tri ? [...Array(n - 1).keys()].map((k) => k + 1) : [...Array(n).keys()];
  const cols = tri ? [...Array(n - 1).keys()] : [...Array(n).keys()];
  const bandGap = groups ? BAND + 4 : 0;
  const colLabelH = rotate ? 56 : 18;
  const x0 = bandGap + LABEL_W; // grid top-left corner
  const y0 = tri ? 6 : colLabelH + bandGap + 6; // lower-triangle: column labels and bands at the bottom
  const gridW = cols.length * CELL, gridH = rows.length * CELL;
  const W = x0 + gridW + 4;
  const H = tri ? y0 + gridH + colLabelH + bandGap + 6 : y0 + gridH + 2;
  const X = (j: number) => x0 + cols.indexOf(j) * CELL;
  const Y = (i: number) => y0 + rows.indexOf(i) * CELL;
  const has = (i: number, j: number) => (tri ? j < i : true);

  // Entity spans [from, to) in original indices
  const spans: { g: string; from: number; to: number; color: string }[] = [];
  groups?.forEach((g, i) => {
    const last = spans[spans.length - 1];
    if (last && last.g === g) last.to = i + 1;
    else spans.push({ g, from: i, to: i + 1, color: ENTITY_COLORS[spans.length % ENTITY_COLORS.length] });
  });
  // Pixel range a span covers on an axis; parts not on that axis are clipped
  const axisSpan = (idx: number[], from: number, to: number, origin: number) => {
    const pos = idx.map((v, k) => (v >= from && v < to ? k : -1)).filter((k) => k >= 0);
    return pos.length ? { a: origin + pos[0] * CELL, len: pos.length * CELL - 2 } : null;
  };
  const colBandY = tri ? y0 + gridH + colLabelH + 4 : 0;
  const colLabelY = tri ? y0 + gridH + 14 : y0 - 8;

  return (
    <Card title={title} className={props.className}>
      <svg viewBox={`0 0 ${W} ${H}`} width={props.fill ? "100%" : W} height={props.fill ? undefined : H}
           className={props.fill ? "mx-auto block" : "block max-w-full"} style={props.fill ? { maxWidth: W * (props.maxScale ?? 1.3) } : undefined}>
        {spans.map((s) => {
          const name = dyn(s.g);
          const c = axisSpan(cols, s.from, s.to, x0);
          const r = axisSpan(rows, s.from, s.to, y0);
          return (
            <g key={s.g}>
              {c && (
                <g>
                  <rect x={c.a} y={colBandY} width={c.len} height={BAND} rx={3} fill={s.color} opacity={0.9} />
                  <text x={c.a + c.len / 2} y={colBandY + BAND / 2 + 4} fill="#fff" fontSize={11} fontWeight={600} textAnchor="middle">
                    {trunc(name, Math.max(2, Math.floor(c.len / 11)))}<title>{name}</title>
                  </text>
                </g>
              )}
              {r && (
                <g>
                  <rect x={0} y={r.a} width={BAND} height={r.len} rx={3} fill={s.color} opacity={0.9} />
                  <text x={BAND / 2} y={r.a + r.len / 2} fill="#fff" fontSize={11} fontWeight={600} textAnchor="middle"
                        dominantBaseline="central" transform={`rotate(-90 ${BAND / 2} ${r.a + r.len / 2})`}>
                    {trunc(name, Math.max(2, Math.floor(r.len / 11)))}<title>{name}</title>
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {cols.map((j) => {
          const cx = X(j) + CELL / 2;
          return rotate ? (
            <text key={`c${j}`} x={cx} y={colLabelY} fill="#6b7280" fontSize={10} textAnchor={tri ? "end" : "start"}
                  transform={`rotate(-35 ${cx} ${colLabelY})`}>
              {trunc(labels[j], 11)}<title>{props.labels[j]}</title>
            </text>
          ) : (
            <text key={`c${j}`} x={cx - 1} y={colLabelY} fill="#6b7280" fontSize={10} textAnchor="middle">
              {labels[j]}<title>{props.labels[j]}</title>
            </text>
          );
        })}
        {rows.map((i) => (
          <text key={`r${i}`} x={x0 - 8} y={Y(i) + CELL / 2 + 4} fill="#6b7280" fontSize={10} textAnchor="end">
            {trunc(labels[i], 10)}<title>{props.labels[i]}</title>
          </text>
        ))}
        {rows.map((i) =>
          cols.filter((j) => has(i, j)).map((j) => {
            const v = matrix[i][j];
            return (
              <g key={`${i}-${j}`}>
                <title>{`${props.labels[i]} ↔ ${props.labels[j]}: ${v.toFixed(3)}`}</title>
                <rect x={X(j)} y={Y(i)} width={CELL - 2} height={CELL - 2}
                      rx={4} fill={heatColor(v)} stroke="#00000010" strokeWidth={0.5} />
                <text x={X(j) + CELL / 2 - 1} y={Y(i) + CELL / 2 + 4}
                      fill={heatText(v)} fontSize={11} textAnchor="middle" className="font-mono tabular-nums">
                  {v.toFixed(2)}
                </text>
              </g>
            );
          })
        )}
        {spans.slice(1).map((s) => {
          const k = s.from; // boundary: index k-1 | k
          const xs = cols.indexOf(k) >= 0 ? X(k) - 1 : cols.indexOf(k - 1) >= 0 ? X(k - 1) + CELL - 1 : null;
          const ys = rows.indexOf(k) >= 0 ? Y(k) - 1 : null;
          // Lower-triangle: cell (k, k-1) is the topmost on both sides of the boundary
          const vTop = tri ? Y(k) - 1 : y0 - 2;
          // Lower-triangle: row k only has cells with column < k
          const hRight = tri ? X(k - 1) + CELL : x0 + gridW;
          return (
            <g key={`sep-${s.g}`} stroke="#475569" strokeWidth={1.4} strokeDasharray="5 3">
              {xs !== null && rows.indexOf(k) >= 0 && <line x1={xs} x2={xs} y1={vTop} y2={y0 + gridH} />}
              {ys !== null && <line x1={x0 - 2} x2={hRight} y1={ys} y2={ys} />}
            </g>
          );
        })}
      </svg>
      {tri && <div className="mt-1 text-[10px] text-fg-faint">{t("heatmap.lowerHint")}</div>}
      <ColorBar />
    </Card>
  );
}

// 0-to-1 colour bar, matching heatColor.
function ColorBar() {
  const stops = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="mt-2 flex items-center gap-2 text-[10px] text-fg-faint">
      <span>0</span>
      <span
        className="h-1.5 flex-1 rounded-full"
        style={{
          background: `linear-gradient(to right, ${stops.map((s) => heatColor(s)).join(",")})`,
        }}
      />
      <span>1</span>
    </div>
  );
}
