"""State Alignment (paper Appendix B): unify independently-numbered states across
series onto one global vocabulary. Implemented as concat-detection — detect all
series jointly so identical physical states share a global id by construction
(robust, zero-tuning). See concat_aligner.py."""

from .concat_aligner import ConcatAligner, concat_detect, local_view  # noqa: E402  (registers "aligner:concat")

__all__ = ["ConcatAligner", "concat_detect", "local_view"]
