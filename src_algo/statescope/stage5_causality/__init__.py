"""Stage 5: state causality discovery (NIAGARA)."""

from .event import NiagaraDiscoverer, discover_state_causality  # noqa: E402  (registers "causality:niagara")

__all__ = ["NiagaraDiscoverer", "discover_state_causality"]
