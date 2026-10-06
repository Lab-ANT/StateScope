import type { StateCausalJson } from "./lib/stateCausal";

export type Stage = "data" | "select" | "detect" | "correlate" | "causality";

export interface DatasetStats {
  n_series: number;
  length_min: number;
  length_max: number;
  total_samples: number;
  n_channels: number;
  channel_names: string[];
  n_states: number | null;
  has_ground_truth: boolean;
  state_names?: Record<string, string> | null;
  extra?: Record<string, number>;
}

export interface DatasetInfo {
  id: string;
  label: string;
  group: string; // "synthetic" | "public"
  source: string;
  background: string;
  available: boolean;
  note: string;
  tunable: boolean;
}

export interface Meta {
  session_id: string;
  completed: Stage[];
  params: Record<string, number | string | null>;
  n_channels: number;
  T: number;
  dataset?: string;
  true_states: number[];
  true_state_names?: Record<string, string>;
  has_ground_truth?: boolean;
  stats?: DatasetStats;
  info?: DatasetInfo;
  metric_detect_defaults?: Partial<DetectDefaults> | null;
}

export interface DetectDefaults {
  win_size: number;
  step: number;
  nb_steps: number;
  n_states: number | null;
  min_seg_len: number;
}

export interface Segment {
  start: number;
  end: number;
  state: number;
  confidence?: number; // mean detector confidence; absent on manual segments
}

export interface Channel {
  name: string;
  values: number[];
  selected: boolean;
}

export interface SeriesData {
  name: string;
  channels: Channel[];
}

export interface Selection {
  selector: string; // issd | weak | unlabeled | manual
  qf: number[];
  cf: number[];
  picks: Record<string, string[]>; // selected metrics per entity
  ranking: Record<string, { name: string; score: number }[]>; // per entity, descending
}

export interface Detected {
  name: string; // "entity.metric"
  entity: string;
  metric: string;
  num_states: number;
  segments: Segment[];
}

export interface Correlation {
  kind: string;
  matrix: number[][] | null;
  labels: string[] | null;
  pairs: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

export type CausalityResult = StateCausalJson;
