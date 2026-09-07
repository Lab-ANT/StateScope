// Typed client for the session API: one call per stage.

import type { Aligned, ClusterResult, Correlation, DatasetInfo, Detected, Meta, Segment, SeriesData, Selection, StateProfile } from "./types";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(detail.detail || `${url} -> ${res.status}`);
  }
  return res.json();
}

export interface DataParams {
  dataset: string;
  n_series: number;
  lag: number;
  seg_len: number;
  n_useful: number;
  n_noise: number;
  seed: number;
  scenario?: string | null;
}

export interface Snapshot {
  meta: Meta;
  series: SeriesData[];
  selection?: Selection;
  detected?: Detected[];
  aligned?: Aligned;
  state_profiles?: StateProfile[];
  correlations?: Record<string, Correlation>;
  causality?: ClusterResult;
}

export const api = {
  datasets: () => get<{ datasets: DatasetInfo[] }>("/api/datasets"),

  getSession: (sid: string) => get<Snapshot>(`/api/sessions/${sid}`),

  createSession: (p: DataParams) =>
    post<{ meta: Meta; series: SeriesData[]; ground_truth: { name: string; segments: any }[] }>(
      "/api/sessions",
      p
    ),

  select: (sid: string, p: { selector: string; K: number }) =>
    post<{ meta: Meta; selection: Selection; series: SeriesData[] }>(`/api/sessions/${sid}/select`, p),

  detect: (sid: string, p: { win_size: number; step: number; nb_steps: number; n_states: number }) =>
    post<{ meta: Meta; detected: Detected[] }>(`/api/sessions/${sid}/detect`, p),

  // Manual calibration: submit the full segment list of edited series only. Alignment and
  // everything downstream are invalidated on success.
  calibrate: (sid: string, p: { series: { name: string; segments: Segment[] }[] }) =>
    post<{ meta: Meta; detected: Detected[] }>(`/api/sessions/${sid}/detect/calibrate`, p),

  align: (sid: string) =>
    post<{ meta: Meta; aligned: Aligned; state_profiles: StateProfile[] }>(`/api/sessions/${sid}/align`),

  correlate: (sid: string, p: { kinds: string[]; tolerance: number; max_lag: number; min_lift: number }) =>
    post<{ meta: Meta; correlations: Record<string, Correlation> }>(`/api/sessions/${sid}/correlate`, p),

  causality: (sid: string, p: { n_states: number; tau_max: number; pc_alpha: number; max_edges_per_regime: number }) =>
    post<{ meta: Meta; causality: ClusterResult }>(`/api/sessions/${sid}/causality`, p),
};
