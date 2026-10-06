"""Stage 3: state detection (E2USD), run per metric."""

from .detector import E2USDDetector  # noqa: E402  (registers "detector:e2usd")
from .metric_level import MetricStateResult, detect_metric, relabel_by_level  # noqa: E402

__all__ = ["E2USDDetector", "MetricStateResult", "detect_metric", "relabel_by_level"]
