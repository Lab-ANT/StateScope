"""End-to-end pipeline orchestrator.

Chains the five stages into one call: raw indicators, selected channels, state sequences,
aligned states, correlations, causal rules.

Every stage is optional and swappable; pass ``None`` to skip one. This is a thin
coordinator — the algorithms live in the stage implementations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

from statescope.core.interfaces import (
    CausalDiscoverer,
    ChannelSelector,
    CorrelationAnalyzer,
    StateAligner,
    StateDetector,
)
from statescope.core.types import (
    AlignedStates,
    CausalGraph,
    CorrelationResult,
    MTS,
    StateSequence,
)
from statescope.stage1_infra.alignment import concat_detect


@dataclass
class PipelineResult:
    selected_channels: Optional[list[int]] = None
    state_sequences: list[StateSequence] = field(default_factory=list)
    aligned: Optional[AlignedStates] = None
    correlations: list[CorrelationResult] = field(default_factory=list)
    causality: Optional[CausalGraph] = None


@dataclass
class StatePipeline:
    selector: Optional[ChannelSelector] = None
    detector_factory: Optional[Callable[[], StateDetector]] = None  # one detector per series
    aligner: Optional[StateAligner] = None
    correlation_analyzers: list[CorrelationAnalyzer] = field(default_factory=list)
    causal: Optional[CausalDiscoverer] = None
    K: int = 4

    def run(
        self,
        series: list[MTS],
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> PipelineResult:
        result = PipelineResult()

        # Stage 2 — indicator selection (all series share one channel subset).
        if self.selector is not None:
            idx = self.selector.select(series, self.K, state_seqs)
            result.selected_channels = idx
            series = [s.select_channels(idx) for s in series]

        # Stage 3 + 1.3 fused — concat-detection: one detector run yields globally
        # consistent labels, so alignment holds by construction.
        if self.detector_factory is not None:
            result.state_sequences = concat_detect(series, self.detector_factory)
        elif state_seqs is not None:
            result.state_sequences = list(state_seqs)

        # Stage 1.3 — wrap the already-consistent sequences into AlignedStates.
        if result.state_sequences:
            if self.aligner is not None:
                result.aligned = self.aligner.align(result.state_sequences)
            else:
                result.aligned = AlignedStates(result.state_sequences)

        # Stage 4 — correlation.
        if result.aligned is not None:
            for analyzer in self.correlation_analyzers:
                result.correlations.append(analyzer.analyze(result.aligned))

        # Stage 5 — causality.
        if self.causal is not None and result.aligned is not None:
            result.causality = self.causal.discover(result.aligned)

        return result
