import { useEffect } from "react";
import type { Channel, StateProfile } from "../types";
import { stateColor } from "../theme";
import { Card, Note } from "./ui";
import { SeriesChart } from "./SeriesChart";
import { cn } from "../lib/cn";
import { useT, tr, dyn } from "../i18n";

// State legend: one tile per global state, showing its colour, name and a thumbnail of the
// typical signal. Clicking a tile opens the per-channel detail.

const CH_COLORS = ["#3b6fe0", "#2ca35a", "#e08a1e", "#9a52d6", "#2f9ec4"];

// Thumbnail: every channel normalised to [0,1] and overlaid, giving the state a shape signature.
function MiniProfile({ channels, w = 128, h = 30 }: { channels: StateProfile["channels"]; w?: number; h?: number }) {
  const pad = 3;
  const line = (vals: number[]) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    const n = vals.length;
    return vals
      .map((v, i) => {
        const x = pad + (i / (n - 1)) * (w - 2 * pad);
        const y = pad + (1 - (v - lo) / span) * (h - 2 * pad);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  return (
    <svg width={w} height={h} className="block rounded-[3px] bg-app-bg">
      {channels.map((c, i) => (
        <path key={c.name} d={line(c.values)} fill="none" stroke={CH_COLORS[i % CH_COLORS.length]}
          strokeWidth={1.1} opacity={0.85} />
      ))}
    </svg>
  );
}

export function StateGallery(props: { profiles: StateProfile[]; onOpen: (state: number) => void }) {
  const t = useT();
  return (
    <Card title={t("gallery.title")}>
      <Note>{tr("gallery.note")}</Note>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {props.profiles.map((p) => (
          <button
            key={p.state}
            onClick={() => props.onOpen(p.state)}
            title={t("gallery.tileTitle", { state: p.state, n: p.n_segments })}
            className="group flex cursor-pointer items-center gap-2.5 rounded-lg border border-border-soft bg-panel px-3 py-2 transition-colors hover:border-accent/40 hover:bg-app-bg"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-3.5 w-3.5 rounded-[3px]" style={{ background: stateColor(p.state) }} />
              <span className="text-xs font-medium text-fg">state {p.state}</span>
            </span>
            <MiniProfile channels={p.channels} />
            <span className="text-[11px] text-fg-faint transition-colors group-hover:text-accent">🔍</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

// Per-channel detail modal: the typical curve of one state on each selected channel.
export function StateDetailModal(props: { profile: StateProfile; onClose: () => void }) {
  const { profile, onClose } = props;
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const channels: Channel[] = profile.channels.map((c) => ({ name: dyn(c.name), values: c.values, selected: true }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-win-bg shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-border-soft px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="h-4 w-4 rounded-[4px]" style={{ background: stateColor(profile.state) }} />
            <h2 className="text-base font-semibold text-fg">{t("gallery.modalTitle", { state: profile.state })}</h2>
            <span className="font-mono text-[11px] text-fg-faint">{t("gallery.segAvg", { n: profile.n_segments })}</span>
          </div>
          <button onClick={onClose} className="text-xs text-fg-muted hover:text-fg">{t("common.close")}</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-xs leading-relaxed text-fg-muted">{t("gallery.modalNote")}</p>
          <div className={cn("rounded-lg border border-border-soft bg-panel p-3")}>
            <SeriesChart channels={channels} rowHeight={44} />
          </div>
        </div>
      </div>
    </div>
  );
}
