"""Stage 5 — State Causality Discovery. First cut: temporally-ordered Apriori
association-rule mining over aligned state events."""

from .apriori import AprioriCausalDiscoverer  # noqa: E402  (registers "causality:apriori")
from .pcmci import PCMCIPlusDiscoverer  # noqa: E402  (standalone; not in the registry)
from .cluster import (  # noqa: E402  (cluster-level regimes + causality)
    CLUSTER_ENGINES,
    ClusterCausalResult,
    E2USDPCMCIEngine,
    flatten_pods,
    run_cluster,
)

__all__ = [
    "AprioriCausalDiscoverer",
    "PCMCIPlusDiscoverer",
    "ClusterCausalResult",
    "E2USDPCMCIEngine",
    "CLUSTER_ENGINES",
    "flatten_pods",
    "run_cluster",
]
