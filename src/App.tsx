import { useEffect, useState } from "react";
import { api, type DataParams, type DetectParams } from "./api";
import type {
  CausalityResult, Correlation, DatasetInfo, Detected, Meta, Segment, SeriesData, Selection, Stage,
} from "./types";
import { StateCausalView } from "./components/statecausal/StateCausalView";
import { ENTITY_COLORS, paperStateColor, type SCSeries } from "./components/statecausal/model";
import { stateEdges } from "./lib/stateCausal";
import { MacWindow } from "./components/mac/MacWindow";
import { Sidebar, type StageNavItem } from "./components/Sidebar";
import { StagePanel, Field, Card, Note, SegToggle, Btn, type StepStatus } from "./components/ui";
import { cn } from "./lib/cn";
import { SeriesChart } from "./components/SeriesChart";
import { Sparkline } from "./components/Sparkline";
import { StateRibbon } from "./components/StateRibbon";
import { Heatmap } from "./components/Heatmap";
import { KnowledgeModal } from "./components/KnowledgeModal";
import { CalibrationModal } from "./components/CalibrationModal";
import { buildKnowledge } from "./lib/knowledge";
import {
  useT, tr, dyn, dynError, datasetLabel, datasetBackground, datasetSource, type Key,
} from "./i18n";

const ORDER: Stage[] = ["data", "select", "detect", "correlate", "causality"];
const LABEL_KEY: Record<Stage, Key> = {
  data: "stage.data", select: "stage.select", detect: "stage.detect",
  correlate: "stage.correlate", causality: "stage.causality",
};
const PREREQ: Record<Stage, Stage | null> = {
  data: null, select: "data", detect: "select", correlate: "detect", causality: "detect",
};
const MAX_POINTS = 1000; // must match the backend downsampling cap

type DatasetDefaults = { selP?: { selector: string; K: number }; minLift?: number; minGain?: number };
const DATASET_DEFAULTS: Record<string, DatasetDefaults> = {
  petshop: { selP: { selector: "unlabeled", K: 4 }, minLift: 1.5 },
  lemma_rca: { selP: { selector: "unlabeled", K: 4 }, minLift: 2.0, minGain: 1 }, // weak relations
  wadi: { selP: { selector: "unlabeled", K: 3 }, minLift: 1.2 },
};
const BASE_DETECT: DetectParams = { win_size: 100, step: 50, nb_steps: 60, n_states: 0, min_seg_len: 0 };

// The form shows "auto" (null n_states) as 0
function detectParams(base: DetectParams, d: Meta["metric_detect_defaults"] | null | undefined): DetectParams {
  return d ? { ...base, ...d, n_states: d.n_states ?? 0, min_seg_len: d.min_seg_len ?? 0 } : base;
}

