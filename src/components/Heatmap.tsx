import { heatColor, heatText } from "../theme";
import { Card } from "./ui";
import { useT, dyn } from "../i18n";

// Square correlation heatmap on a white-to-indigo ramp, with the value in each cell.
export function Heatmap(props: { matrix: number[][]; labels: string[]; title: string }) {
  useT(); // redraw labels when the language changes
  const { matrix, title } = props;
  const labels = props.labels.map(dyn);
  const n = labels.length;
  const cell = 50;
  const padL = 70; // row labels
  const padT = 60; // angled column labels
  const W = padL + n * cell;
  const H = padT + n * cell;
  const trunc = (s: string, k: number) => (s.length > k ? s.slice(0, k - 1) + "…" : s);
  return (
    <Card title={title}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full">
        {/* Column labels at -35 degrees, so long service names do not overlap */}
        {labels.map((l, j) => {
          const cx = padL + j * cell + cell / 2;
          return (
            <text key={`c${j}`} x={cx} y={padT - 8} fill="#6b7280" fontSize={10} textAnchor="start"
                  transform={`rotate(-35 ${cx} ${padT - 8})`}>
              {trunc(l, 11)}<title>{l}</title>
            </text>
          );
        })}
        {labels.map((l, i) => (
          <text key={`r${i}`} x={padL - 8} y={padT + i * cell + cell / 2 + 4}
                fill="#6b7280" fontSize={10} textAnchor="end">
            {trunc(l, 10)}<title>{l}</title>
          </text>
        ))}
        {matrix.map((row, i) =>
          row.map((v, j) => (
            <g key={`${i}-${j}`}>
              <rect x={padL + j * cell} y={padT + i * cell} width={cell - 2} height={cell - 2}
                    rx={4} fill={heatColor(v)} stroke="#00000010" strokeWidth={0.5} />
              <text x={padL + j * cell + cell / 2 - 1} y={padT + i * cell + cell / 2 + 4}
                    fill={heatText(v)} fontSize={11} textAnchor="middle"
                    className="font-mono tabular-nums">
                {v.toFixed(2)}
              </text>
            </g>
          ))
        )}
      </svg>
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
