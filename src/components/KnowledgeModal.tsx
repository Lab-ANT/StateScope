import { useEffect, type ReactNode } from "react";
import type { KnowledgeReport, Insight, Snapshot } from "../lib/knowledge";
import type { Stage } from "../types";
import { cn } from "../lib/cn";
import { StateRibbon } from "./StateRibbon";
import { Heatmap } from "./Heatmap";
import { Sparkline } from "./Sparkline";
import { PaperMatrix } from "./statecausal/PaperMatrix";
import type { SCSeries } from "./statecausal/model";
import { stateEdges } from "../lib/stateCausal";
import { useT, dyn } from "../i18n";


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
      <span className="w-28 shrink-0 truncate text-[11px] text-fg-muted" title={dyn(name)}>{dyn(name)}</span>
      <div className="flex-1"><StateRibbon segments={segments} T={T} height={16} /></div>
    </div>
  );
}

function StageFigure({ stage, snap }: { stage: Stage; snap: Snapshot }) {
  const t = useT();
  const T = snap.meta?.T ?? 0;

  if (stage === "detect") {
    const det = snap.detected ?? [];
    if (!det.length || !T) return null;
    return (
      <FigureBox label={t("knowledge.figDetectMetric")}>
        <div className="flex flex-col gap-1.5">
          {det.map((d) => <RibbonRow key={d.name} name={d.name} segments={d.segments} T={T} />)}
        </div>
      </FigureBox>
    );
  }

  if (stage === "correlate") {
    const c = snap.correlations?.overall;
    if (!c?.matrix || !c.labels) return null;
    return (
      <FigureBox label={t("knowledge.figCorrelate")}>
        <div className="overflow-x-auto pb-1">
          <Heatmap title={t("knowledge.heatOverall")} matrix={c.matrix} labels={c.labels}
            groups={c.labels.map((l) => snap.detected?.find((d) => d.name === l)?.entity)} />
        </div>
      </FigureBox>
    );
  }

  if (stage === "causality" && snap.causality) {
    const sc = snap.causality;
    const edges = stateEdges(sc).filter((e) => e.gain >= 5);
    if (!edges.length) return null;
    // The matrix only needs series order, so stub series from event order
    const seen = new Map<string, SCSeries>();
    for (const e of [...sc.events, ...sc.dropped])
      if (!seen.has(e.series)) seen.set(e.series, { name: e.series, entity: e.entity, metric: e.metric, T: 0, x: [], values: [], segments: [] });
    return (
      <FigureBox label={t("knowledge.figStateCausality")}>
        <div className="max-w-[560px]">
          <PaperMatrix series={[...seen.values()]} edges={edges} selected={new Set()} />
        </div>
      </FigureBox>
    );
  }

  if (stage === "select") {
    const sel = snap.selection;
    if (sel && snap.series?.length) {
      // One column per entity; selected metrics drawn as waveforms, unselected only counted
      const ents = snap.series.filter((x) => (sel.picks[x.name] ?? []).length);
      return (
        <FigureBox label={t("knowledge.figSelectMetric")}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ents.map((x) => {
              const picked = x.channels.filter((c) => sel.picks[x.name].includes(c.name));
              return (
                <div key={x.name} className="min-w-0">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                    <span className="font-medium text-fg">{dyn(x.name)}</span>
                    <span className="text-fg-faint">· {t("knowledge.pickedOf", { k: picked.length, n: x.channels.length })}</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {picked.map((c) => (
                      <div key={c.name} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 truncate text-[10px] text-fg" title={dyn(c.name)}>{dyn(c.name)}</span>
                        <div className="min-w-0 flex-1"><Sparkline values={c.values} color="#2ca35a" fluid /></div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </FigureBox>
      );
    }
    return null;
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
