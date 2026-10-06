"""Stage 4: state correlation analysers (overall agreement and partial state co-occurrence).

All assume time-aligned sequences; unequal lengths are truncated to the shortest.
"""

from __future__ import annotations

import numpy as np
from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

from statescope.core.registry import register
from statescope.core.types import AlignedStates, CorrelationResult


def _min_len(aligned: AlignedStates) -> int:
    return min(seq.T for seq in aligned.sequences)


def _names(aligned: AlignedStates) -> list[str]:
    return [seq.name or f"series{i}" for i, seq in enumerate(aligned.sequences)]


@register("correlation", "overall")
class OverallCorrelation:
    kind = "overall"

    def __init__(self, metric: str = "nmi"):
        self.metric = metric
        self._fn = adjusted_rand_score if metric == "ari" else normalized_mutual_info_score

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        T = _min_len(aligned)
        seqs = [seq.labels[:T] for seq in aligned.sequences]
        n = len(seqs)
        M = np.eye(n)
        for i in range(n):
            for j in range(i + 1, n):
                M[i, j] = M[j, i] = self._fn(seqs[i], seqs[j])
        return CorrelationResult(
            kind=self.kind, matrix=M, labels=_names(aligned),
            meta={"metric": self.metric, "truncated_to": T},
        )


@register("correlation", "partial")
class PartialCorrelation:
    """Does a specific state of A co-occur with one of B (Jaccard or lift)?

    Both measures also require ``lift >= min_lift`` and ``support >= min_support``: two background
    states that each fill the timeline would otherwise get a high Jaccard even when independent.
    """

    kind = "partial"

    def __init__(self, measure: str = "jaccard", min_score: float = 0.3, min_lift: float = 1.2,
                 min_support: float = 0.02):
        if measure not in ("jaccard", "lift"):
            raise ValueError(f"unknown partial measure '{measure}'")
        self.measure = measure
        self.min_score = min_score  # jaccard floor (lift uses min_lift)
        self.min_lift = min_lift
        self.min_support = min_support

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        T = _min_len(aligned)
        names = _names(aligned)
        seqs = [seq.labels[:T] for seq in aligned.sequences]
        n = len(seqs)
        pairs = []
        for i in range(n):
            for j in range(n):
                if i == j or (self.measure == "jaccard" and j < i):  # Jaccard is symmetric
                    continue
                a, b = seqs[i], seqs[j]
                for sa in np.unique(a):
                    pa = np.mean(a == sa)
                    for sb in np.unique(b):
                        pb = np.mean(b == sb)
                        joint = np.mean((a == sa) & (b == sb))
                        if joint < self.min_support or pa == 0 or pb == 0:
                            continue
                        lift = joint / (pa * pb)
                        jac = joint / (pa + pb - joint)
                        if lift < self.min_lift or (self.measure == "jaccard" and jac < self.min_score):
                            continue
                        pairs.append({
                            "from": f"{names[i]}:S{int(sa)}",
                            "to": f"{names[j]}:S{int(sb)}",
                            "support": round(float(joint), 4),
                            "lift": round(float(lift), 3),
                            "jaccard": round(float(jac), 3),
                            "score": round(float(jac if self.measure == "jaccard" else lift), 3),
                        })
        pairs.sort(key=lambda d: d["score"], reverse=True)
        return CorrelationResult(
            kind=self.kind, labels=names, pairs=pairs,
            meta={"measure": self.measure, "min_score": self.min_score, "min_lift": self.min_lift,
                  "min_support": self.min_support, "truncated_to": T},
        )
