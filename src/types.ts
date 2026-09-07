// Types mirroring the JSON returned by the src_api endpoints.

export type Stage = "data" | "select" | "detect" | "align" | "correlate" | "causality";

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

export interface DatasetMeta {
  id: string;
  label: string;
  group: string;
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
  scenario?: string | null;
  true_states: number[];
  true_state_names?: Record<string, string>;
  has_ground_truth?: boolean;
  stats?: DatasetStats;
  info?: DatasetMeta;
}

// One dataset entry from the catalog (/api/datasets).
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

export interface Segment {
  start: number;
  end: number;
  state: number;
  confidence?: number; // mean detector confidence; absent on manual and ground-truth segments
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
  indices: number[];
  names: string[];
  selector: string;
  qf: number[];
  cf: number[];
}

export interface Detected {
  name: string;
  num_states: number;
  ari?: number;
  segments: Segment[];
}

export interface TransitionGraph {
  states: number[];
  nodes: { state: number; occupancy: number; out: number }[];
  edges: { from: number; to: number; prob: number; count: number; main: boolean }[];
}

export interface Aligned {
  global_states: number[];
  sequences: { name: string; segments: Segment[] }[];
  transition_graph: TransitionGraph;
}

// Typical signal per global state: every segment of that state, averaged per channel.
export interface StateProfile {
  state: number;
  n_segments: number;
  channels: { name: string; values: number[] }[];
}

export interface LeadLagPair {
  leader: string;
  follower: string;
  lag: number;
  nmi: number;
}

// state_link (Corr_Partial, StaCo eq. 4+5): a directed service-state influence edge.
export interface StateLink {
  from: string; // "svc:Sa", for display
  to: string; // "svc:Sb"
  from_series: string;
  from_state: number;
  to_series: string;
  to_state: number;
  lag: number; // steps by which `from` leads `to`
  score: number; // Jaccard overlap, 0..1
  support: number; // co-occurrence share, p(1,1)
  type: "synchronous" | "lead-lag";
}

export interface Correlation {
  kind: string;
  matrix: number[][] | null;
  labels: string[] | null;
  pairs: Record<string, unknown>[];
  meta: Record<string, unknown>;
}

// Channel-level causal edge (PCMCI+).

export interface PCMCIEdge {
  src: string;
  dst: string;
  lag: number;
  strength: number;
  link_type: string;
  status?: "tp" | "fp" | "self" | "unknown"; // vs ground truth, when available
}

// Cluster-level regimes + causality.

export interface ClusterGraph {
  state: number; // regime id
  n_samples: number;
  var_names: string[];
  edges: PCMCIEdge[];
}

// Reference topology at service/phase level: PetShop call graph or WADI flow; kind=null if none.
export interface GtTopology {
  kind: "call_graph" | "flow" | "colocation" | null;
  directed: boolean;
  note: string;
  edges: { src: string; dst: string }[]; // edges between pods
}

export interface ClusterResult {
  engine: string;
  regimes: { T: number; segments: Segment[]; states: number[] };
  graphs: ClusterGraph[];
  var_names: string[]; // "pod:metric"
  pod_of: string[]; // owning pod, parallel to var_names
  kind_of: string[]; // metric kind, parallel to var_names
  pods: string[];
  params: Record<string, number | string>;
  meta: { T: number; N: number; T_raw?: number; max_len?: number; stride?: number };
  gt_topology?: GtTopology; // reference topology overlay
}

// Aggregated session view; stage outputs fill in as they run.
export interface SessionView {
  meta: Meta;
  series: SeriesData[];
  groundTruth?: { name: string; segments: Segment[] }[];
  selection?: Selection;
  detected?: Detected[];
  aligned?: Aligned;
  correlations?: Record<string, Correlation>;
  causality?: ClusterResult;
}
