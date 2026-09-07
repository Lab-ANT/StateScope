"""Stage 1.3 — state alignment by construction (concat-detection).

An unsupervised detector numbers each series' states arbitrarily, so ids do not match
across series. This module aligns them by construction:

  concatenate every series along time, run the detector (E2USD) *once*, and the same
  physical state lands in the same cluster / global id everywhere; then split back by
  series length.

Compared with clustering prototypes in embedding space, this needs no distance threshold
and is robust across data sources. The cost is that detection must see all series at once.

The demo deliberately shows this as two steps: the detection stage renumbers each series
independently for display (:func:`local_view`), so the colours look unaligned; the
alignment stage then reveals the cached globally consistent labels.
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from statescope.core.interfaces import StateDetector
from statescope.core.registry import register
from statescope.core.types import AlignedStates, MTS, StateSequence
from statescope.util import reorder_labels


def concat_detect(
    series: list[MTS], make_detector: Callable[[], StateDetector]
) -> list[StateSequence]:
    """Concatenate all series, run the detector once, split back into per-series states.

    The same physical state belongs to one cluster in the concatenated series, so ids are
    consistent across series after the split.
    """
    if not series:
        return []
    lengths = [s.T for s in series]
    big = MTS(
        np.vstack([np.asarray(s.data, dtype=float) for s in series]),
        channel_names=list(series[0].channel_names or []),
        name="concat",
    )
    seq = make_detector().fit(big).predict(big)
    glob = reorder_labels(seq.labels)  # renumber globally by first appearance
    conf = seq.confidence

    out: list[StateSequence] = []
    start = 0
    for s, length in zip(series, lengths):
        end = start + length
        out.append(
            StateSequence(
                labels=glob[start:end],
                source="e2usd+concat",
                confidence=None if conf is None else conf[start:end],
                name=s.name,
            )
        )
        start = end
    return out


def local_view(sequences: list[StateSequence]) -> list[StateSequence]:
    """Renumber each series independently, i.e. the not-yet-aligned view."""
    return [
        StateSequence(
            labels=reorder_labels(s.labels),
            source=f"{s.source}+local",
            confidence=s.confidence,
            name=s.name,
        )
        for s in sequences
    ]


@register("aligner", "concat")
class ConcatAligner:
    """Aligner for sequences produced by :func:`concat_detect`.

    Unification already happened during concat-detection (see the module docstring), so
    ``align`` simply wraps the sequences into :class:`AlignedStates`.
    """

    def align(self, sequences: list[StateSequence]) -> AlignedStates:
        return AlignedStates(list(sequences))
