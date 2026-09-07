// Global knowledge: deterministically distils the five stage outputs into an accumulating
// picture. Pure frontend and pure functions over results the stages already computed.
// Each stage yields a few insights; a synthesis pass then cross-checks them.

import type {
  Aligned, ClusterResult, Correlation, Detected, Meta, SeriesData, Selection, Stage,
} from "../types";
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
  detected: Detected | Detected[] | null;
  aligned: Aligned | null;
  correlations: Record<string, Correlation> | null;
  causality: ClusterResult | null;
}

const STAGE_KEY: Record<Stage, Key> = {
  data: "stage.data", select: "stage.select", detect: "stage.detect", align: "stage.align",
  correlate: "stage.correlate", causality: "stage.causality",
};
const STAGE_ORDER: Stage[] = ["data", "select", "detect", "align", "correlate", "causality"];

// Allen interval relations; the strings live under allen.* in the dictionaries.
const ALLEN = new Set([
  "before", "meets", "overlaps", "overlapped_by", "during", "contains",
  "starts", "started_by", "finishes", "finished_by", "equals", "after", "met_by",
]);
const allen = (rel: string): string => (ALLEN.has(rel) ? t(`allen.${rel}` as Key) : rel);

interface LeadLag { leader: string; follower: string; lag: number; nmi: number; }

