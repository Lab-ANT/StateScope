"""Interval events (each series state is an event, each segment an occurrence) and interval set ops.

Interval sets are ``(k, 2)`` int arrays of sorted, disjoint half-open ``[s, e)`` intervals.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ...core.types import StateSequence

Region = np.ndarray  # (k, 2) int, sorted and disjoint [s, e)


def _empty() -> Region:
    return np.zeros((0, 2), dtype=np.int64)


def normalize(iv: Region) -> Region:
    """Sort and merge overlapping / adjacent intervals."""
    iv = np.asarray(iv, dtype=np.int64).reshape(-1, 2)
    iv = iv[iv[:, 1] > iv[:, 0]]
    if len(iv) == 0:
        return _empty()
    iv = iv[np.argsort(iv[:, 0], kind="stable")]
    out = [list(iv[0])]
    for s, e in iv[1:]:
        if s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return np.asarray(out, dtype=np.int64)


def measure(r: Region) -> int:
    return int((r[:, 1] - r[:, 0]).sum()) if len(r) else 0


def complement(r: Region, T: int) -> Region:
    if len(r) == 0:
        return np.asarray([[0, T]], dtype=np.int64)
    bounds = np.concatenate([[0], r.ravel(), [T]]).reshape(-1, 2)
    return normalize(bounds)


def intersect(a: Region, b: Region) -> Region:
    out, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        s, e = max(a[i, 0], b[j, 0]), min(a[i, 1], b[j, 1])
        if s < e:
            out.append((s, e))
        if a[i, 1] <= b[j, 1]:
            i += 1
        else:
            j += 1
    return np.asarray(out, dtype=np.int64).reshape(-1, 2)


def union(a: Region, b: Region) -> Region:
    return normalize(np.concatenate([a, b]))


def contains(r: Region, t: np.ndarray) -> np.ndarray:
    """Pointwise test whether t lies in interval set r (vectorised, binary search)."""
    t = np.asarray(t)
    if len(r) == 0:
        return np.zeros(t.shape, dtype=bool)
    i = np.searchsorted(r[:, 0], t, side="right") - 1
    ok = i >= 0
    res = np.zeros(t.shape, dtype=bool)
    res[ok] = t[ok] < r[i[ok], 1]
    return res


def region_of_labels(labels: np.ndarray, state: int) -> Region:
    """Interval set occupied by ``state`` in per-timestep labels."""
    mask = np.concatenate([[False], np.asarray(labels) == state, [False]])
    edges = np.flatnonzero(np.diff(mask.astype(np.int8)))
    return edges.reshape(-1, 2).astype(np.int64)


@dataclass
class IntervalEvents:
    """A set of interval events; events of the same series are exclusive and never parents of each other."""

    names: list[str]
    series: list[str]
    states: list[int]
    starts: list[np.ndarray]
    ends: list[np.ndarray]
    on: list[Region]
    T: int

    @property
    def n(self) -> int:
        return len(self.names)

    def index(self, name: str) -> int:
        return self.names.index(name)

    def subset(self, keep: list[int]) -> "IntervalEvents":
        """Keep only events whose index is in ``keep``."""
        pick = lambda xs: [xs[i] for i in keep]  # noqa: E731
        return IntervalEvents(pick(self.names), pick(self.series), pick(self.states), pick(self.starts),
                              pick(self.ends), pick(self.on), self.T)

    def allowed_parent(self, parent: int, child: int, same_series: bool = False) -> bool:
        return parent != child and (same_series or self.series[parent] != self.series[child])

    @classmethod
    def from_state_sequences(cls, seqs: list[StateSequence], skip_states: tuple[int, ...] = ()) -> "IntervalEvents":
        """Each state of each series (except ``skip_states``, e.g. baseline state 0) becomes an event."""
        T = max(s.T for s in seqs)
        names, series, states, starts, ends, on = [], [], [], [], [], []
        for seq in seqs:
            segs = seq.segments()
            for st in sorted({g.state for g in segs}):
                if st in skip_states:
                    continue
                iv = np.asarray([(g.start, g.end) for g in segs if g.state == st], dtype=np.int64)
                names.append(f"{seq.name}:{st}")
                series.append(seq.name)
                states.append(int(st))
                starts.append(iv[:, 0].copy())
                ends.append(iv[:, 1].copy())
                on.append(normalize(iv))
        return cls(names, series, states, starts, ends, on, T)
