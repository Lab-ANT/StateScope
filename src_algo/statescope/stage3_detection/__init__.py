"""Stage 3 — State Detection. Unified detector wrapping Time2State (LSE) and
E2USD (DDEM) encoders behind one StateDetector interface."""

from .detector import E2USDDetector  # noqa: E402  (registers "detector:e2usd")

__all__ = ["E2USDDetector"]
