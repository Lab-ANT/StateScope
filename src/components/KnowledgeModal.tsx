import { useEffect, type ReactNode } from "react";
import type { KnowledgeReport, Insight, Snapshot } from "../lib/knowledge";
import type { Stage, Detected } from "../types";
import { cn } from "../lib/cn";
import { StateRibbon, StateLegend } from "./StateRibbon";
import { Heatmap } from "./Heatmap";
import { ClusterCausalGraph } from "./ClusterCausalGraph";
import { Sparkline } from "./Sparkline";
import { stateColor } from "../theme";
import { useT, dyn, type Key } from "../i18n";

// Global knowledge modal: what each stage discovered, as text plus one key figure, closing
// with a cross-stage synthesis. The figures are marked update or append:
//   - detection/alignment: state ribbons (update, always the current segmentation);
//   - correlation: one heatmap per kind (append);
//   - causality: one composite-node graph per regime (append).

function toneDot(tone?: Insight["tone"]) {
  return tone === "highlight" ? "bg-accent" : tone === "pattern" ? "bg-sig-done" : "bg-fg-faint/45";
}

function InsightLine({ ins }: { ins: Insight }) {
  return (
    <li className="flex items-start gap-2">
      <span className={cn("mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full", toneDot(ins.tone))} />
      <span className={cn("text-[13px] leading-relaxed", ins.tone === "pattern" ? "text-fg" : "text-fg-muted")}>
        {ins.text}
      </span>
    </li>
  );
}

// One figure block: a small caption plus the figure itself.
function FigureBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2.5 rounded-md border border-border-soft bg-app-bg/60 p-2.5">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-faint">{label}</div>
      {children}
    </div>
  );
}

function RibbonRow({ name, segments, T }: { name: string; segments: { start: number; end: number; state: number }[]; T: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-[11px] text-fg-muted" title={dyn(name)}>{dyn(name)}</span>
      <div className="flex-1"><StateRibbon segments={segments} T={T} height={16} /></div>
    </div>
  );
}

const HEAT_KEY: Record<string, Key> = {
  overall: "knowledge.heatOverall",
  transition: "knowledge.heatTransition",
  time_lagged: "knowledge.heatTimeLagged",
};

// The key figure for a stage; returns null where text alone is enough.
function StageFigure({ stage, snap }: { stage: Stage; snap: Snapshot }) {
  const t = useT();
  const T = snap.meta?.T ?? 0;

  if (stage === "detect") {
    const det: Detected[] = Array.isArray(snap.detected) ? snap.detected : snap.detected ? [snap.detected] : [];
    if (!det.length || !T) return null;
    return (
      <FigureBox label={t("knowledge.figDetect")}>
        <div className="flex flex-col gap-1.5">
          {det.map((d) => <RibbonRow key={d.name} name={d.name} segments={d.segments} T={T} />)}
        </div>
      </FigureBox>
    );
  }

  if (stage === "align") {
    const al = snap.aligned;
    if (!al || !T) return null;
    return (
      <FigureBox label={t("knowledge.figAlign")}>
        <StateLegend states={al.global_states} />
        <div className="flex flex-col gap-1.5">
          {al.sequences.map((s) => <RibbonRow key={s.name} name={s.name} segments={s.segments} T={T} />)}
        </div>
      </FigureBox>
    );
  }

  if (stage === "correlate") {
    const cs = snap.correlations;
    if (!cs) return null;
    const mats = ["overall", "transition", "time_lagged"]
      .map((k) => cs[k])
      .filter((c): c is NonNullable<typeof c> => !!c?.matrix && !!c.labels);
    if (!mats.length) return null;
    return (
      <FigureBox label={t("knowledge.figCorrelate")}>
        <div className="flex gap-4 overflow-x-auto pb-1">
          {mats.map((c) => (
            <div key={c.kind} className="shrink-0">
              <Heatmap title={HEAT_KEY[c.kind] ? t(HEAT_KEY[c.kind]) : c.kind} matrix={c.matrix!} labels={c.labels!} />
            </div>
          ))}
        </div>
      </FigureBox>
    );
  }

  if (stage === "causality") {
    const cc = snap.causality;
    if (!cc) return null;
    // Only regimes with cross-channel edges, largest first, scrollable side by side.
    const regimes = [...cc.graphs]
      .filter((g) => g.edges.some((e) => e.src !== e.dst))
      .sort((a, b) => b.n_samples - a.n_samples);
    if (!regimes.length) return null;
    return (
      <FigureBox label={t("knowledge.figCausality")}>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {regimes.map((g) => {
            const cross = g.edges.filter((e) => e.src !== e.dst).length;
            return (
              <div key={g.state} className="shrink-0 rounded-md border border-border-soft bg-panel p-2">
                <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-fg">
                  <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: stateColor(g.state) }} />
                  regime {g.state}
                  <span className="font-normal text-fg-faint">
                    {t("knowledge.regimeInfo", { n: g.n_samples, edges: cross })}
                  </span>
                </div>
                <ClusterCausalGraph
                  varNames={cc.var_names} podOf={cc.pod_of} kindOf={cc.kind_of} pods={cc.pods}
                  edges={g.edges} threshold={0.15} nodeR={13} chSpread={2.2} bow={0.14}
                  maxWidth={320} stride={cc.meta?.stride ?? 1} />
              </div>
            );
          })}
        </div>
      </FigureBox>
    );
  }

  if (stage === "select") {
    const sel = snap.selection;
    const s0 = Array.isArray(snap.series) ? snap.series[0] : undefined;
    if (!sel || !s0) return null;
    const kept = s0.channels.filter((c) => c.selected);
    const dropped = s0.channels.filter((c) => !c.selected);
    const Col = ({ title, items, keep }: { title: string; items: typeof kept; keep: boolean }) => (
      <div className="min-w-[200px] flex-1">
        <div className="mb-1 flex items-center gap-1.5 text-[11px]">
          <span className={cn("h-2 w-2 rounded-full", keep ? "bg-sig-done" : "bg-fg-faint/40")} />
          <span className="font-medium text-fg">{title}</span><span className="text-fg-faint">· {items.length}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {items.slice(0, 6).map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className={cn("w-16 shrink-0 truncate text-[10px]", keep ? "text-fg" : "text-fg-faint")} title={dyn(c.name)}>{dyn(c.name)}</span>
              <div className="flex-1"><Sparkline values={c.values} color={keep ? "#2ca35a" : "#b8bdc6"} /></div>
            </div>
          ))}
        </div>
      </div>
    );
    return (
      <FigureBox label={t("knowledge.figSelect")}>
        <div className="flex flex-wrap gap-4">
          <Col title={t("select.keptShort")} items={kept} keep />
          <Col title={t("select.droppedShort")} items={dropped} keep={false} />
        </div>
      </FigureBox>
    );
  }

  return null;
}

