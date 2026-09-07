import { useEffect, useState } from "react";
import type { ClusterResult, Segment } from "../types";
import { Card, Field } from "./ui";
import { ThresholdSlider } from "./ThresholdSlider";
import { ClusterCausalGraph, KindLegend } from "./ClusterCausalGraph";
import { stateColor } from "../theme";
import { cn } from "../lib/cn";
import { useViewMode } from "../lib/viewMode";
import { useT, tr, dyn } from "../i18n";

// Result view for cluster regimes + causality: a regime timeline at the top (click to
// switch), the composite-node graph of the current regime, and live layout controls.
export function ClusterCausalView({ result }: { result: ClusterResult }) {
  const t = useT();
  const [sel, setSel] = useState(result.regimes.states[0] ?? 0);
  const [edgeTh, setEdgeTh] = useState(0.15);
  const [nodeR, setNodeR] = useState(24);
  const [chSpread, setChSpread] = useState(2.4);
  const [bow, setBow] = useState(0.14);
  const [vizW, setVizW] = useState(680);
  const viewMode = useViewMode();
  const [showGt, setShowGt] = useState(true);

  useEffect(() => setSel(result.regimes.states[0] ?? 0), [result]);
  const curGraph = result.graphs.find((g) => g.state === sel);
  // The reference topology is only overlaid in full (DEV) mode.
  const gt = result.gt_topology;
  const gtOn = viewMode === "full" && showGt && !!gt && gt.edges.length > 0;
  const gtEdges = gtOn ? gt!.edges : [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">
        {t("cluster.summary", {
          engine: result.engine,
          pods: result.pods.length,
          n: result.meta.N,
          T: result.meta.T,
          stride: result.meta.stride && result.meta.stride > 1
            ? t("cluster.strideSuffix", { stride: result.meta.stride })
            : "",
          regimes: result.regimes.states.length,
        })}
      </p>

      {/* Regime timeline: the selected regime at full saturation, the rest muted */}
      <Card title={t("cluster.ribbonTitle")}>
        <RegimeRibbon segments={result.regimes.segments} T={result.regimes.T} selected={sel} onSelect={setSel} />
        <div className="mt-2 flex flex-wrap gap-2">
          {result.regimes.states.map((s) => (
            <button key={s} onClick={() => setSel(s)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
                s === sel ? "border-accent/40 bg-accent/[0.07] text-fg" : "border-border-soft text-fg-muted hover:text-fg",
              )}>
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: stateColor(s) }} />
              regime {s}
            </button>
          ))}
        </div>
      </Card>

      {/* Composite-node causal graph of the current regime */}
      {curGraph && (
        <Card>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium text-fg">
              <span className="mr-1 inline-block h-3 w-3 rounded-[3px] align-middle" style={{ background: stateColor(sel) }} />
              regime {sel}
              <span className="ml-1 font-mono text-[11px] font-normal text-fg-faint">
                {t("cluster.regimeInfo", {
                  n: curGraph.n_samples,
                  edges: curGraph.edges.filter((e) => e.src !== e.dst).length,
                })}
              </span>
            </div>
            <KindLegend kinds={result.kind_of} />
          </div>
          <ClusterEdgeLegend />
          {viewMode === "full" && (
            <GtReferenceBar gt={gt} on={gtOn} onToggle={() => setShowGt((v) => !v)} />
          )}
          <ThresholdSlider value={edgeTh} onChange={setEdgeTh} label={t("cluster.edgeThreshold")} max={0.8} />
          <div className="mt-1 flex flex-wrap items-center gap-3 border-t border-border-soft pt-2">
            <span className="text-xs text-fg-faint">{t("cluster.viz")}</span>
            <Field label={t("cluster.vizNodeR")} type="number" min={10} max={34} value={nodeR} onChange={(v) => setNodeR(+v)} />
            <Field label={t("cluster.vizSpread")} type="number" min={1.5} max={4} step={0.1} value={chSpread} onChange={(v) => setChSpread(+v)} />
            <Field label={t("cluster.vizBow")} type="number" min={0} max={0.5} step={0.02} value={bow} onChange={(v) => setBow(+v)} />
            <Field label={t("cluster.vizWidth")} type="number" min={480} max={1100} step={20} value={vizW} onChange={(v) => setVizW(+v)} />
          </div>
          <div className="mt-2">
            <ClusterCausalGraph
              varNames={result.var_names} podOf={result.pod_of} kindOf={result.kind_of}
              pods={result.pods} edges={curGraph.edges} threshold={edgeTh}
              nodeR={nodeR} chSpread={chSpread} bow={bow} maxWidth={vizW}
              stride={result.meta.stride ?? 1} gtEdges={gtEdges} gtDirected={gt?.directed ?? true} />
          </div>
        </Card>
      )}
    </div>
  );
}

