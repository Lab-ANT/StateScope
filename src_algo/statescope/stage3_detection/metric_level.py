"""Per-metric state detection: univariate E2USD on each entity.metric, states named ``<entity>.<metric>.<state>``.

States are renumbered by mean level (low to high) so ids are readable and comparable across entities.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from ..core.types import MTS, StateSequence
from .detector import E2USDDetector


@dataclass
class MetricStateResult:
    entity: str
    metric: str
    sequence: StateSequence           # name = "<entity>.<metric>"
    values: np.ndarray                # raw metric values (T,)
    state_stats: list[dict]           # per state: {state, name, frac, mean, std, n_segments}
    runtime_s: float

    @property
    def name(self) -> str:
        return f"{self.entity}.{self.metric}"


def relabel_by_level(labels: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Renumber states 0..k-1 by mean value, low to high (ties broken by original id; deterministic)."""
    states = np.unique(labels)
    means = [(float(values[labels == s].mean()), int(s)) for s in states]
    order = [s for _, s in sorted(means)]
    mapping = {old: new for new, old in enumerate(order)}
    return np.vectorize(mapping.get)(labels).astype(int)


def detect_metric(series: MTS, metric: str, *, win_size: int = 100, step: int = 30, nb_steps: int = 20,
                  n_states: int | None = None, min_seg_len: int = 0, seed: int | None = 42,
                  order_by_level: bool = True) -> MetricStateResult:
    """Run univariate E2USD on a single metric ``metric`` of entity ``series``."""
    names = list(series.channel_names or [])
    if metric not in names:
        raise KeyError(f"metric '{metric}' is not among the channels {names} of {series.name}")
    ch = names.index(metric)
    values = np.asarray(series.data[:, ch], dtype=float)
    if win_size >= series.T:
        raise ValueError(f"window {win_size} is not smaller than series length {series.T}")
    uni = MTS(values[:, None], channel_names=[metric], name=f"{series.name}.{metric}")

    t0 = time.perf_counter()
    det = E2USDDetector(win_size=win_size, step=step, nb_steps=nb_steps, n_states=n_states,
                        min_seg_len=min_seg_len, seed=seed)
    seq = det.fit(uni).predict(uni)
    labels = relabel_by_level(seq.labels, values) if order_by_level else seq.labels
    name = uni.name
    seq = StateSequence(labels, label_names={int(s): f"{name}.{int(s)}" for s in np.unique(labels)},
                        source="e2usd-univariate", confidence=seq.confidence, name=name)

    stats = []
    segs = seq.segments()
    for s in sorted(np.unique(labels).tolist()):
        v = values[labels == s]
        stats.append({"state": int(s), "name": f"{name}.{int(s)}", "frac": float((labels == s).mean()),
                      "mean": float(v.mean()), "std": float(v.std()),
                      "n_segments": sum(1 for g in segs if g.state == s)})
    return MetricStateResult(series.name, metric, seq, values, stats, time.perf_counter() - t0)
