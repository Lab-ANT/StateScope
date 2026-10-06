"""Serialise core types into compact (downsampled) JSON for the frontend."""

from __future__ import annotations

import numpy as np

from statescope.core.types import CorrelationResult, MTS, StateCausalResult, StateSequence


def downsample(values: np.ndarray, max_points: int) -> list[float]:
    """Even-stride downsample to at most max_points points, for charting."""
    if len(values) <= max_points:
        return [round(float(v), 4) for v in values]
    stride = int(np.ceil(len(values) / max_points))
    return [round(float(v), 4) for v in values[::stride]]


def segments_json(seq: StateSequence) -> list[dict]:
    out: list[dict] = []
    for s in seq.segments():
        item: dict = {"start": s.start, "end": s.end, "state": s.state}
        if s.confidence is not None:  # mean confidence; flags low-confidence segments
            item["confidence"] = round(float(s.confidence), 3)
        out.append(item)
    return out


def series_json(series: list[MTS], picks: dict[str, list[int]] | None, max_points: int) -> list[dict]:
    """Raw series (downsampled), with each channel marked if it is in ``picks``."""
    def sel_of(s: MTS) -> set:
        return set((picks or {}).get(s.name, []))

    return [
        {
            "name": s.name,
            "channels": [
                {"name": nm, "values": downsample(s.data[:, c], max_points), "selected": c in sel_of(s)}
                for c, nm in enumerate(s.channel_names)
            ],
        }
        for s in series
    ]


def detected_json(detected: list[StateSequence], owner: dict[str, tuple[str, str]]) -> list[dict]:
    """Per-metric detection result; ``owner`` maps series -> (entity, metric)."""
    out = []
    for d in detected:
        ent, met = owner.get(d.name, (d.name, ""))
        out.append({"name": d.name, "entity": ent, "metric": met, "num_states": d.num_states,
                    "segments": segments_json(d)})
    return out


def correlation_json(res: CorrelationResult) -> dict:
    return {
        "kind": res.kind,
        "matrix": None if res.matrix is None else np.round(res.matrix, 3).tolist(),
        "labels": res.labels,
        "pairs": res.pairs,
        "meta": res.meta,
    }


def state_causal_json(res: StateCausalResult, owner: dict[str, tuple[str, str]]) -> dict:
    """State causality -> JSON; ``owner`` maps series -> (entity, metric)."""

    def ev(e: dict) -> dict:
        ent, met = owner.get(e["series"], (e["series"], ""))
        return {"name": e["name"], "series": e["series"], "entity": ent, "metric": met,
                "state": int(e["state"]), "n": int(e["n"])}

    return {
        "algo": res.engine,
        "events": [ev(e) for e in res.events],
        "dropped": [ev(e) for e in res.dropped],
        "found": [
            {"child": m.child, "triggers": list(m.triggers), "cond": [[c, bool(n)] for c, n in m.cond],
             "op": m.op, "kind": m.kind, "gain": m.gain, "params": m.params,
             "matches": [[p, int(a), int(b)] for p, a, b in m.matches]}
            for m in res.mechanisms
        ],
        "params": res.params,
        "n_fits": int(res.meta.get("n_fits", 0)),
        "runtime_s": float(res.meta.get("runtime_s", 0.0)),
    }

