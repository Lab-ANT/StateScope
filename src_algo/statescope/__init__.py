"""StateScope — a comprehensive ecosystem for time series state analysis.

Reference implementation of the 5-stage pipeline from the Vision paper
"Towards a Comprehensive Ecosystem for Time Series State Analysis".

    [1] Data Infrastructure (labeling, generation, alignment)
    [2] Feature Engineering / Indicator Selection
    [3] State Detection
    [4] State Correlation Detection
    [5] State Causality Discovery
"""

from statescope.core.pipeline import PipelineResult, StatePipeline
from statescope.core.types import (
    AlignedStates,
    CausalGraph,
    CausalRule,
    CorrelationResult,
    MTS,
    Segment,
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
    "CausalGraph",
    "CausalRule",
]
