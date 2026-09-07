"""Stage 2 — ISSD indicator selection behind the ``ChannelSelector`` interface.

Fully-labelled regime: needs ground-truth ``state_seqs`` to score channel completeness
and quality. See the sibling selectors for the weakly-labelled and unlabelled regimes.
"""

from __future__ import annotations

from typing import Optional

from statescope.core.registry import register
from statescope.core.types import MTS, StateSequence
from statescope.vendor.issd import ISSD


@register("selector", "issd")
class ISSDSelector:
    """Select K channels with ISSD (quality-first, completeness-first, or integrated).

    Parameters
    ----
    strategy : {"inte", "qf", "cf"}
        Which solution ``select`` returns. ``inte`` (default) lets ISSD score both with
        LDA + mutual information and keep the better one.
    """

    def __init__(
        self,
        strategy: str = "inte",
        corr_threshold: float = 0.8,
        num_samples: int = 30,
        min_seg_len_to_exclude: int = 100,
        test_method: str = "nn",
        n_jobs: int = 1,
    ):
        self.strategy = strategy
        self._kw = dict(
            corr_threshold=corr_threshold,
            num_samples=num_samples,
            min_seg_len_to_exclude=min_seg_len_to_exclude,
            test_method=test_method,
            n_jobs=n_jobs,
        )
        self.last: Optional[ISSD] = None

    def select(
        self,
        series: list[MTS],
        K: int,
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> list[int]:
        # Fully-labelled regime: labelled state sequences are required
        if state_seqs is None:
            raise ValueError("ISSDSelector needs labeled state_seqs (fully-labeled regime).")
        datalist = [s.data for s in series]
        seqlist = [ss.labels for ss in state_seqs]
        issd = ISSD(**self._kw).fit(datalist, seqlist, K)
        self.last = issd
        return {"inte": issd.solution, "qf": issd.qf_solution, "cf": issd.cf_solution}[self.strategy]
