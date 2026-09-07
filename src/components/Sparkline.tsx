// Self-normalised sparkline of one channel, used for the kept-vs-dropped comparison.
export function Sparkline(props: { values: number[]; color: string; width?: number; height?: number }) {
  const { values, color } = props;
  const W = props.width ?? 150;
  const H = props.height ?? 32;
  const n = values.length;
  if (n === 0) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const pad = 3;
  const d = values
    .map((v, i) => {
      const x = (i / (n - 1)) * W;
      const y = pad + (1 - (v - lo) / span) * (H - 2 * pad);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
      <path d={d} fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  );
}
