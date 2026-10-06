"""Stage 5 state causality: state segments as interval events, discovered with NIAGARA."""

from __future__ import annotations

import time

from ...core.registry import register
from ...core.types import AlignedStates, StateCausalResult, StateMechanism, StateSequence
from . import niagara
from .events import IntervalEvents
from .mechanism import CausalResult, Found, Mechanism



def _round(v):
    return round(v, 6) if isinstance(v, float) else v


def to_state_causal_result(r: CausalResult, full: IntervalEvents, kept: list[int], params: dict) -> StateCausalResult:
    """Engine result (by event index) -> unified contract (by name); ``full`` is the unfiltered event table."""
    E = r.events
    occ = [len(x) for x in full.starts]

    def ev(i: int) -> dict:
        return {"name": full.names[i], "series": full.series[i], "state": full.states[i], "n": occ[i]}

    mechs = []
    for i in sorted(r.found, key=lambda i: (-r.found[i].gain, E.names[i])):
        f = r.found[i]
        m = f.mech
        prm = {k: _round(v) for k, v in f.params.items() if k != "edges"}
        if "edges" in f.params:
            prm["edges"] = [{**{k: (round(v, 4) if isinstance(v, float) else v) for k, v in e.items()},
                             "parent": E.names[e["parent"]]} for e in f.params["edges"]]
        mechs.append(StateMechanism(
            child=E.names[m.child], triggers=[E.names[x] for x in m.triggers],
            cond=[(E.names[c], bool(neg)) for c, neg in m.cond], op=m.op, kind=m.kind,
            gain=round(float(f.gain), 2), params=prm,
            matches=[(E.names[p], int(a), int(b)) for p, a, b in f.matches],
        ))
    keep = set(kept)
    return StateCausalResult(
        engine=r.algo, events=[ev(i) for i in kept], dropped=[ev(i) for i in range(full.n) if i not in keep],
        mechanisms=mechs, params=params,
        meta={"runtime_s": round(r.runtime_s, 3), "n_fits": r.n_fits},
    )


def discover_state_causality(sequences: list[StateSequence], *, min_occ: int = 3,
                             allow_instant: bool = True, pair_top: int = 8,
                             skip_states: tuple[int, ...] = ()) -> StateCausalResult:
    """State sequences -> state causal mechanisms; events with fewer than ``min_occ`` occurrences are dropped."""
    params = {"engine": "niagara", "min_occ": min_occ, "allow_instant": allow_instant, "pair_top": pair_top}
    full = IntervalEvents.from_state_sequences(sequences, skip_states=skip_states)
    occ = [len(x) for x in full.starts]
    kept = [i for i in range(full.n) if occ[i] >= min_occ]
    E = full.subset(kept)
    if E.n < 2:
        empty = CausalResult("niagara", E, {}, 0.0, 0)
        return to_state_causal_result(empty, full, kept, params)
    t0 = time.perf_counter()
    r = niagara.discover(E, allow_instant=allow_instant, pair_top=pair_top)
    r.runtime_s = r.runtime_s or time.perf_counter() - t0
    return to_state_causal_result(r, full, kept, params)


@register("causality", "niagara")
class NiagaraDiscoverer:
    """NIAGARA state causality on state sequences."""

    def __init__(self, min_occ: int = 3, allow_instant: bool = True, pair_top: int = 8):
        self.kw = {"min_occ": min_occ, "allow_instant": allow_instant, "pair_top": pair_top}

    def discover(self, aligned: AlignedStates) -> StateCausalResult:
        return discover_state_causality(aligned.sequences, **self.kw)


__all__ = [
    "IntervalEvents", "CausalResult", "Found", "Mechanism", "niagara",
    "discover_state_causality", "to_state_causal_result", "NiagaraDiscoverer",
]