// Derive a linear host order from the leader/follower edges, by in-degree. Deterministic.
function chainFromEdges(rawEdges: { from: string; to: string }[]): string[] {
  // Deduplicate first: causal rules often repeat an edge, which would skew the in-degrees.
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
  // Repeatedly take the unvisited node of least in-degree, breaking ties lexicographically.
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
  const detected = Array.isArray(s.detected) ? s.detected : s.detected ? [s.detected] : null;
  const sections: KnowledgeSection[] = STAGE_ORDER.map((stage) => ({
    stage, label: t(STAGE_KEY[stage]), done: done.has(stage), insights: [],
  }));
  const sec = (stage: Stage) => sections.find((x) => x.stage === stage)!;

  // ── Stage 1: data import ──
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

  // ── Stage 2: metric selection ──
  if (done.has("select") && s.selection) {
    const total = s.meta?.stats?.n_channels ?? s.series?.[0]?.channels.length ?? 0;
    const k = s.selection.names.length;
    const dropped = Math.max(0, total - k);
    sec("select").insights.push({
      text: t("insight.selectSummary", {
        total, k, selector: s.selection.selector, names: dynList(s.selection.names),
      }),
      tone: "fact",
    });
    if (dropped > 0)
      sec("select").insights.push({
        text: t("insight.selectDropped", { dropped, k }),
        tone: "pattern",
      });
  }

  // ── Stage 3: state detection ──
  if (done.has("detect") && detected) {
    const counts = detected.map((d) => d.num_states);
    const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    sec("detect").insights.push({
      text: t("insight.detectRange", {
        min: Math.min(...counts), max: Math.max(...counts), avg: avg.toFixed(1),
      }),
      tone: "fact",
    });
    const aris = detected.filter((d) => d.ari != null).map((d) => d.ari as number);
    if (aris.length)
      sec("detect").insights.push({
        text: t("insight.detectAri", {
          ari: (aris.reduce((a, b) => a + b, 0) / aris.length).toFixed(2),
        }),
        tone: "fact",
      });
    sec("detect").insights.push({ text: t("insight.detectLocal"), tone: "pattern" });
  }

  // ── Stage 1.3: state alignment ──
  let mainChain: number[] = [];
  if (done.has("align") && s.aligned) {
    const g = s.aligned.global_states;
    sec("align").insights.push({
      text: t("insight.alignVocab", { n: g.length, states: dynList(g.map((x) => `S${x}`)) }),
      tone: "fact",
    });
    const tg = s.aligned.transition_graph;
    if (tg && tg.edges.length) {
      // Walk the main-line edges to get the evolution backbone.
      const mainNext = new Map<number, number>();
      for (const e of tg.edges) if (e.main) mainNext.set(e.from, e.to);
      const start = tg.nodes.slice().sort((a, b) => b.occupancy - a.occupancy)[0]?.state ?? tg.states[0];
      const visited = new Set<number>();
      let cur: number | undefined = start;
      while (cur != null && !visited.has(cur)) { mainChain.push(cur); visited.add(cur); cur = mainNext.get(cur); }
      if (mainChain.length > 1)
        sec("align").insights.push({
          text: t("insight.alignChain", { chain: mainChain.map((x) => `S${x}`).join(" → ") }),
          tone: "pattern",
        });
    }
  }

  // ── Stage 4: state correlation ──
  let leadLags: LeadLag[] = [];
  if (done.has("correlate") && s.correlations) {
    const tl = s.correlations.time_lagged;
    if (tl?.pairs?.length) {
      leadLags = (tl.pairs as unknown as LeadLag[]).filter((p) => p.leader !== p.follower);
      const top = leadLags.slice().sort((a, b) => b.nmi - a.nmi).slice(0, 3);
      for (const p of top)
        sec("correlate").insights.push({
          text: t("insight.corrLeadLag", {
            leader: dyn(p.leader), follower: dyn(p.follower), lag: p.lag, nmi: p.nmi.toFixed(2),
          }),
          tone: "fact",
        });
    }
    const overall = s.correlations.overall;
    if (overall?.matrix) {
      const m = overall.matrix;
      let sum = 0, cnt = 0;
      for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) { sum += m[i][j]; cnt++; }
      if (cnt)
        sec("correlate").insights.push({
          text: t("insight.corrOverall", { nmi: (sum / cnt).toFixed(2) }),
          tone: "pattern",
        });
    }
    const partial = s.correlations.partial;
    if (partial?.pairs?.length) {
      const p = partial.pairs[0] as { from: string; to: string; lift: number };
      sec("correlate").insights.push({
        text: t("insight.corrPartial", {
          from: dyn(p.from), to: dyn(p.to), lift: Number(p.lift).toFixed(2),
        }),
        tone: "fact",
      });
    }
    const structural = s.correlations.structural;
    if (structural?.pairs?.length) {
      const p = structural.pairs[0] as { from: string; to: string; state: number; relation: string };
      sec("correlate").insights.push({
        text: t("insight.corrStructural", {
          state: p.state, from: dyn(p.from), to: dyn(p.to), relation: allen(p.relation),
        }),
        tone: "fact",
      });
    }
  }

  // ── Stage 5: cluster regimes + causality ──
  let totalCross = 0;
  let topDriverName: string | null = null;
  if (done.has("causality") && s.causality) {
    const driver = new Map<string, number>();
    const driven = new Map<string, number>();
    let best = { state: -1, n: 0 };
    for (const g of s.causality.graphs) {
      const cross = g.edges.filter((e) => e.src !== e.dst);
      totalCross += cross.length;
      if (cross.length > best.n) best = { state: g.state, n: cross.length };
      for (const e of cross) {
        driver.set(e.src, (driver.get(e.src) ?? 0) + 1);
        driven.set(e.dst, (driven.get(e.dst) ?? 0) + 1);
      }
    }
    const topDriver = [...driver.entries()].sort((a, b) => b[1] - a[1])[0];
    const topDriven = [...driven.entries()].sort((a, b) => b[1] - a[1])[0];
    topDriverName = topDriver?.[0] ?? null;
    const nReg = s.causality.regimes.states.length;
    if (totalCross > 0) {
      sec("causality").insights.push({
        text: t("insight.causalSummary", { nRegimes: nReg, nEdges: totalCross }),
        tone: "fact",
      });
      if (topDriver)
        sec("causality").insights.push({
          text: t("insight.causalDriver", {
            driver: dyn(topDriver[0]),
            n: topDriver[1],
            driven: topDriven ? t("insight.causalDrivenTail", { name: dyn(topDriven[0]) }) : "",
          }),
          tone: "pattern",
        });
      if (best.n > 0)
        sec("causality").insights.push({
          text: t("insight.causalDensest", { state: best.state, n: best.n }),
          tone: "fact",
        });
      sec("causality").insights.push({ text: t("insight.causalSwitch"), tone: "pattern" });
    } else {
      sec("causality").insights.push({ text: t("insight.causalEmpty"), tone: "fact" });
    }
  }

  // ── Synthesis across stages ──
  const synthesis: Insight[] = [];
  const leadChain = leadLags.length ? chainFromEdges(leadLags.map((p) => ({ from: p.leader, to: p.follower }))) : [];

  if (leadChain.length > 1)
    synthesis.push({
      text: t("insight.synthChain", { chain: leadChain.map(dyn).join(" → ") }),
      tone: "pattern",
    });

  // The macro cascade (stage 4, across hosts) and the micro mechanism (stage 5, channels
  // inside a state) complement each other.
  if (leadChain.length > 1 && totalCross > 0) {
    const avgLag = leadLags.length
      ? Math.round(leadLags.reduce((a, b) => a + b.lag, 0) / leadLags.length)
      : null;
    synthesis.push({
      text: t("insight.synthKey", {
        chain: leadChain.map(dyn).join(" → "),
        lag: avgLag != null ? t("insight.synthKeyLag", { lag: avgLag }) : "",
        driver: topDriverName ? t("insight.synthKeyDriver", { name: dyn(topDriverName) }) : "",
      }),
      tone: "highlight",
    });
  }

  // Metrics -> states -> channel causality, end to end.
  if (done.has("select") && done.has("causality") && s.selection && totalCross > 0) {
    const total = s.meta?.stats?.n_channels ?? 0;
    synthesis.push({
      text: t("insight.synthThrough", { k: s.selection.names.length, total }),
      tone: "highlight",
    });
  }

  if (mainChain.length > 1 && done.has("causality"))
    synthesis.push({
      text: t("insight.synthMainChain", { chain: mainChain.map((x) => `S${x}`).join("→") }),
      tone: "pattern",
    });

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
    progress: { done: STAGE_ORDER.filter((x) => done.has(x)).length, total: STAGE_ORDER.length },
  };
}