// Regime timeline; the selected regime is at full saturation.
function RegimeRibbon(props: {
  segments: Segment[];
  T: number;
  selected: number;
  onSelect: (s: number) => void;
}) {
  const t = useT();
  const { segments, T, selected, onSelect } = props;
  const W = 1000;
  const h = 30;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} width="100%" height={h} preserveAspectRatio="none"
      className="block rounded-[4px] ring-1 ring-black/5">
      {segments.map((s, i) => (
        <rect key={i} x={(s.start / T) * W} y={0} width={Math.max(0.5, ((s.end - s.start) / T) * W)}
          height={h} fill={stateColor(s.state)} opacity={s.state === selected ? 1 : 0.22}
          style={{ cursor: "pointer" }} onClick={() => onSelect(s.state)}>
          <title>{t("viz.regimeTip", { state: s.state, start: s.start, end: s.end })}</title>
        </rect>
      ))}
    </svg>
  );
}

// Reference-topology bar (full/DEV mode only): legend and toggle, or a note when empty.
function GtReferenceBar(props: { gt?: ClusterResult["gt_topology"]; on: boolean; onToggle: () => void }) {
  const t = useT();
  const { gt } = props;
  const has = !!gt && gt.kind != null && gt.edges.length > 0;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-app-bg px-2.5 py-1.5 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">{t("cluster.gtBadge")}</span>
      {has ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-fg-muted">
            <svg width="24" height="8"><line x1="1" y1="4" x2="23" y2="4" stroke="#8b93a1" strokeWidth="2" strokeDasharray="2 5" /></svg>
            {gt!.kind === "call_graph"
              ? t("cluster.gtCallGraph")
              : gt!.kind === "flow"
                ? t("cluster.gtFlow")
                : t("cluster.gtColoc")}
            {t("cluster.gtCount", { n: gt!.edges.length })}
          </span>
          <button onClick={props.onToggle}
            className={cn("rounded border px-1.5 py-0.5 text-[11px] transition-colors",
              props.on ? "border-accent/40 bg-accent/[0.07] text-fg" : "border-border text-fg-muted hover:text-fg")}>
            {props.on ? t("cluster.gtOn") : t("cluster.gtOff")}
          </button>
          <span className="text-fg-faint">· {dyn(gt!.note)}</span>
        </>
      ) : (
        <span className="text-fg-faint">{t("cluster.gtEmpty")}</span>
      )}
    </div>
  );
}

function ClusterEdgeLegend() {
  const t = useT();
  const ln = (dash: boolean, label: string) => (
    <span className="mr-3 inline-flex items-center gap-1.5">
      <svg width="24" height="10">
        <line x1="1" y1="5" x2="23" y2="5" stroke="#64748b" strokeWidth="2.5" strokeDasharray={dash ? "4 3" : "0"} />
      </svg>
      <span>{label}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-y-1 text-xs text-fg-faint">
      <span className="mr-3">{tr("cluster.legendNode")}</span>
      <span className="mr-3">{tr("cluster.legendEdge")}</span>
      {ln(false, t("cluster.legendSync"))}
      {ln(true, t("cluster.legendLag"))}
      <span>{tr("cluster.legendWidth")}</span>
    </div>
  );
}
