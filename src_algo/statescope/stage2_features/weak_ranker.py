"""Stage 2 — weakly-labelled indicator ranking.

Weakly-labelled regime (paper §3.2): we know *where* transitions happen (boundaries, log
events) but not *which* state each segment is — an ops log may mark "deploy started"
without saying what state the system is in. A useful indicator is one that changes
visibly at those known boundaries.

For each channel, compare the windows before and after every boundary and accumulate the
response (mean shift + KS distance); rank channels by total response. Channels are
z-standardised first.

Boundaries come from ``state_seqs``, but the state labels are deliberately ignored — that
is what "weakly labelled" means.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from scipy.stats import ks_2samp

from statescope.core.registry import register
from statescope.core.types import MTS, StateSequence
from statescope.util import z_normalize


@register("selector", "weak")
class WeakLabelRanker:
    """Rank indicators by how strongly they respond at known, unlabelled boundaries."""

    def __init__(self, win: int = 80):
        self.win = win
        self.scores_: Optional[np.ndarray] = None

    def select(
        self,
        series: list[MTS],
        K: int,
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> list[int]:
        if state_seqs is None:
            raise ValueError("WeakLabelRanker needs boundaries (state_seqs; labels are ignored).")
        C = series[0].C
        scores = np.zeros(C)
        for s, ss in zip(series, state_seqs):
            bounds = ss.change_points()  # where transitions are, not which state
            for c in range(C):
                x = z_normalize(s.data[:, c].astype(float))
                for b in bounds:
                    before, after = x[max(0, b - self.win) : b], x[b : b + self.win]
                    if len(before) < 3 or len(after) < 3:
                        continue
                    mean_shift = abs(after.mean() - before.mean())
                    ks = ks_2samp(before, after).statistic
                    scores[c] += mean_shift + ks
        self.scores_ = scores
        return np.argsort(scores)[::-1][:K].tolist()
