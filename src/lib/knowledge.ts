import type { CausalityResult, Correlation, Detected, Meta, SeriesData, Selection, Stage } from "../types";
import { t, dyn, dynList, datasetLabel, type Key } from "../i18n";

export type Tone = "fact" | "pattern" | "highlight";
export interface Insight { text: string; tone?: Tone; }
export interface KnowledgeSection {
  stage: Stage;
  label: string;
  done: boolean;
  insights: Insight[];
}
export interface KnowledgeReport {
  sections: KnowledgeSection[];
  synthesis: Insight[];
  progress: { done: number; total: number };
}

export interface Snapshot {
  meta: Meta | null;
  series: SeriesData[] | null;
  selection: Selection | null;
  detected: Detected[] | null;
  correlations: Record<string, Correlation> | null;
  causality: CausalityResult | null;
}

const STAGE_KEY: Record<Stage, Key> = {
  data: "stage.data", select: "stage.select", detect: "stage.detect",
  correlate: "stage.correlate", causality: "stage.causality",
};
const STAGE_ORDER: Stage[] = ["data", "select", "detect", "correlate", "causality"];

function chainFromEdges(rawEdges: { from: string; to: string }[]): string[] {
  // Dedupe: repeated edges would skew in-degrees.
  const uniq = new Map<string, { from: string; to: string }>();
  for (const e of rawEdges) if (e.from !== e.to) uniq.set(`${e.from}->${e.to}`, e);
  const edges = [...uniq.values()];
  const nodes = new Set<string>();
  const indeg = new Map<string, number>();
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    nodes.add(e.from); nodes.add(e.to);
    if (!indeg.has(e.from)) indeg.set(e.from, 0);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    (adj.get(e.from) ?? adj.set(e.from, new Set()).get(e.from)!).add(e.to);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const remaining = [...nodes];
  while (order.length < remaining.length) {
    const cand = remaining
      .filter((n) => !seen.has(n))
      .sort((a, b) => (indeg.get(a)! - indeg.get(b)!) || a.localeCompare(b))[0];
    if (cand == null) break;
    order.push(cand); seen.add(cand);
    for (const nb of adj.get(cand) ?? []) indeg.set(nb, Math.max(0, (indeg.get(nb) ?? 1) - 1));
  }
  return order;
}

