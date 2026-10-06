"""StateScope: a state-centric pipeline for time series state analysis."""

from statescope.core.pipeline import PipelineResult, StatePipeline
from statescope.core.types import (
    AlignedStates,
    CorrelationResult,
    MTS,
    Segment,
    StateCausalResult,
    StateSequence,
)

__version__ = "0.0.1"

__all__ = [
    "StatePipeline",
    "PipelineResult",
    "MTS",
    "Segment",
    "StateSequence",
    "AlignedStates",
    "CorrelationResult",
    "StateCausalResult",
]
