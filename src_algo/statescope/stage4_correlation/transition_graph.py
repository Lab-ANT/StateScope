"""System-level state transition graph.

After alignment all series share one global vocabulary, so their transitions can be
aggregated into a directed graph: nodes are global states and edge i->j carries
P(next = j | current = i). The main line — each state's modal successor — traces how the
system usually evolves.

This characterises the alignment result rather than correlating series, so it is a plain
function rather than a registered CorrelationAnalyzer.
"""

from __future__ import annotations

import numpy as np

from statescope.core.types import AlignedStates


def build_transition_graph(aligned: AlignedStates) -> dict:
    """Aggregate segment transitions from all series into a transition-probability graph.

    Returns ``{states, nodes:[{state, occupancy, out}], edges:[{from,to,prob,count,main}]}``.
    ``occupancy`` is the total timesteps spent in that state across all series; ``edges``
    holds non-self transitions only, and ``main`` marks each state's modal successor.
    """
    states = aligned.global_states
    n = len(states)
    idx = {s: i for i, s in enumerate(states)}
    counts = np.zeros((n, n), dtype=float)
    occupancy = {s: 0 for s in states}

    for seq in aligned.sequences:
        labels = seq.labels
        for s in states:
            occupancy[s] += int(np.sum(labels == s))
        segs = seq.segments()
        for a, b in zip(segs[:-1], segs[1:]):
            if a.state != b.state:  # count real switches only
                counts[idx[a.state], idx[b.state]] += 1

    row = counts.sum(axis=1, keepdims=True)
    row_safe = np.where(row == 0, 1.0, row)
    prob = counts / row_safe

    # Main line: the most probable successor of every state with outgoing edges.
    main: set[tuple[int, int]] = set()
    for i in range(n):
        if counts[i].sum() > 0:
            main.add((i, int(np.argmax(counts[i]))))

    nodes = [
        {"state": s, "occupancy": occupancy[s], "out": int(counts[idx[s]].sum())}
        for s in states
    ]
    edges = []
    for i in range(n):
        for j in range(n):
            if counts[i, j] > 0:
                edges.append({
                    "from": states[i], "to": states[j],
                    "prob": round(float(prob[i, j]), 3),
                    "count": int(counts[i, j]),
                    "main": (i, j) in main,
                })
    edges.sort(key=lambda e: e["prob"], reverse=True)
    return {"states": states, "nodes": nodes, "edges": edges}