export function buildKnowledge(s: Snapshot): KnowledgeReport {
  const done = new Set<Stage>(s.meta?.completed ?? []);
  const detected = s.detected;
  const stages = STAGE_ORDER;
  const entityOf = (series: string) => detected?.find((d) => d.name === series)?.entity;
  const seriesLabel = (series: string) => {
    const e = entityOf(series);
    return e && series.startsWith(`${e}.`) ? `${dyn(e)}·${dyn(series.slice(e.length + 1))}` : dyn(series);
  };
  const stateLabel = (ref: string) => {
    const i = ref.lastIndexOf(":S");
    return i >= 0 ? `${seriesLabel(ref.slice(0, i))}=${ref.slice(i + 2)}` : seriesLabel(ref);
  };
  const sections: KnowledgeSection[] = stages.map((stage) => ({
    stage, label: t(STAGE_KEY[stage]), done: done.has(stage), insights: [],
  }));
  const sec = (stage: Stage) => sections.find((x) => x.stage === stage)!;

  if (done.has("data") && s.meta) {
    const st = s.meta.stats;
    // Dataset labels go through datasetLabel by id, not the term-level dyn.
    const name = s.meta.info?.label
      ? datasetLabel(s.meta.dataset ?? "", s.meta.info.label)
      : s.meta.dataset || t("insight.dataset");
    if (st) {
      const len = st.length_min === st.length_max ? `${st.length_max}` : `${st.length_min}–${st.length_max}`;
      sec("data").insights.push({
        text: t("insight.dataImport", {
          name, nSeries: st.n_series, len, nChannels: st.n_channels,
        }),
        tone: "fact",
      });
      sec("data").insights.push({
        text: st.has_ground_truth
          ? t("insight.dataTruth", { n: st.n_states ?? "?" })
          : t("insight.dataNoTruth"),
        tone: "fact",
      });
    }
  }

  if (done.has("select") && s.selection) {
    const picks = Object.entries(s.selection.picks).filter(([, m]) => m.length);
    const k = picks.reduce((a, [, m]) => a + m.length, 0);
    const total = (s.series ?? []).reduce((a, x) => a + x.channels.length, 0);
    const how = t(s.selection.selector === "manual" ? "insight.selectHowManual" : "insight.selectHowRank");
    sec("select").insights.push({
      text: t("insight.selectPerEntity", { nEnt: picks.length, k, total, how }),
      tone: "fact",
    });
    for (const [e, ms] of picks)
      sec("select").insights.push({ text: t("insight.selectEntityLine", { entity: dyn(e), metrics: dynList(ms) }), tone: "fact" });
    if (total > k) sec("select").insights.push({ text: t("insight.selectDroppedMetric", { dropped: total - k }), tone: "pattern" });
  }

  if (done.has("detect") && detected) {
    const counts = detected.map((d) => d.num_states);
    const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    sec("detect").insights.push({
      text: t("insight.detectMetric", { n: detected.length, nEnt: new Set(detected.map((d) => d.entity)).size }),
      tone: "fact",
    });
    sec("detect").insights.push({
      text: Math.min(...counts) === Math.max(...counts)
        ? t("insight.detectSame", { n: counts[0] })
        : t("insight.detectRange", { min: Math.min(...counts), max: Math.max(...counts), avg: avg.toFixed(1) }),
      tone: "fact",
    });
    sec("detect").insights.push({ text: t("insight.detectMetricOwn"), tone: "pattern" });
  }

  if (done.has("correlate") && s.correlations) {
    const overall = s.correlations.overall;
    if (overall?.matrix && overall.labels) {
      const m = overall.matrix, L = overall.labels;
      const pairs: { a: string; b: string; v: number }[] = [];
      for (let i = 0; i < m.length; i++) for (let j = 0; j < i; j++) pairs.push({ a: L[j], b: L[i], v: m[i][j] });
      pairs.sort((x, y) => y.v - x.v);
      const top = pairs[0];
      const cross = pairs.find((p) => entityOf(p.a) && entityOf(p.b) && entityOf(p.a) !== entityOf(p.b));
      if (top)
        sec("correlate").insights.push({
          text: t("insight.corrOverallTop", { a: seriesLabel(top.a), b: seriesLabel(top.b), nmi: top.v.toFixed(2) }),
          tone: "fact",
        });
      if (cross && cross !== top)
        sec("correlate").insights.push({
          text: t("insight.corrOverallCross", { a: seriesLabel(cross.a), b: seriesLabel(cross.b), nmi: cross.v.toFixed(2) }),
          tone: "fact",
        });
    }
    const partial = s.correlations.partial;
    const refEntity = (ref: string) => entityOf(ref.slice(0, ref.lastIndexOf(":S") >= 0 ? ref.lastIndexOf(":S") : ref.length));
    if (partial?.pairs?.length) {
      const ps = partial.pairs as { from: string; to: string; lift: number; jaccard?: number }[];
      const fmt = (p: (typeof ps)[number]) => ({
        from: stateLabel(p.from), to: stateLabel(p.to), jaccard: Number(p.jaccard ?? 0).toFixed(2), lift: Number(p.lift).toFixed(2),
      });
      sec("correlate").insights.push({ text: t("insight.corrPartial", fmt(ps[0])), tone: "fact" });
      const cross = ps.filter((p) => refEntity(p.from) && refEntity(p.to) && refEntity(p.from) !== refEntity(p.to));
      if (cross.length) {
        sec("correlate").insights.push({
          text: t("insight.corrPartialCross", { n: cross.length, total: ps.length, ...fmt(cross[0]) }),
          tone: "pattern",
        });
      }
    }
  }

  let totalCross = 0;
  let topDriverName: string | null = null;
  let nCorroborated = 0;
  let nFound = 0;
  let entityFlow: { from: string; to: string }[] = [];
  if (done.has("causality") && s.causality) {
    const c = s.causality;
    const node = (name: string) => {
      const e = [...c.events, ...c.dropped].find((x) => x.name === name);
      return e ? `${dyn(e.entity)}${e.metric ? `·${dyn(e.metric)}` : ""}=${e.state}` : dyn(name);
    };
    const entityOf = (name: string) => [...c.events, ...c.dropped].find((x) => x.name === name)?.entity ?? name;
    const cross = c.found.filter((m) => [...m.triggers, ...m.cond.map(([x]) => x)].some((p) => entityOf(p) !== entityOf(m.child)));
    nFound = c.found.length;
    totalCross = cross.length;
    const causeCount = new Map<string, number>();
    for (const m of c.found) for (const p of [...m.triggers, ...m.cond.map(([x]) => x)]) causeCount.set(entityOf(p), (causeCount.get(entityOf(p)) ?? 0) + 1);
    topDriverName = [...causeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (c.found.length) {
      sec("causality").insights.push({
        text: t("insight.stateCausalSummary", { k: c.events.length, f: c.found.length, x: cross.length }),
        tone: "fact",
      });
      const top = cross[0] ?? c.found[0];
      const edge = top.params.edges?.[0];
      const cause = top.triggers[0] ?? top.cond[0]?.[0];
      sec("causality").insights.push({
        text: t(top.triggers.length ? "insight.stateCausalTopTrigger" : "insight.stateCausalTopCond", {
          cause: node(cause), effect: node(top.child), lag: edge?.delay_mean != null ? Math.round(edge.delay_mean) : "—",
          gain: top.gain.toFixed(1),
        }),
        tone: "highlight",
      });
      if (topDriverName)
        sec("causality").insights.push({ text: t("insight.stateCausalDriver", { name: dyn(topDriverName) }), tone: "pattern" });
      if (c.found.some((m) => m.params.corroborated != null)) {
        nCorroborated = c.found.filter((m) => m.params.corroborated).length;
        sec("causality").insights.push({
          text: t("insight.stateCausalCorroborated", { c: nCorroborated, f: c.found.length }),
          tone: "fact",
        });
      }
      entityFlow = cross.flatMap((m) =>
        [...m.triggers, ...m.cond.map(([x]) => x)].map((p) => ({ from: entityOf(p), to: entityOf(m.child) })))
        .filter((e) => e.from !== e.to);
    } else {
      sec("causality").insights.push({ text: t("insight.stateCausalEmpty"), tone: "fact" });
    }
  }

  const synthesis: Insight[] = [];

  if (s.causality && done.has("causality") && nFound > 0) {
    const flow = chainFromEdges(entityFlow);
    if (flow.length > 1)
      synthesis.push({ text: t("insight.synthEntityFlow", { chain: flow.map(dyn).join(" → ") }), tone: "pattern" });
    if (nCorroborated > 0)
      synthesis.push({ text: t("insight.synthCorroborated", { c: nCorroborated, f: nFound }), tone: "highlight" });
    if (detected && s.selection) {
      const k = detected.length;
      const total = (s.series ?? []).reduce((a, x) => a + x.channels.length, 0);
      synthesis.push({
        text: t("insight.synthThroughState", {
          k, total, states: detected.reduce((a, d) => a + d.num_states, 0), f: nFound, x: totalCross,
        }),
        tone: "highlight",
      });
    }
  }

  if (synthesis.length === 0)
    synthesis.push({
      text: done.has("correlate")
        ? t("insight.synthNextCausality")
        : t("insight.synthNextCorrelate"),
      tone: "pattern",
    });

  return {
    sections,
    synthesis,
    progress: { done: stages.filter((x) => done.has(x)).length, total: stages.length },
  };
}