export function KnowledgeModal(props: { report: KnowledgeReport; snap: Snapshot; onClose: () => void }) {
  const t = useT();
  const { report, snap, onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { done, total } = report.progress;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border border-border bg-win-bg shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border-soft px-6 py-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-faint">KNOWLEDGE</div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold text-fg">
              <span>{t("knowledge.title")}</span>
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">{t("knowledge.subtitle")}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="rounded-sm bg-app-bg px-2.5 py-1 font-mono text-xs text-fg-muted">
              {t("knowledge.progress", { done, total })}
            </span>
            <button onClick={onClose} className="text-xs text-fg-muted hover:text-fg">{t("common.close")}</button>
          </div>
        </div>

        {/* Segmented progress bar */}
        <div className="flex gap-1 px-6 pt-3">
          {report.sections.map((s) => (
            <div key={s.stage} className="flex-1" title={s.label}>
              <div className={cn("h-1.5 rounded-full", s.done ? "bg-sig-done" : "bg-fg/25")} />
              <div className={cn("mt-1 truncate text-center text-[10px]", s.done ? "text-fg-muted" : "text-fg-faint")}>
                {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* Body: per-stage knowledge, then the synthesis */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-3">
            {report.sections.map((s, i) => (
              <div
                key={s.stage}
                className={cn(
                  "rounded-lg border px-4 py-3",
                  s.done ? "border-border-soft bg-panel" : "border-dashed border-border bg-transparent opacity-60",
                )}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-fg-faint">{i + 1}</span>
                  <span className="text-sm font-medium text-fg">{s.label}</span>
                  {!s.done && <span className="text-[11px] text-fg-faint">{t("knowledge.pending")}</span>}
                </div>
                {s.done ? (
                  <>
                    {s.insights.length ? (
                      <ul className="flex flex-col gap-1.5">
                        {s.insights.map((ins, k) => <InsightLine key={k} ins={ins} />)}
                      </ul>
                    ) : (
                      <p className="text-xs text-fg-faint">{t("knowledge.emptyStage")}</p>
                    )}
                    <StageFigure stage={s.stage} snap={snap} />
                  </>
                ) : (
                  <p className="text-xs text-fg-faint">{t("knowledge.notRun")}</p>
                )}
              </div>
            ))}
          </div>

          {/* Synthesis */}
          <div className="mt-5 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-fg">{t("knowledge.synthesis")}</span>
              <span className="text-[11px] text-fg-muted">{t("knowledge.synthesisHint")}</span>
            </div>
            <ul className="flex flex-col gap-2">
              {report.synthesis.map((ins, k) => (
                <li key={k} className="flex items-start gap-2">
                  <span className={cn("mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full", toneDot(ins.tone))} />
                  <span className={cn("text-[13px] leading-relaxed", ins.tone === "highlight" ? "font-medium text-fg" : "text-fg-muted")}>
                    {ins.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
