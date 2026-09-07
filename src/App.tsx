import { useEffect, useState } from "react";
import { api, type DataParams } from "./api";
import type {
  Aligned, ClusterResult, Channel, Correlation, DatasetInfo, Detected, LeadLagPair, Meta, Segment, SeriesData, Selection, Stage, StateLink, StateProfile,
} from "./types";
import { MacWindow } from "./components/mac/MacWindow";
import { Sidebar, type StageNavItem } from "./components/Sidebar";
import { StagePanel, Field, Card, Note, SegToggle, Btn, type StepStatus } from "./components/ui";
import { cn } from "./lib/cn";
import { SeriesChart } from "./components/SeriesChart";
import { Sparkline } from "./components/Sparkline";
import { StateRibbon } from "./components/StateRibbon";
import { StateGallery, StateDetailModal } from "./components/StateGallery";
import { StateTransitionGraph } from "./components/StateTransitionGraph";
import { LeadLagRibbons } from "./components/LeadLagRibbons";
import { StateLinkFlow } from "./components/StateLinkFlow";
import { Heatmap } from "./components/Heatmap";
import { ClusterCausalView } from "./components/ClusterCausalView";
import { ThresholdSlider } from "./components/ThresholdSlider";
import { KnowledgeModal } from "./components/KnowledgeModal";
import { CalibrationModal } from "./components/CalibrationModal";
import { buildKnowledge } from "./lib/knowledge";
import { useViewMode } from "./lib/viewMode";
import {
  useT, tr, dyn, dynError, datasetLabel, datasetBackground, datasetNote, datasetSource, type Key,
} from "./i18n";

const ORDER: Stage[] = ["data", "select", "detect", "align", "correlate", "causality"];
const LABEL_KEY: Record<Stage, Key> = {
  data: "stage.data", select: "stage.select", detect: "stage.detect", align: "stage.align",
  correlate: "stage.correlate", causality: "stage.causality",
};
const PREREQ: Record<Stage, Stage | null> = {
  data: null, select: "data", detect: "select", align: "detect", correlate: "align", causality: "align",
};
const CORR_KINDS = ["overall", "transition", "partial", "time_lagged", "structural", "state_link"];

// Per-dataset stage defaults, applied automatically when the dataset changes so each case
// starts from sensible parameters.
type StageDefaults = {
  selP?: { selector: string; K: number };
  detP?: { win_size: number; step: number; nb_steps: number; n_states: number };
  corrP?: { tolerance: number; max_lag: number; min_lift: number };
  // Influence-flow thresholds: lagged strength and contemporaneous strength.
  linkP?: { lagMin: number; syncMin: number };
  causP?: { n_states: number; tau_max: number; pc_alpha: number; max_edges_per_regime: number };
};
// Baseline defaults; individual datasets override selected stages below.
const BASE_DEFAULTS: Required<StageDefaults> = {
  selP: { selector: "issd", K: 3 },
  detP: { win_size: 100, step: 50, nb_steps: 60, n_states: 6 },
  corrP: { tolerance: 60, max_lag: 400, min_lift: 1.2 },
  linkP: { lagMin: 0.3, syncMin: 0.85 },
  causP: { n_states: 4, tau_max: 2, pc_alpha: 0.05, max_edges_per_regime: 10 },
};
const DATASET_DEFAULTS: Record<string, StageDefaults> = {
  petshop: {
    selP: { selector: "unlabeled", K: 4 },
    detP: { win_size: 100, step: 30, nb_steps: 60, n_states: 6 },
    corrP: { tolerance: 60, max_lag: 300, min_lift: 1.5 },
    linkP: { lagMin: 0.8, syncMin: 0.85 },
    causP: { n_states: 4, tau_max: 2, pc_alpha: 0.005, max_edges_per_regime: 6 },
  },
  lemma_rca: {
    selP: { selector: "unlabeled", K: 4 },
    detP: { win_size: 100, step: 30, nb_steps: 60, n_states: 8 },
    corrP: { tolerance: 60, max_lag: 300, min_lift: 2.0 },
    linkP: { lagMin: 0.6, syncMin: 0.85},
    causP: { n_states: 3, tau_max: 1, pc_alpha: 0.01, max_edges_per_regime: 8 },
  },
};

