"""End-to-end pipeline: select -> per-metric detection -> correlation -> state causality."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from statescope.core.interfaces import CausalDiscoverer, ChannelSelector, CorrelationAnalyzer
from statescope.core.types import (
    AlignedStates,
    CorrelationResult,
    MTS,
    StateCausalResult,
    StateSequence,
)


@dataclass
class PipelineResult:
    selected_channels: Optional[list[int]] = None
    state_sequences: list[StateSequence] = field(default_factory=list)
    correlations: list[CorrelationResult] = field(default_factory=list)
    causality: Optional[StateCausalResult] = None


@dataclass
class StatePipeline:
    """Every stage is optional; ``metric_detect`` holds kwargs for ``detect_metric`` (None = skip)."""

    selector: Optional[ChannelSelector] = None
    metric_detect: Optional[dict] = None
    correlation_analyzers: list[CorrelationAnalyzer] = field(default_factory=list)
    causal: Optional[CausalDiscoverer] = None
    K: int = 4

    def run(
        self,
        series: list[MTS],
        state_seqs: Optional[list[StateSequence]] = None,
    ) -> PipelineResult:
        result = PipelineResult()

        if self.selector is not None:
            idx = self.selector.select(series, self.K, state_seqs)
            result.selected_channels = idx
            series = [s.select_channels(idx) for s in series]

        if self.metric_detect is not None:
            from statescope.stage3_detection import detect_metric  # lazy: core does not depend on stage3

            result.state_sequences = [detect_metric(s, ch, **self.metric_detect).sequence
                                      for s in series for ch in s.channel_names]
        elif state_seqs is not None:
            result.state_sequences = list(state_seqs)

        if result.state_sequences:
            aligned = AlignedStates(result.state_sequences)
            for analyzer in self.correlation_analyzers:
                result.correlations.append(analyzer.analyze(aligned))
            if self.causal is not None:
                result.causality = self.causal.discover(aligned)

        return result
