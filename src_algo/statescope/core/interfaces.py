"""Abstract interfaces for the five pipeline stages.

These Protocols define the contract each stage implementation must satisfy. They are
deliberately thin so research code (ISSD, Time2State, E2USD) can be wrapped behind them
with minimal change.

Pipeline data flow (paper Fig. 3):

    MTS ──▶ [2] ChannelSelector ──▶ MTS' (fewer channels)
        ──▶ [3] StateDetector    ──▶ StateSequence（+ embeddings）
        ──▶ [1.3] StateAligner   ──▶ AlignedStates       (across series)
        ──▶ [4] CorrelationAnalyzer ──▶ CorrelationResult
        ──▶ [5] CausalDiscoverer  ──▶ CausalGraph
"""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from statescope.core.types import (
    AlignedStates,
    CausalGraph,
    CorrelationResult,
    MTS,
    StateSequence,
)


@runtime_checkable
class ChannelSelector(Protocol):
    """Stage 2 — feature engineering / indicator selection.

    Picks a subset of K informative channels. ``state_seqs`` is optional so the same
    interface covers the fully-labelled (ISSD), weakly-labelled and unlabelled regimes.
    """

    def select(
        self,
        series: list[MTS],
        K: int,
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> list[int]: ...


@runtime_checkable
class StateDetector(Protocol):
    """Stage 3 — state detection. Shared by Time2State and E2USD."""

    def fit(self, series: MTS) -> "StateDetector": ...

    def predict(self, series: MTS) -> StateSequence: ...


@runtime_checkable
class StateAligner(Protocol):
    """Stage 1.3 — state alignment.

    Remaps independently numbered per-series state labels onto one global vocabulary.
    Model-agnostic and non-intrusive: it only touches detector output.
    """

    def align(self, sequences: list[StateSequence]) -> AlignedStates: ...


@runtime_checkable
class CorrelationAnalyzer(Protocol):
    """Stage 4 — state correlation detection."""

    kind: str

    def analyze(self, aligned: AlignedStates) -> CorrelationResult: ...


@runtime_checkable
class CausalDiscoverer(Protocol):
    """Stage 5 — state causality discovery."""

    def discover(self, aligned: AlignedStates) -> CausalGraph: ...
