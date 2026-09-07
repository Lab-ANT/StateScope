"""Stage 2 — unlabelled indicator ranking (no state labels at all).

Implements the Time2State observation (paper §3.2, unlabelled regime): an informative
indicator differs a lot between distant subsequences (likely different states) while
nearby subsequences stay similar (likely the same state). Uninformative or noisy channels
show little global divergence.

Score per channel = mean global window distance - mean local window distance.
Channels are z-standardised first so scores are comparable.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from statescope.core.registry import register
from statescope.core.types import MTS, StateSequence
from statescope.util import z_normalize


def _window_descriptors(x: np.ndarray, win: int, stride: int) -> np.ndarray:
    """Summarise each window by (mean, std) — a cheap level/volatility descriptor."""
    n = (len(x) - win) // stride + 1
    desc = np.empty((max(n, 0), 2))
    for i in range(n):
        w = x[i * stride : i * stride + win]
        desc[i] = (w.mean(), w.std())
    return desc


@register("selector", "unlabeled")
class UnlabeledRanker:
    """Rank indicators by global divergence minus local similarity, keep top-K.

    ``select`` ignores ``state_seqs`` entirely, so it works before any labels exist.
    """

    def __init__(self, win: int = 100, stride: int = 50):
        self.win = win
        self.stride = stride
        self.scores_: Optional[np.ndarray] = None

    def select(
        self,
        series: list[MTS],
        K: int,
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> list[int]:
        C = series[0].C
        scores = np.zeros(C)
        for s in series:
            for c in range(C):
                x = z_normalize(s.data[:, c].astype(float))
                desc = _window_descriptors(x, self.win, self.stride)
                if len(desc) < 3:
                    continue
                local = np.mean(np.linalg.norm(np.diff(desc, axis=0), axis=1))
                # Global divergence: mean pairwise distance over all windows
                gd = np.linalg.norm(desc[:, None, :] - desc[None, :, :], axis=2)
                glob = gd.sum() / (len(desc) * (len(desc) - 1))
                scores[c] += glob - local
        self.scores_ = scores
        return np.argsort(scores)[::-1][:K].tolist()
