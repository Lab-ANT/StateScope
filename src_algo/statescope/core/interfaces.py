"""Protocols that each pipeline stage implementation must satisfy."""

from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from statescope.core.types import AlignedStates, CorrelationResult, MTS, StateCausalResult, StateSequence


@runtime_checkable
class ChannelSelector(Protocol):
    """Stage 2: pick K informative channels (``state_seqs`` optional: labelled or unlabelled)."""

    def select(
        self,
        series: list[MTS],
        K: int,
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> list[int]: ...


@runtime_checkable
class StateDetector(Protocol):
    """Stage 3: state detection."""

    def fit(self, series: MTS) -> "StateDetector": ...

    def predict(self, series: MTS) -> StateSequence: ...


@runtime_checkable
class CorrelationAnalyzer(Protocol):
    """Stage 4: state correlation."""

    kind: str

    def analyze(self, aligned: AlignedStates) -> CorrelationResult: ...


@runtime_checkable
class CausalDiscoverer(Protocol):
    """Stage 5: state causality."""

    def discover(self, aligned: AlignedStates) -> StateCausalResult: ...