export function App() {
  const t = useT();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [series, setSeries] = useState<SeriesData[] | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [correlations, setCorrelations] = useState<Record<string, Correlation> | null>(null);
  const [causality, setCausality] = useState<CausalityResult | null>(null);

  const [active, setActive] = useState<Stage>(() => {
    const s = new URLSearchParams(window.location.search).get("stage") as Stage | null;
    return s && ORDER.includes(s) ? s : "data";
  });
  const [everRun, setEverRun] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [detectProgress, setDetectProgress] = useState<{ done: number; total: number } | null>(null);
  const [detectPlan, setDetectPlan] = useState<{ entity: string; metric: string }[] | null>(null);
  const [pickDraft, setPickDraft] = useState<Record<string, string[]> | null>(null);
  const [minGain, setMinGain] = useState(5);
  const [onlyCorroborated, setOnlyCorroborated] = useState(false);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [sourceMode, setSourceMode] = useState<"synthetic" | "public">("public");
  // WADI by default; bootSession falls back to PetShop if it is not available locally
  const [dataP, setDataP] = useState<DataParams>({ dataset: "wadi", n_series: 3, lag: 150, seg_len: 400, n_useful: 3, n_noise: 5, seed: 1 });
  const [selP, setSelP] = useState({ selector: "unlabeled", K: 3 });
  const [detP, setDetP] = useState<DetectParams>(BASE_DETECT);
  const [minLift, setMinLift] = useState(1.2);
  const [minOcc, setMinOcc] = useState(3);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [calibOpen, setCalibOpen] = useState(false);

  const completed: Stage[] = meta?.completed ?? [];
  const sid = meta?.session_id;
  const isDone = (s: Stage) => completed.includes(s);
  const prereqDone = (s: Stage) => PREREQ[s] === null || completed.includes(PREREQ[s]!);

  function statusOf(s: Stage): StepStatus {
    if (busy === s) return "running";
    if (isDone(s)) return "done";
    const ready = prereqDone(s);
    if (everRun.has(s)) return ready ? "stale" : "locked";
    return ready ? "ready" : "locked";
  }

  async function guard(stage: Stage, fn: () => Promise<void>) {
    setBusy(stage); setError(null);
    try {
      await fn();
      setEverRun((s) => new Set(s).add(stage));
    } catch (e) {
      setError(dynError(e));
    } finally {
      setBusy(null);
    }
  }

  async function loadSession(override?: Partial<DataParams>) {
    const r = await api.createSession({ ...dataP, ...(override ?? {}) });
    setDataP((p) => ({ ...p, dataset: r.meta.dataset ?? p.dataset }));
    setMeta(r.meta); setSeries(r.series);
    setSelection(null); setDetected(null); setCorrelations(null); setCausality(null);
    setPickDraft(null);
    setEverRun(new Set());
    setActive("data");
    applyDatasetDefaults(r.meta);
  }
  const createSession = (override?: Partial<DataParams>) => guard("data", () => loadSession(override));
  // WADI requires a signed agreement and is not shipped, so fall back to PetShop if it is missing
  const bootSession = () =>
    guard("data", async () => {
      try {
        await loadSession({ dataset: "wadi" });
      } catch {
        await loadSession({ dataset: "petshop" });
      }
    });

  // Fully reset every stage so no values leak from the previous dataset
  function applyDatasetDefaults(m: Meta) {
    const d = DATASET_DEFAULTS[m.dataset ?? ""] ?? {};
    setDetP(detectParams(BASE_DETECT, m.metric_detect_defaults));
    setMinLift(d.minLift ?? 1.2);
    setMinOcc(3);
    setMinGain(d.minGain ?? 5);
    setSelP(d.selP ?? (m.has_ground_truth !== false ? { selector: "issd", K: 3 } : { selector: "unlabeled", K: 4 }));
  }

  const pickDataset = (id: string) => {
    setDataP((p) => ({ ...p, dataset: id }));
    createSession({ dataset: id });
  };

  const runSelect = () =>
    guard("select", async () => {
      const r = await api.select(sid!, selP);
      setMeta(r.meta); setSelection(r.selection); setSeries(r.series); setPickDraft(null);
    });
  const selectPicks = (picks: Record<string, string[]>) =>
    guard("select", async () => {
      const r = await api.select(sid!, { ...selP, picks });
      setMeta(r.meta); setSelection(r.selection); setSeries(r.series); setPickDraft(null);
    });
  async function detectWith(dp: DetectParams) {
    setDetected([]); setDetectPlan(null); setDetectProgress({ done: 0, total: 0 });
    try {
      const r = await api.detectStream(sid!, dp, (m) => {
        if (m.type === "plan") {
          setDetectPlan(m.items); setDetectProgress({ done: 0, total: m.items.length });
          return;
        }
        setDetected((prev) => [...(prev ?? []), m.detected]);
        setDetectProgress({ done: m.done, total: m.total });
      });
      setMeta(r.meta); setDetected(r.detected);
    } finally {
      setDetectProgress(null); setDetectPlan(null);
    }
  }
  const runDetect = () => guard("detect", () => detectWith(detP));
  const applyCalibration = (edits: { name: string; segments: Segment[] }[]) =>
    guard("detect", async () => {
      const r = await api.calibrate(sid!, { series: edits });
      setMeta(r.meta); setDetected(r.detected); setCorrelations(null); setCausality(null);
      setCalibOpen(false);
    });
  const runCorrelate = () =>
    guard("correlate", async () => {
      const r = await api.correlate(sid!, { min_lift: minLift });
      setMeta(r.meta); setCorrelations(r.correlations);
    });
  const runCausality = () =>
    guard("causality", async () => {
      const r = await api.causality(sid!, { min_occ: minOcc });
      setMeta(r.meta); setCausality(r.causality);
    });

  async function runAll() {
    if (!sid) return;
    setError(null);
    try {
      setBusy("select"); setActive("select");
      const r = await api.select(sid, selP);
      setMeta(r.meta); setSelection(r.selection); setSeries(r.series); setPickDraft(null);
      setBusy("detect"); setActive("detect");
      await detectWith(detP);
      setBusy("correlate"); setActive("correlate"); const c = await api.correlate(sid, { min_lift: minLift }); setMeta(c.meta); setCorrelations(c.correlations);
      setBusy("causality"); setActive("causality"); const g = await api.causality(sid, { min_occ: minOcc }); setMeta(g.meta); setCausality(g.causality);
      setEverRun(new Set(ORDER));
    } catch (e) {
      setError(dynError(e));
    } finally {
      setBusy(null);
    }
  }

  async function attachSession(id: string) {
    setBusy("data"); setError(null);
    try {
      const s = await api.getSession(id);
      setMeta(s.meta); setSeries(s.series);
      setSelection(s.selection ?? null); setDetected(s.detected ?? null);
      setCorrelations(s.correlations ?? null); setCausality(s.causality ?? null);
      setEverRun(new Set(s.meta.completed));
      applyDatasetDefaults(s.meta);
    } catch (e) {
      setError(t("data.loadSessionFailed", { id, err: dynError(e) }));
      await loadSession({ dataset: "wadi" }).catch(() => loadSession({ dataset: "petshop" }));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    api.datasets().then((r) => setDatasets(r.datasets)).catch(() => {});
    const existing = new URLSearchParams(window.location.search).get("session");
    if (existing) attachSession(existing);
    else bootSession();
  }, []);

  // Sync the "synthetic / public" toggle with the loaded dataset (also when attaching a session)
  useEffect(() => {
    const g = datasets.find((d) => d.id === meta?.dataset)?.group;
    if (g === "synthetic" || g === "public") setSourceMode(g);
  }, [meta?.dataset, datasets]);

  const T = meta?.T ?? 1;
  const scSeries: SCSeries[] = (detected ?? []).map((d) => {
    const values = series?.find((x) => x.name === d.entity)?.channels.find((c) => c.name === d.metric)?.values ?? [];
    const stride = T > MAX_POINTS ? Math.ceil(T / MAX_POINTS) : 1;
    return {
      name: d.name, entity: d.entity, metric: d.metric, T,
      x: values.map((_, i) => Math.min(T - 1, i * stride)), values,
      segments: d.segments.map((g) => [g.start, g.end, g.state] as [number, number, number]),
    };
  });
  const entityOfSeries = (name: string): string | undefined => detected?.find((d) => d.name === name)?.entity;
  // The workbench looks raw curves up by series name, so give each "entity.metric" its own channel
  const calibSeries: SeriesData[] | null = detected && series
    ? detected.map((d) => ({ name: d.name, channels: (series.find((x) => x.name === d.entity)?.channels ?? []).filter((c) => c.name === d.metric) }))
    : null;
  const hasTruth = meta?.has_ground_truth !== false;
  const curDataset = datasets.find((d) => d.id === (meta?.dataset ?? dataP.dataset));

  const navItems: StageNavItem[] = ORDER.map((s) => ({ stage: s, label: t(LABEL_KEY[s]), status: statusOf(s) }));
  const activeIdx = ORDER.indexOf(active);
  const nextStage = activeIdx >= 0 && activeIdx < ORDER.length - 1 ? ORDER[activeIdx + 1] : null;
  const nextProps = nextStage ? { onNext: () => setActive(nextStage), nextLabel: t(LABEL_KEY[nextStage]) } : {};

  return (
    <MacWindow>
      <div className="flex h-full min-h-0">
        <Sidebar
          items={navItems}
          active={active}
          onSelect={setActive}
          sessionId={sid}
          busy={!!busy}
          onNewSession={() => createSession()}
          onRunAll={runAll}
          canRunAll={!!sid}
          onOpenKnowledge={() => setKnowledgeOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-win-bg">
          <div className="h-10 shrink-0" />
          {error && (
            <div className="mx-7 mb-2 rounded-md border border-sig-bad/30 bg-sig-bad/[0.06] px-3 py-2 text-xs text-sig-bad">
              ⚠ {error}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12 pt-1">
            {renderStage()}
          </div>
        </main>
      </div>
      {calibOpen && detected && calibSeries && (
        <CalibrationModal
          detected={detected}
          series={calibSeries}
          busy={busy === "detect"}
          onApply={applyCalibration}
          onClose={() => setCalibOpen(false)}
        />
      )}
      {knowledgeOpen && (() => {
        const snap = { meta, series, selection, detected, correlations, causality };
        return (
          <KnowledgeModal
            report={buildKnowledge(snap)}
            snap={snap}
            onClose={() => setKnowledgeOpen(false)}
          />
        );
      })()}
    </MacWindow>
  );

  function renderStage() {
    switch (active) {
      case "data":
        return (
          <StagePanel
            title={t("stage.data")} tag="STAGE · DATA" status={statusOf("data")} {...nextProps}
            desc={tr("data.desc")}
            runLabel={t("data.runLabel")} onRun={() => createSession()}
            controls={
              <div className="flex w-full flex-col gap-3">
                <SegToggle value={sourceMode} onChange={setSourceMode}
                  options={[{ value: "public", label: t("data.public") }, { value: "synthetic", label: t("data.synthetic") }]} />
                <div className="flex flex-wrap gap-2">
                  {datasets
                    .filter((d) => d.group === sourceMode && d.available)
                    .map((d) => {
                    const activeD = (meta?.dataset ?? dataP.dataset) === d.id;
                    return (
                      <button key={d.id} disabled={!!busy}
                        onClick={() => pickDataset(d.id)}
                        title={datasetSource(d.id, d.source)}
                        className={cn(
                          "max-w-[280px] rounded-md border px-3 py-2 text-left transition-colors",
                          activeD ? "border-accent bg-accent-soft" : "border-border bg-panel hover:bg-app-bg",
                        )}>
                        <div className="text-xs font-medium text-fg">{datasetLabel(d.id, d.label)}</div>
                        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-faint">
                          {datasetBackground(d.id, d.background)}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {curDataset?.tunable && (
                  <div className="flex flex-wrap gap-3 border-t border-border-soft pt-3">
                    <Field label={t("data.fieldNSeries")} type="number" min={2} max={5} value={dataP.n_series} onChange={(v) => setDataP({ ...dataP, n_series: +v })} />
                    <Field label={t("data.fieldLag")} type="number" min={0} max={400} step={10} value={dataP.lag} onChange={(v) => setDataP({ ...dataP, lag: +v })} />
                    <Field label={t("data.fieldSegLen")} type="number" min={100} max={800} step={50} value={dataP.seg_len} onChange={(v) => setDataP({ ...dataP, seg_len: +v })} />
                    <Field label={t("data.fieldUseful")} type="number" min={1} max={4} value={dataP.n_useful} onChange={(v) => setDataP({ ...dataP, n_useful: +v })} />
                    <Field label={t("data.fieldNoise")} type="number" min={0} max={8} value={dataP.n_noise} onChange={(v) => setDataP({ ...dataP, n_noise: +v })} />
                    <Field label={t("common.seed")} type="number" value={dataP.seed} onChange={(v) => setDataP({ ...dataP, seed: +v })} />
                  </div>
                )}
              </div>
            }>
            {series && meta && (
              <div className="flex flex-col gap-4">
                {meta.stats && <DataStats meta={meta} />}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
                  {series.map((s) => (
                    <Card key={s.name} title={`${dyn(s.name)}${selection ? t("data.selectedHint") : ""}`}>
                      <SeriesChart channels={s.channels} />
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </StagePanel>
        );

      case "select":
        return (
          <StagePanel
            title={t("stage.select")} tag="STAGE 2" status={statusOf("select")} {...nextProps}
            desc={tr("select.descMetricPreview")}
            runLabel={t("select.runPerEntity")} onRun={runSelect}
            controls={
              <>
                <Field label={t("select.method")} type="select" value={selP.selector} onChange={(v) => setSelP({ ...selP, selector: v })}
                  options={hasTruth
                    ? [{ value: "issd", label: t("select.issd") }, { value: "weak", label: t("select.weak") }, { value: "unlabeled", label: t("select.unlabeled") }]
                    : [{ value: "unlabeled", label: t("select.unlabeled") }]} />
                <Field label="K" type="number" min={1} max={8} value={selP.K} onChange={(v) => setSelP({ ...selP, K: +v })} />
                {!hasTruth && <span className="self-end pb-1.5 text-[11px] text-fg-faint">{t("select.noTruthHint")}</span>}
              </>
            }>
            {series && (
              <EntitySelection series={series} selection={selection}
                draft={pickDraft} setDraft={setPickDraft} busy={!!busy} k={selP.K} onApply={selectPicks} />
            )}
          </StagePanel>
        );

      case "detect":
        return (
          <StagePanel
            title={t("stage.detect")} tag="STAGE 3" status={statusOf("detect")} {...nextProps}
            desc={tr("detect.descMetric")}
            runLabel={t("detect.runLabel")} onRun={runDetect} live
            actions={detected && (
              <Btn variant="outline" className="h-8 px-3 text-xs" onClick={() => setCalibOpen(true)}>
                {t("detect.calibrate")}
              </Btn>
            )}
            controls={
              <>
                <Field label={t("detect.fieldWin")} type="number" min={20} max={300} step={10} value={detP.win_size} onChange={(v) => setDetP({ ...detP, win_size: +v })} />
                <Field label={t("detect.fieldStep")} type="number" min={5} max={100} step={5} value={detP.step} onChange={(v) => setDetP({ ...detP, step: +v })} />
                <Field label={t("detect.fieldNbSteps")} type="number" min={5} max={120} step={5} value={detP.nb_steps} onChange={(v) => setDetP({ ...detP, nb_steps: +v })} />
                <Field label={t("detect.fieldNStatesAuto")} type="number" min={0} max={12}
                  value={detP.n_states} onChange={(v) => setDetP({ ...detP, n_states: +v })} />
                <Field label={t("detect.fieldMinSeg")} type="number" min={0} max={500} step={10} value={detP.min_seg_len} onChange={(v) => setDetP({ ...detP, min_seg_len: +v })} />
              </>
            }>
            {detectProgress && (
              <Note className="mb-3">{t("detect.progress", { done: detectProgress.done, total: detectProgress.total || "?" })}</Note>
            )}
            {detected && (detectPlan || detected.length > 0) && (
              <MetricDetectedView detected={detected} T={T} plan={detectPlan} series={series} />
            )}
          </StagePanel>
        );

      case "correlate":
        return (
          <StagePanel
            title={t("stage.correlate")} tag="STAGE 4" status={statusOf("correlate")} {...nextProps}
            desc={tr("correlate.descPaper")}
            runLabel={t("correlate.runLabel")} onRun={runCorrelate}
            controls={
              <Field label={t("correlate.fieldMinLift")} type="number" min={1} max={5} step={0.1} value={minLift} onChange={(v) => setMinLift(+v)} />
            }>
            {correlations && (() => {
              // Side by side only for <= 10 metrics, so heatmap cells don't get too small
              const overall = correlations.overall;
              const half = (overall?.labels?.length ?? 0) <= 10;
              return (
                <div className={cn("grid grid-cols-1 gap-4", half && "xl:grid-cols-2")}>
                  {overall?.matrix && (
                    <Heatmap title={t("correlate.heatOverall")} matrix={overall.matrix} labels={overall.labels!}
                      groups={overall.labels!.map(entityOfSeries)} fill maxScale={half ? 1.3 : 1} className="h-full min-w-0" />
                  )}
                  {correlations.partial && (
                    <Card title={t("correlate.partialTitle")} className="h-full min-w-0">
                      {correlations.partial.pairs.length === 0 && <Note>{t("correlate.partialEmpty")}</Note>}
                      <div className="overflow-x-auto">
                        <DataTable head={[t("correlate.colFrom"), t("correlate.colTo"), t("correlate.colScope"), "Jaccard", "lift"]}
                          rows={correlations.partial.pairs.slice(0, half ? 12 : 10).map((p: any) => {
                            const a = parseStateRef(p.from, entityOfSeries), b = parseStateRef(p.to, entityOfSeries);
                            const scope = a.entity && b.entity
                              ? <span className={cn("whitespace-nowrap text-[11px]", a.entity === b.entity ? "text-fg-faint" : "font-medium text-accent")}>
                                  {t(a.entity === b.entity ? "correlate.sameEntity" : "correlate.crossEntity")}
                                </span>
                              : "—";
                            return [<StateRef r={a} />, <StateRef r={b} />, scope, mono(p.jaccard ?? p.score), mono(p.lift)];
                          })} />
                      </div>
                    </Card>
                  )}
                </div>
              );
            })()}
          </StagePanel>
        );

      case "causality":
        return (
          <StagePanel
            title={t("causality.title")} tag="STAGE 5" status={statusOf("causality")} {...nextProps}
            desc={tr("causality.desc")}
            runLabel={t("causality.runLabel")} onRun={runCausality}
            actions={causality && (
              <Btn variant="primary" className="h-8 px-3 text-xs" onClick={() => setKnowledgeOpen(true)}>
                {t("causality.knowledgeBtn")}
              </Btn>
            )}
            controls={
              <>
                <Field label={t("causality.minOcc")} type="number" min={1} max={50} value={minOcc} onChange={(v) => setMinOcc(Math.max(1, +v))} />
                <Field label={t("causality.minGain")} type="number" min={0} step={1} value={minGain} onChange={(v) => setMinGain(Math.max(0, +v))} />
                {causality?.found.some((m) => m.params.corroborated !== undefined) && (
                  <label className="flex h-8 items-center gap-1.5 self-end text-xs text-fg-muted" title={t("scf.corroboratedTip")}>
                    <input type="checkbox" className="accent-accent" checked={onlyCorroborated} onChange={(e) => setOnlyCorroborated(e.target.checked)} />
                    {t("causality.onlyCorroborated")}
                  </label>
                )}
              </>
            }>
            {causality && (
              <div className="flex flex-col gap-3">
                <Note>{tr("causality.stateSummary", {
                  algo: causality.algo.toUpperCase(), k: causality.events.length, d: causality.dropped.length,
                  m: minOcc, f: causality.found.length, t: causality.runtime_s.toFixed(2),
                })}</Note>
                {causality.events.length < 2 && <Note className="text-sig-run">{t("causality.fewEvents")}</Note>}
                <StateCausalView dataset={meta?.dataset ?? "statescope"} results={scSeries}
                  edges={stateEdges(causality).filter((e) => e.gain >= minGain && (!onlyCorroborated || e.mech.params.corroborated))}
                  resultId={`${causality.algo}|${causality.runtime_s}|${causality.found.length}|${minGain}|${onlyCorroborated}`} />
              </div>
            )}
          </StagePanel>
        );
    }
  }
}

function mono(v: ReactLike) {
  return <span className="font-mono tabular-nums">{v}</span>;
}

type ReactLike = string | number;

const EXTRA_KEY: Record<string, Key> = {
  dependency_graph: "data.extraDependencyGraph",
  root_causes: "data.extraRootCauses",
  pod_node: "data.extraPodNode",
};

function DataStats({ meta }: { meta: Meta }) {
  const t = useT();
  const s = meta.stats!;
  const info = meta.info;
  const lengthLabel = s.length_min === s.length_max ? `${s.length_max}` : `${s.length_min}–${s.length_max}`;
  const items: [string, ReactLike][] = [
    [t("data.statNSeries"), s.n_series],
    [t("data.statLength"), lengthLabel],
    [t("data.statNChannels"), s.n_channels],
    [t("data.statNStates"), s.n_states ?? "—"],
    [t("data.statHasTruth"), s.has_ground_truth ? t("data.yes") : t("data.no")],
    [t("data.statTotal"), s.total_samples],
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-fg">
          {info ? datasetLabel(meta.dataset ?? "", info.label) : t("data.statsTitle")}
        </div>
        {info?.source && (
          <div className="font-mono text-[10px] text-fg-faint">
            {datasetSource(meta.dataset ?? "", info.source)}
          </div>
        )}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
        {items.map(([label, val]) => (
          <div key={label}>
            <div className="text-[11px] text-fg-faint">{label}</div>
            <div className="mt-0.5 font-mono text-base tabular-nums text-fg">{val}</div>
          </div>
        ))}
      </div>
      {info?.background && <Note>{datasetBackground(meta.dataset ?? "", info.background)}</Note>}
      {s.extra && Object.keys(s.extra).length > 0 && (
        <Note>
          {t("data.extra", {
            items: Object.entries(s.extra)
              .map(([k, v]) => `${EXTRA_KEY[k] ? t(EXTRA_KEY[k]) : k} ${v}`)
              .join(" · "),
          })}
        </Note>
      )}
      {s.has_ground_truth && meta.true_state_names && Object.keys(meta.true_state_names).length > 0 && (
        <Note>
          {t("data.trueStates", {
            items: Object.entries(meta.true_state_names).map(([k, v]) => `${k}=${dyn(String(v))}`).join(" · "),
          })}
        </Note>
      )}
    </Card>
  );
}

function DataTable(props: { head: string[]; rows: (string | JSX.Element)[][] }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          {props.head.map((h) => (
            <th key={h} className="border-b border-border-soft px-2.5 py-1.5 text-left font-medium text-fg-faint">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} className="border-b border-border-soft px-2.5 py-1.5 text-fg">{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Clicking a card toggles the draft pick; "Apply" submits by name.
function EntitySelection(props: {
  series: SeriesData[];
  selection: Selection | null;
  draft: Record<string, string[]> | null;
  setDraft: (d: Record<string, string[]> | null) => void;
  busy: boolean;
  k: number;
  onApply: (picks: Record<string, string[]>) => void;
}) {
  const t = useT();
  const { series, selection, draft } = props;
  const applied = selection?.picks ?? null;
  const cur = draft ?? applied ?? {};
  const norm = (p: Record<string, string[]> | null) =>
    JSON.stringify(series.map((s) => [s.name, [...(p?.[s.name] ?? [])].sort()]).filter(([, ms]) => (ms as string[]).length));
  const dirty = draft !== null && norm(draft) !== norm(applied);
  const n = Object.values(cur).reduce((k, ms) => k + ms.length, 0);
  const setEntity = (e: string, ms: string[]) => props.setDraft({ ...cur, [e]: ms });
  const toggle = (e: string, m: string) => {
    const list = cur[e] ?? [];
    setEntity(e, list.includes(m) ? list.filter((x) => x !== m) : [...list, m]);
  };
  const ranking = selection?.ranking;
  // Original channel order until a ranking exists
  const ordered = (s: SeriesData) => {
    const r = ranking?.[s.name];
    const byName = new Map(s.channels.map((c) => [c.name, c]));
    return r
      ? r.map((x, i) => ({ ch: byName.get(x.name)!, score: x.score as number | null, rank: i + 1 })).filter((x) => x.ch)
      : s.channels.map((c) => ({ ch: c, score: null as number | null, rank: null as number | null }));
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-fg-muted">{t("select.pickedCount", { n })}</span>
          {dirty && <span className="text-[11px] text-sig-run">{t("select.unapplied")}</span>}
          {dirty && <Btn variant="outline" className="h-8 px-3 text-xs" onClick={() => props.setDraft(null)}>{t("select.revert")}</Btn>}
          <Btn className="h-8 px-3 text-xs" disabled={props.busy || n === 0 || (!dirty && applied !== null)}
            onClick={() => props.onApply(Object.fromEntries(Object.entries(cur).filter(([, ms]) => ms.length)))}>
            {t("select.applyPicks", { n })}
          </Btn>
        </div>
      </div>
      <Note>{t(ranking ? "select.entityHint" : "select.entityHintNoRank")}</Note>

      <div className="mt-4 flex flex-col gap-5">
        {series.map((s, si) => {
          const color = ENTITY_COLORS[si % ENTITY_COLORS.length];
          const picked = cur[s.name] ?? [];
          const items = ordered(s);
          const mx = Math.max(1e-9, ...items.map((x) => x.score ?? 0));
          return (
            <section key={s.name} className="border-l-[3px] pl-3" style={{ borderColor: color }}>
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-semibold" style={{ color }}>{dyn(s.name)}</span>
                <span className="font-mono text-[11px] text-fg-faint">{t("select.entityPicked", { k: picked.length, m: s.channels.length })}</span>
                <div className="ml-auto flex gap-3 text-[11px]">
                  {ranking?.[s.name] && (
                    <button className="text-fg-muted hover:text-accent" onClick={() => setEntity(s.name, items.slice(0, props.k).map((x) => x.ch.name))}>
                      {t("select.topK", { k: props.k })}
                    </button>
                  )}
                  <button className="text-fg-muted hover:text-accent" onClick={() => setEntity(s.name, s.channels.map((c) => c.name))}>{t("ms.all")}</button>
                  <button className="text-fg-muted hover:text-accent" onClick={() => setEntity(s.name, [])}>{t("ms.none")}</button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {items.map(({ ch, score, rank }) => {
                  const on = picked.includes(ch.name);
                  return (
                    <button key={ch.name} onClick={() => toggle(s.name, ch.name)} aria-pressed={on}
                      className={cn("group flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
                        on ? "border-accent bg-accent-soft/40" : "border-border-soft bg-panel hover:border-accent/50")}>
                      <div className="flex items-center gap-2">
                        <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none",
                          on ? "border-accent bg-accent text-white" : "border-fg-faint/50 text-transparent")}>✓</span>
                        <span className={cn("font-mono text-xs", on ? "font-semibold text-fg" : "text-fg-muted")}>{dyn(ch.name)}</span>
                        {rank !== null && <span className="font-mono text-[10px] text-fg-faint">#{rank}</span>}
                        {score !== null && (
                          <span className="ml-auto flex items-center gap-1.5" title={t("select.scoreTip", { s: score.toFixed(3) })}>
                            <span className="inline-block h-1 w-14 rounded-full bg-fg/10">
                              <span className="block h-1 rounded-full" style={{ width: `${Math.max(4, (100 * score) / mx)}%`, background: on ? color : "#9ca3af" }} />
                            </span>
                            <span className="font-mono text-[10px] tabular-nums text-fg-faint">{score.toFixed(2)}</span>
                          </span>
                        )}
                      </div>
                      <div className={cn("transition-opacity", on ? "opacity-100" : "opacity-45 group-hover:opacity-70")}>
                        <Sparkline values={ch.values} color={on ? color : "#9ca3af"} height={30} fluid />
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

// States are numbered by level (0 = lowest). While streaming, `plan` lists every metric: done rows show states, the first pending one is running, the rest queued.
function MetricDetectedView({ detected, T, plan, series }: {
  detected: Detected[]; T: number; plan?: { entity: string; metric: string }[] | null; series?: SeriesData[] | null;
}) {
  const t = useT();
  const valuesOf = (entity: string, metric: string) =>
    series?.find((s) => s.name === entity)?.channels.find((c) => c.name === metric)?.values;
  type Row = Detected | { name: string; entity: string; metric: string; pending: "running" | "queued" };
  let running = false;
  const rowsAll: Row[] = plan
    ? plan.map((p) => {
        const d = detected.find((x) => x.entity === p.entity && x.metric === p.metric);
        if (d) return d;
        const pending = running ? "queued" as const : "running" as const;
        running = true;
        return { name: `${p.entity}.${p.metric}`, entity: p.entity, metric: p.metric, pending };
      })
    : detected;
  const groups: [string, Row[]][] = [];
  for (const d of rowsAll) {
    const ent = d.entity;
    const last = groups[groups.length - 1];
    if (last && last[0] === ent) last[1].push(d);
    else groups.push([ent, [d]]);
  }
  return (
    <Card>
      <div className="flex flex-col gap-3">
        {groups.map(([ent, rows]) => (
          <div key={ent}>
            <div className="mb-1 text-xs font-medium text-fg">{dyn(ent)}</div>
            {rows.map((d) => (
              <div key={d.name} className="flex items-center gap-3 py-1">
                <span className="w-24 shrink-0 truncate font-mono text-[11px] text-fg-muted" title={dyn(d.metric)}>{dyn(d.metric)}</span>
                {"pending" in d ? (
                  <>
                    <div className={cn("h-9 flex-1 rounded",
                      d.pending === "running" ? "animate-pulse border border-accent bg-accent-soft" : "border border-dashed border-border")} />
                    <span className={cn("w-32 shrink-0 whitespace-nowrap text-right font-mono text-[11px]", d.pending === "running" ? "text-accent" : "text-fg-faint")}>
                      {t(d.pending === "running" ? "detect.pending" : "detect.queued")}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="flex-1"><StateRibbon segments={d.segments} T={T} height={36} values={valuesOf(d.entity, d.metric)} /></div>
                    <span className="w-32 shrink-0 whitespace-nowrap text-right font-mono text-[11px] text-fg-faint">
                      {t("detect.summaryMetric", { n: d.num_states, segs: d.segments.length })}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

// "series:S3" -> entity / metric / state
interface StateRefParts { entity?: string; metric: string; name: string; state: string }
function parseStateRef(label: string, entityOf: (name: string) => string | undefined): StateRefParts {
  const i = label.lastIndexOf(":S");
  const name = i >= 0 ? label.slice(0, i) : label;
  const state = i >= 0 ? label.slice(i + 2) : "";
  const entity = entityOf(name);
  const metric = entity && name.startsWith(`${entity}.`) ? name.slice(entity.length + 1) : "";
  return { entity, metric, name, state };
}

function StateRef({ r }: { r: StateRefParts }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {r.entity && r.metric ? (
        <>
          <span className="text-fg-faint">{dyn(r.entity)}</span>
          <span className="font-medium text-fg">{dyn(r.metric)}</span>
        </>
      ) : (
        <span className="text-fg">{dyn(r.name)}</span>
      )}
      {r.state !== "" && (
        <span className="rounded px-1 font-mono text-[10px] font-semibold text-[#262626]" style={{ background: paperStateColor(Number(r.state)) }}>
          {r.state}
        </span>
      )}
    </span>
  );
}