export function App() {
  const t = useT();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [series, setSeries] = useState<SeriesData[] | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [aligned, setAligned] = useState<Aligned | null>(null);
  const [stateProfiles, setStateProfiles] = useState<StateProfile[] | null>(null);
  const [stateDetail, setStateDetail] = useState<number | null>(null);
  const [correlations, setCorrelations] = useState<Record<string, Correlation> | null>(null);
  const [causality, setCausality] = useState<ClusterResult | null>(null);

  const [active, setActive] = useState<Stage>(() => {
    const s = new URLSearchParams(window.location.search).get("stage") as Stage | null;
    return s && ORDER.includes(s) ? s : "data";
  });
  const [everRun, setEverRun] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const viewMode = useViewMode();
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [sourceMode, setSourceMode] = useState<"synthetic" | "public">("public");
  // Land on PetShop by default; the synthetic set is still selectable.
  const [dataP, setDataP] = useState<DataParams>({ dataset: "petshop", n_series: 3, lag: 150, seg_len: 400, n_useful: 3, n_noise: 5, seed: 1, scenario: "" });
  const [selP, setSelP] = useState({ selector: "issd", K: 3 });
  const [detP, setDetP] = useState({ win_size: 100, step: 50, nb_steps: 60, n_states: 6 });
  const [corrP, setCorrP] = useState({ tolerance: 60, max_lag: 400, min_lift: 1.2 });
  const [linkP, setLinkP] = useState({ lagMin: 0.3, syncMin: 0.85 });
  const [causP, setCausP] = useState({ n_states: 4, tau_max: 2, pc_alpha: 0.05, max_edges_per_regime: 10 });
  const [transTh, setTransTh] = useState(0);
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

  const createSession = (override?: Partial<DataParams>) =>
    guard("data", async () => {
      const r = await api.createSession({ ...dataP, ...(override ?? {}) });
      setMeta(r.meta); setSeries(r.series);
      setSelection(null); setDetected(null); setAligned(null); setStateProfiles(null); setCorrelations(null); setCausality(null);
      setEverRun(new Set());
      setActive("data");
      applyDatasetDefaults(r.meta.dataset ?? "", r.meta.has_ground_truth !== false);
    });

  // Switching dataset fully resets every stage, so no value leaks from the previous one.
  function applyDatasetDefaults(id: string, hasTruth: boolean) {
    const d = DATASET_DEFAULTS[id] ?? {};
    setDetP(d.detP ?? BASE_DEFAULTS.detP);
    setCorrP(d.corrP ?? BASE_DEFAULTS.corrP);
    setLinkP(d.linkP ?? BASE_DEFAULTS.linkP);
    setCausP(d.causP ?? BASE_DEFAULTS.causP);
    // Selector: dataset override if any, else unlabelled when there is no ground truth.
    setSelP(d.selP ?? (hasTruth ? BASE_DEFAULTS.selP : { selector: "unlabeled", K: 4 }));
  }

  // Selecting a dataset loads it immediately.
  const pickDataset = (id: string) => {
    setDataP((p) => ({ ...p, dataset: id }));
    createSession({ dataset: id });
  };

  const runSelect = () =>
    guard("select", async () => {
      const r = await api.select(sid!, selP);
      setMeta(r.meta); setSelection(r.selection); setSeries(r.series);
    });
  const runDetect = () =>
    guard("detect", async () => {
      const r = await api.detect(sid!, detP);
      setMeta(r.meta); setDetected(r.detected);
    });
  // Calibration writes back the edited series; the backend then invalidates alignment and
  // everything downstream, which the stage gating picks up from meta.completed.
  const applyCalibration = (edits: { name: string; segments: Segment[] }[]) =>
    guard("detect", async () => {
      const r = await api.calibrate(sid!, { series: edits });
      setMeta(r.meta); setDetected(r.detected);
      setCalibOpen(false);
    });
  const runAlign = () =>
    guard("align", async () => {
      const r = await api.align(sid!);
      setMeta(r.meta); setAligned(r.aligned); setStateProfiles(r.state_profiles);
    });
  const runCorrelate = () =>
    guard("correlate", async () => {
      const r = await api.correlate(sid!, { kinds: CORR_KINDS, ...corrP });
      setMeta(r.meta); setCorrelations(r.correlations);
    });
  const runCausality = () =>
    guard("causality", async () => {
      const r = await api.causality(sid!, causP);
      setMeta(r.meta); setCausality(r.causality);
    });

  async function runAll() {
    if (!sid) return;
    setError(null);
    try {
      setBusy("select"); setActive("select"); let r = await api.select(sid, selP); setMeta(r.meta); setSelection(r.selection); setSeries(r.series);
      setBusy("detect"); setActive("detect"); let d = await api.detect(sid, detP); setMeta(d.meta); setDetected(d.detected);
      setBusy("align"); setActive("align"); let a = await api.align(sid); setMeta(a.meta); setAligned(a.aligned); setStateProfiles(a.state_profiles);
      setBusy("correlate"); setActive("correlate"); let c = await api.correlate(sid, { kinds: CORR_KINDS, ...corrP }); setMeta(c.meta); setCorrelations(c.correlations);
      setBusy("causality"); setActive("causality"); let g = await api.causality(sid, causP); setMeta(g.meta); setCausality(g.causality);
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
      setAligned(s.aligned ?? null); setStateProfiles(s.state_profiles ?? null); setCorrelations(s.correlations ?? null);
      setCausality(s.causality ?? null);
      setEverRun(new Set(s.meta.completed));
      applyDatasetDefaults(s.meta.dataset ?? "", s.meta.has_ground_truth !== false);
    } catch (e) {
      setError(t("data.loadSessionFailed", { id, err: dynError(e) }));
      await api.createSession(dataP).then((r) => { setMeta(r.meta); setSeries(r.series); });
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    api.datasets().then((r) => setDatasets(r.datasets)).catch(() => {});
    const existing = new URLSearchParams(window.location.search).get("session");
    if (existing) attachSession(existing);
    else createSession();
  }, []);

  // Keep the source toggle in sync with the group of the loaded dataset.
  useEffect(() => {
    const g = datasets.find((d) => d.id === meta?.dataset)?.group;
    if (g === "synthetic" || g === "public") setSourceMode(g);
  }, [meta?.dataset, datasets]);

  const T = meta?.T ?? 1;
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
      {stateDetail !== null && stateProfiles && (() => {
        const p = stateProfiles.find((x) => x.state === stateDetail);
        return p ? <StateDetailModal profile={p} onClose={() => setStateDetail(null)} /> : null;
      })()}
      {calibOpen && detected && series && (
        <CalibrationModal
          detected={detected}
          series={series}
          busy={busy === "detect"}
          onApply={applyCalibration}
          onClose={() => setCalibOpen(false)}
        />
      )}
      {knowledgeOpen && (() => {
        const snap = { meta, series, selection, detected, aligned, correlations, causality };
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

  // ── Stage panels ──
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
                    .filter((d) => d.group === sourceMode && (viewMode === "full" || d.available))
                    .map((d) => {
                    const activeD = (meta?.dataset ?? dataP.dataset) === d.id;
                    return (
                      <button key={d.id} disabled={!d.available || !!busy}
                        onClick={() => d.available && pickDataset(d.id)}
                        title={d.available ? datasetSource(d.id, d.source) : datasetNote(d.id, d.note)}
                        className={cn(
                          "max-w-[280px] rounded-md border px-3 py-2 text-left transition-colors",
                          activeD ? "border-accent bg-accent-soft" : "border-border bg-panel hover:bg-app-bg",
                          !d.available && "cursor-not-allowed opacity-50",
                        )}>
                        <div className="flex items-center gap-1.5 text-xs font-medium text-fg">
                          {datasetLabel(d.id, d.label)}
                          {!d.available && <span className="rounded-sm bg-fg/[0.06] px-1 text-[9px] text-fg-faint">{t("data.unavailable")}</span>}
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-faint">
                          {d.available ? datasetBackground(d.id, d.background) : datasetNote(d.id, d.note)}
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
            desc={tr("select.desc")}
            runLabel={t("select.runLabel")} onRun={runSelect}
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
            {selection && series && <SelectionView channels={series[0].channels} selection={selection} />}
          </StagePanel>
        );

      case "detect":
        return (
          <StagePanel
            title={t("stage.detect")} tag="STAGE 3" status={statusOf("detect")} {...nextProps}
            desc={tr("detect.desc")}
            runLabel={t("detect.runLabel")} onRun={runDetect}
            actions={detected && (
              <Btn variant="outline" className="h-8 px-3 text-xs" onClick={() => setCalibOpen(true)}>
                {t("detect.calibrate")}
              </Btn>
            )}
            controls={
              <>
                <Field label={t("detect.fieldWin")} type="number" min={50} max={300} step={10} value={detP.win_size} onChange={(v) => setDetP({ ...detP, win_size: +v })} />
                <Field label={t("detect.fieldStep")} type="number" min={10} max={100} step={10} value={detP.step} onChange={(v) => setDetP({ ...detP, step: +v })} />
                <Field label={t("detect.fieldNbSteps")} type="number" min={20} max={120} step={10} value={detP.nb_steps} onChange={(v) => setDetP({ ...detP, nb_steps: +v })} />
                <Field label={t("detect.fieldNStates")} type="number" min={2} max={12} value={detP.n_states} onChange={(v) => setDetP({ ...detP, n_states: +v })} />
              </>
            }>
            {detected && (
              <Card>
                {detected.map((d) => (
                  <div key={d.name} className="flex items-center gap-3 py-1.5">
                    <span className="w-16 shrink-0 truncate text-xs text-fg-muted" title={dyn(d.name)}>{dyn(d.name)}</span>
                    <div className="flex-1"><StateRibbon segments={d.segments} T={T} /></div>
                    <span className="w-28 shrink-0 text-right font-mono text-[11px] text-fg-faint">
                      {d.ari != null
                        ? t("detect.summary", { n: d.num_states, ari: String(d.ari) })
                        : t("detect.summaryNoAri", { n: d.num_states })}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </StagePanel>
        );

      case "align":
        return (
          <StagePanel
            title={t("stage.align")} tag="STAGE 1·3" status={statusOf("align")} {...nextProps}
            desc={tr("align.desc")}
            runLabel={t("align.runLabel")} onRun={runAlign}>
            {aligned && (
              <div className="flex flex-col gap-4">
                {stateProfiles && stateProfiles.length > 0 && (
                  <StateGallery profiles={stateProfiles} onOpen={setStateDetail} />
                )}
                <Card title={t("align.ribbonTitle")}>
                  {aligned.sequences.map((d) => (
                    <div key={d.name} className="flex items-center gap-3 py-1.5">
                      <span className="w-16 shrink-0 truncate text-xs text-fg-muted" title={dyn(d.name)}>{dyn(d.name)}</span>
                      <div className="flex-1"><StateRibbon segments={d.segments} T={T} /></div>
                    </div>
                  ))}
                </Card>
                {aligned.transition_graph && aligned.transition_graph.edges.length > 0 && (
                  <Card title={t("align.transTitle")}>
                    <Note>
                      {t("align.transNote")}
                      <b className="font-medium text-accent">{t("align.transNoteMain")}</b>
                      {t("align.transNoteTail")}
                    </Note>
                    <div className="mt-3"><ThresholdSlider value={transTh} onChange={setTransTh} label={t("align.transThreshold")} /></div>
                    <StateTransitionGraph graph={aligned.transition_graph} threshold={transTh} />
                  </Card>
                )}
              </div>
            )}
          </StagePanel>
        );

      case "correlate":
        return (
          <StagePanel
            title={t("stage.correlate")} tag="STAGE 4" status={statusOf("correlate")} {...nextProps}
            desc={tr("correlate.desc")}
            runLabel={t("correlate.runLabel")} onRun={runCorrelate}
            controls={
              <>
                <Field label={t("correlate.fieldTolerance")} type="number" min={10} max={200} step={10} value={corrP.tolerance} onChange={(v) => setCorrP({ ...corrP, tolerance: +v })} />
                <Field label={t("correlate.fieldMaxLag")} type="number" min={50} max={600} step={50} value={corrP.max_lag} onChange={(v) => setCorrP({ ...corrP, max_lag: +v })} />
                <Field label={t("correlate.fieldMinLift")} type="number" min={1} max={5} step={0.1} value={corrP.min_lift} onChange={(v) => setCorrP({ ...corrP, min_lift: +v })} />
              </>
            }>
            {correlations && (
              <div className="flex flex-col gap-4">
                {correlations.state_link && aligned && (
                  <StateLinkFlow aligned={aligned} links={correlations.state_link.pairs as unknown as StateLink[]} T={T}
                    lagMin={linkP.lagMin} syncMin={linkP.syncMin}
                    onLagMin={(v) => setLinkP((p) => ({ ...p, lagMin: v }))}
                    onSyncMin={(v) => setLinkP((p) => ({ ...p, syncMin: v }))} />
                )}
                {correlations.time_lagged && aligned && (
                  <LeadLagRibbons aligned={aligned} pairs={correlations.time_lagged.pairs as unknown as LeadLagPair[]} T={T} />
                )}
                <div className="flex flex-wrap gap-4">
                  {([["overall", t("correlate.heatOverall")], ["transition", t("correlate.heatTransition")], ["time_lagged", t("correlate.heatTimeLagged")]] as const).map(([k, title]) =>
                    correlations[k]?.matrix ? (
                      <Heatmap key={k} title={title} matrix={correlations[k].matrix!} labels={correlations[k].labels!} />
                    ) : null
                  )}
                </div>
                <div className="flex flex-wrap gap-4">
                  {correlations.time_lagged && (
                    <Card title={t("correlate.leadLagTitle")} className="min-w-[280px] flex-1">
                      <DataTable head={[t("correlate.colLeader"), t("correlate.colFollower"), "lag", "NMI"]}
                        rows={(correlations.time_lagged.pairs as unknown as LeadLagPair[]).map((p) => [dyn(p.leader), dyn(p.follower), mono(p.lag), mono(p.nmi.toFixed(3))])} />
                    </Card>
                  )}
                  {correlations.partial && (
                    <Card title={t("correlate.partialTitle")} className="min-w-[280px] flex-1">
                      <DataTable head={["from", "to", "lift"]}
                        rows={correlations.partial.pairs.slice(0, 8).map((p: any) => [dyn(p.from), dyn(p.to), mono(p.lift)])} />
                    </Card>
                  )}
                  {correlations.structural && (
                    <Card title={t("correlate.structuralTitle")} className="min-w-[280px] flex-1">
                      <DataTable head={["from", "to", "state", t("correlate.colRelation")]}
                        rows={correlations.structural.pairs.slice(0, 8).map((p: any) => [dyn(p.from), dyn(p.to), `S${p.state}`, p.relation])} />
                    </Card>
                  )}
                </div>
              </div>
            )}
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
                <Field label={t("causality.fieldNStates")} type="number" min={2} max={8} value={causP.n_states} onChange={(v) => setCausP({ ...causP, n_states: +v })} />
                <Field label="tau_max" type="number" min={1} max={6} value={causP.tau_max} onChange={(v) => setCausP({ ...causP, tau_max: +v })} />
                <Field label="pc_alpha" type="number" min={0.005} max={0.3} step={0.005} value={causP.pc_alpha} onChange={(v) => setCausP({ ...causP, pc_alpha: +v })} />
                <Field label={t("causality.fieldMaxEdges")} type="number" min={0} max={40} value={causP.max_edges_per_regime} onChange={(v) => setCausP({ ...causP, max_edges_per_regime: +v })} />
              </>
            }>
            {causality && <ClusterCausalView result={causality} />}
          </StagePanel>
        );
    }
  }
}

function mono(v: ReactLike) {
  return <span className="font-mono tabular-nums">{v}</span>;
}

type ReactLike = string | number;

// Before/after view of selection: kept vs dropped channels, one sparkline each, so the
// state structure in the kept ones is visible at a glance.
function SelectionView({ channels, selection }: { channels: Channel[]; selection: Selection }) {
  const t = useT();
  const selected = channels.filter((c) => c.selected);
  const dropped = channels.filter((c) => !c.selected);
  const Col = ({ title, items, kept }: { title: string; items: Channel[]; kept: boolean }) => (
    <Card className="min-w-[280px] flex-1">
      <div className="mb-1 flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 rounded-full", kept ? "bg-sig-done" : "bg-fg-faint/40")} />
        <span className="font-medium text-fg">{title}</span>
        <span className="text-fg-faint">· {items.length}</span>
      </div>
      <div className="flex flex-col divide-y divide-border-soft">
        {items.map((c) => (
          <div key={c.name} className="flex items-center gap-3 py-1.5">
            <span className={cn("w-24 shrink-0 truncate text-xs", kept ? "font-medium text-fg" : "text-fg-faint")}
              title={dyn(c.name)}>{dyn(c.name)}</span>
            <div className="flex-1"><Sparkline values={c.values} color={kept ? "#2ca35a" : "#b8bdc6"} /></div>
          </div>
        ))}
        {items.length === 0 && <div className="py-3 text-xs text-fg-faint">{t("common.none")}</div>}
      </div>
    </Card>
  );
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm text-fg-muted">{t("select.summary")}</span>
          <span className="font-mono text-base tabular-nums text-fg">{channels.length}</span>
          <span className="text-fg-faint">{t("select.toSelected")}</span>
          <span className="font-mono text-lg font-semibold tabular-nums text-sig-done">{selected.length}</span>
          <span className="text-xs text-fg-faint">{t("select.methodTag", { name: selection.selector })}</span>
          {selection.selector === "issd" && selection.qf && selection.qf.length > 0 && (
            <span className="text-xs text-fg-faint">· QF {JSON.stringify(selection.qf)} · CF {JSON.stringify(selection.cf)}</span>
          )}
        </div>
        <Note>{t("select.note")}</Note>
      </Card>
      <div className="flex flex-wrap gap-4">
        <Col title={t("select.keptTitle")} items={selected} kept />
        <Col title={t("select.droppedTitle")} items={dropped} kept={false} />
      </div>
    </div>
  );
}

const EXTRA_KEY: Record<string, Key> = {
  dependency_graph: "data.extraDependencyGraph",
  root_causes: "data.extraRootCauses",
  pod_node: "data.extraPodNode",
};

// Dataset overview: counts, length, channels, states, ground truth and provenance.
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

// Minimal table: header plus rows.
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
