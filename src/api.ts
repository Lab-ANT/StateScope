import type { CausalityResult, Correlation, DatasetInfo, Detected, Meta, Segment, SeriesData, Selection } from "./types";

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

// NDJSON stream: progress lines go to onItem, "done" is the result, "error" throws.
async function postStream<T, I>(url: string, body: unknown, onItem: (item: I) => void): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(detail.detail || `${url} -> ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "error") throw new Error(msg.detail);
      if (msg.type === "done") return msg as T;
      onItem(msg as I);
    }
    if (done) throw new Error(`${url}: stream ended without result`);
  }
}

export type DetectProgress =
  | { type: "plan"; items: { entity: string; metric: string }[] }
  | { type: "metric"; done: number; total: number; detected: Detected };

export interface DataParams {
  dataset: string;
  n_series: number;
  lag: number;
  seg_len: number;
  n_useful: number;
  n_noise: number;
  seed: number;
}

export interface Snapshot {
  meta: Meta;
  series: SeriesData[];
  selection?: Selection;
  detected?: Detected[];
  correlations?: Record<string, Correlation>;
  causality?: CausalityResult;
}

export interface SelectParams {
  selector: string;
  K: number;
  picks?: Record<string, string[]>;
}

export interface DetectParams {
  win_size: number;
  step: number;
  nb_steps: number;
  n_states: number; // 0 = auto
  min_seg_len: number;
}

type Detection = { meta: Meta; detected: Detected[] };

export const api = {
  datasets: () => get<{ datasets: DatasetInfo[] }>("/api/datasets"),

  getSession: (sid: string) => get<Snapshot>(`/api/sessions/${sid}`),

  createSession: (p: DataParams) => post<{ meta: Meta; series: SeriesData[] }>("/api/sessions", p),

  select: (sid: string, p: SelectParams) =>
    post<{ meta: Meta; selection: Selection; series: SeriesData[] }>(`/api/sessions/${sid}/select`, p),

  detectStream: (sid: string, p: DetectParams, onProgress: (m: DetectProgress) => void) =>
    postStream<Detection, DetectProgress>(`/api/sessions/${sid}/detect/stream`, p, onProgress),

  // Submits the full segment lists of edited series; invalidates correlation and causality.
  calibrate: (sid: string, p: { series: { name: string; segments: Segment[] }[] }) =>
    post<Detection>(`/api/sessions/${sid}/detect/calibrate`, p),

  correlate: (sid: string, p: { min_lift: number }) =>
    post<{ meta: Meta; correlations: Record<string, Correlation> }>(`/api/sessions/${sid}/correlate`, p),

  causality: (sid: string, p: { min_occ: number }) =>
    post<{ meta: Meta; causality: CausalityResult }>(`/api/sessions/${sid}/causality`, p),
};
