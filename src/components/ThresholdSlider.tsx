import { useT } from "../i18n";

// Generic threshold slider; links below the threshold are hidden.
export function ThresholdSlider(props: {
  value: number;
  onChange: (v: number) => void;
  label?: string;
  max?: number;
}) {
  const t = useT();
  const max = props.max ?? 1;
  return (
    <label className="inline-flex items-center gap-2 text-xs text-fg-muted">
      <span className="whitespace-nowrap">
        {props.label ?? t("viz.hideWeak")} ≥{" "}
        <span className="font-mono tabular-nums text-fg">{props.value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={0.05}
        value={props.value}
        onChange={(e) => props.onChange(+e.target.value)}
        className="h-1 w-40 cursor-pointer accent-accent"
      />
    </label>
  );
}
