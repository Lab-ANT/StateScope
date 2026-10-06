
export interface CausalEvent {
  name: string; // "<entity>.<metric>:<state>"
  series: string; // "<entity>.<metric>"
  entity: string;
  metric: string;
  state: number;
  n: number; // occurrence count
}

export interface CausalMech {
  child: string;
  triggers: string[];
  cond: [string, boolean][];
  op: "and" | "or";
  kind: string;
  gain: number;
  params: {
    // "end" = triggered when the cause leaves its state
    edges?: { parent: string; alpha: number; delay_mean: number | null; n_matched: number; at?: "start" | "end" }[];
    corroborated?: boolean; // every parent co-occurs with the effect in stage-4 partial correlation
  };
  matches: [string, number, number][]; // [parent event, parent start, child start]
}

// A two-parent mechanism splits into two edges sharing the gain.
export interface StateEdge {
  cause: CausalEvent;
  effect: CausalEvent;
  role: "trigger" | "cond" | "cond_neg";
  gain: number;
  lag: number | null; // mean trigger lag
  atEnd: boolean; // triggered at the end of the cause state
  mech: CausalMech;
}

export function stateEdges(r: Pick<StateCausalJson, "events" | "dropped" | "found">): StateEdge[] {
  const byName = new Map([...r.events, ...r.dropped].map((e) => [e.name, e]));
  const out: StateEdge[] = [];
  for (const m of r.found) {
    const effect = byName.get(m.child);
    if (!effect) continue;
    for (const p of m.triggers) {
      const cause = byName.get(p);
      const e = m.params.edges?.find((x) => x.parent === p);
      if (cause) out.push({ cause, effect, role: "trigger", gain: m.gain, lag: e?.delay_mean ?? null, atEnd: e?.at === "end", mech: m });
    }
    for (const [p, neg] of m.cond) {
      const cause = byName.get(p);
      if (cause) out.push({ cause, effect, role: neg ? "cond_neg" : "cond", gain: m.gain, lag: null, atEnd: false, mech: m });
    }
  }
  return out;
}

export interface StateCausalJson {
  algo: string;
  events: CausalEvent[];
  dropped: CausalEvent[];
  found: CausalMech[];
  params?: Record<string, unknown>;
  n_fits: number;
  runtime_s: number;
}
