"""Serialise the shared data contracts into JSON for the frontend.

The engine only produces statescope core types; this presentation layer downsamples them
where needed and emits compact JSON for the per-stage views.
"""

from __future__ import annotations

import numpy as np

from statescope.core.types import (
    AlignedStates,
    CorrelationResult,
    MTS,
    StateSequence,
)


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


def series_json(series: list[MTS], selected: list[int] | None, max_points: int) -> list[dict]:
    sel = set(selected or [])
    return [
        {
            "name": s.name,
            "channels": [
                {"name": nm, "values": downsample(s.data[:, c], max_points), "selected": c in sel}
                for c, nm in enumerate(s.channel_names)
            ],
        }
        for s in series
    ]


def detected_json(detected: list[StateSequence], truth: list[StateSequence] | None) -> list[dict]:
    from sklearn.metrics import adjusted_rand_score

    out = []
    for i, d in enumerate(detected):
        item = {"name": d.name, "num_states": d.num_states, "segments": segments_json(d)}
        if truth is not None:
            item["ari"] = round(float(adjusted_rand_score(truth[i].labels[: d.T], d.labels)), 3)
        out.append(item)
    return out


def aligned_json(aligned: AlignedStates) -> dict:
    from statescope.stage4_correlation.transition_graph import build_transition_graph

    return {
        "global_states": aligned.global_states,
        "sequences": [{"name": s.name, "segments": segments_json(s)} for s in aligned.sequences],
        "transition_graph": build_transition_graph(aligned),
    }


def _resample(x: np.ndarray, n: int) -> np.ndarray:
    """Linearly resample a slice of any length to n points."""
    if len(x) == n:
        return x.astype(float)
    if len(x) < 2:
        return np.full(n, float(x[0]) if len(x) else 0.0)
    xp = np.linspace(0.0, 1.0, len(x))
    return np.interp(np.linspace(0.0, 1.0, n), xp, x.astype(float))


def state_profiles_json(reduced_series: list[MTS], aligned: AlignedStates, n_points: int = 48) -> list[dict]:
    """Typical signal per global state: average every segment of that state across all
    series, resampled per selected channel.

    Feeds the state legend in the alignment stage. ``reduced_series`` holds the raw series
    already reduced to the selected channels, matching ``aligned.sequences`` by name.
    """
    if not reduced_series:
        return []
    ch_names = list(reduced_series[0].channel_names or [])
    C = len(ch_names)
    states = aligned.global_states
    acc: dict[int, list[list[np.ndarray]]] = {g: [[] for _ in range(C)] for g in states}
    for mts, seq in zip(reduced_series, aligned.sequences):
        data = np.asarray(mts.data, dtype=float)
        for seg in seq.segments():
            if seg.end - seg.start < 2 or seg.state not in acc:
                continue
            for c in range(C):
                acc[seg.state][c].append(_resample(data[seg.start:seg.end, c], n_points))
    out: list[dict] = []
    for g in states:
        channels = []
        for c in range(C):
            segs = acc[g][c]
            prof = np.mean(np.stack(segs), axis=0) if segs else np.zeros(n_points)
            channels.append({"name": ch_names[c], "values": [round(float(v), 4) for v in prof]})
        out.append({"state": int(g), "n_segments": len(acc[g][0]) if C else 0, "channels": channels})
    return out


def correlation_json(res: CorrelationResult) -> dict:
    return {
        "kind": res.kind,
        "matrix": None if res.matrix is None else np.round(res.matrix, 3).tolist(),
        "labels": res.labels,
        "pairs": res.pairs,
        "meta": res.meta,
    }


def _edge_src_dst(e) -> tuple:
    """Normalise one topology edge into ``(src, dst)``.

    Two edge formats exist and both are cached in the npz artefacts:
      * PetShop ``dependency_graph``: ``{"src": a, "dst": b}`` dicts;
      * WADI ``flow_topology``: ``[a, b]`` pairs.
    Normalising here keeps the rest of the layer format-agnostic.
    """
    if isinstance(e, dict):
        return e.get("src"), e.get("dst")
    if isinstance(e, (list, tuple)) and len(e) >= 2:
        return e[0], e[1]
    return None, None


def gt_topology_edges(extra: dict, pods: list[str]) -> dict:
    """Extract service/phase-level reference topology edges from the dataset extras,
    restricted to the pods present in the cluster.

    Used as a reference overlay in the causality stage:
      * PetShop ``dependency_graph`` (call graph, A->B means A calls B) -> ``kind="call_graph"``;
      * WADI ``flow_topology`` (water flow P1->P2->P3) -> ``kind="flow"``;
      * otherwise ``edges=[]`` and ``kind=None``.
    The PetShop call graph is a prior, not causal ground truth.
    """
    pset = set(pods)
    dep = extra.get("dependency_graph")
    if dep:
        edges = sorted({(s, d) for s, d in map(_edge_src_dst, dep)
                        if s in pset and d in pset and s != d})
        return {"kind": "call_graph", "directed": True,
                "note": "Service call graph (A->B means A calls B); a prior, not causal "
                        "ground truth",
                "edges": [{"src": s, "dst": d} for s, d in edges]}
    flow = extra.get("flow_topology")
    if flow:
        edges = [{"src": s, "dst": d} for s, d in map(_edge_src_dst, flow)
                 if s in pset and d in pset]
        return {"kind": "flow", "directed": True,
                "note": "Physical water-flow direction (directed ground truth)", "edges": edges}
    pod_node = extra.get("pod_node")
    if pod_node:
        # Pod-to-node placement: pods on the same node share hardware, so resource contention
        # should couple them. Undirected reference.
        node_of = {e["pod"]: e["node"] for e in pod_node if e.get("pod") in pset}
        names = sorted(node_of)
        edges = [{"src": a, "dst": b} for i, a in enumerate(names) for b in names[i + 1:]
                 if node_of[a] == node_of[b]]
        return {"kind": "colocation", "directed": False,
                "note": "Pod pairs on the same physical node (shared CPU/memory; resource "
                        "contention should cause coupling)", "edges": edges}
    return {"kind": None, "directed": False,
            "note": "This dataset has no ground-truth topology reference", "edges": []}


def cluster_json(r, extra: dict | None = None) -> dict:
    """Cluster regime + causality result -> JSON: regime segments, per-regime channel graphs
    and pod grouping.

    ``extra`` optionally supplies the reference topology edges (``gt_topology``).
    """
    seq = StateSequence(np.asarray(r.regimes).astype(int), name="cluster")
    out = {
        "engine": r.engine,
        "regimes": {
            "T": int(len(r.regimes)),
            "segments": segments_json(seq),
            "states": sorted({int(x) for x in np.asarray(r.regimes).tolist()}),
        },
        "graphs": [
            {
                "state": g.state, "n_samples": g.n_samples, "var_names": g.var_names,
                "edges": [
                    {"src": e.src, "dst": e.dst, "lag": e.lag,
                     "strength": e.strength, "link_type": e.link_type}
                    for e in g.edges
                ],
            }
            for g in r.graphs
        ],
        "var_names": r.var_names,
        "pod_of": r.pod_of,
        "kind_of": r.kind_of,
        "pods": r.pods,
        "params": r.params,
        "meta": r.meta,
    }
    out["gt_topology"] = gt_topology_edges(extra or {}, list(r.pods))
    return out


