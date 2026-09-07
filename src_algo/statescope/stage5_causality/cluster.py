"""Cluster-level regime + causality analysis (pluggable engine).

Treats the whole cluster as one object: the selected channels of every pod are
concatenated into a single ``[T, N]`` series, from which the engine learns a set of
regimes (cluster operating modes) plus a causal graph between channels inside each regime.

Unlike ``pcmci.py`` (per host, per state), this is cluster level: one concatenated series,
one set of regimes, one N-channel graph per regime. Engines are pluggable via
``CLUSTER_ENGINES``:

* ``e2usd_pcmci`` - decoupled: E2USD yields cluster regimes, then a masked PCMCI+ run per
  regime yields the channel causality. E2USD supports recurring regimes (the same state
  appearing in non-contiguous intervals).

An engine takes ``data[T, N]`` plus channel names and returns regime labels and one
``StateCausalGraph`` per regime, so visualisations are shared across engines.

Determinism: ``e2usd_pcmci`` uses E2USD(seed=42) + ParCorr and is deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Protocol

import numpy as np

from statescope.core.types import MTS, StateCausalGraph
from statescope.stage3_detection import E2USDDetector
from statescope.stage5_causality.pcmci import PCMCIPlusDiscoverer


@dataclass
class ClusterCausalResult:
    """Cluster-level result: a set of regimes plus one channel graph per regime."""

    engine: str
    regimes: np.ndarray                     # [T] per-timestep regime label
    graphs: list[StateCausalGraph]          # one per regime (state = regime id)
    var_names: list[str]                    # channel names, "pod:metric"
    pod_of: list[str]                       # owning pod of each channel
    kind_of: list[str]                      # metric kind of each channel (for colouring)
    pods: list[str]                         # pod order
    params: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)


def flatten_pods(
    pods: list[MTS], n_chan_per_pod: Optional[int] = None
) -> tuple[np.ndarray, list[str], list[str], list[str], list[str]]:
    """Flatten several pod series into one cluster-level MTS.

    Keeps the first ``n_chan_per_pod`` channels of each pod (None = all) and truncates every
    pod to the shortest length. Returns ``(data[T, N], var_names, pod_of, kind_of, pods)``
    where ``var_names[c]`` is ``"pod:metric"``.
    """
    if not pods:
        raise ValueError("flatten_pods: no pods given")
    T = min(int(p.T) for p in pods)
    cols: list[np.ndarray] = []
    var_names: list[str] = []
    pod_of: list[str] = []
    kind_of: list[str] = []
    pod_names = [p.name for p in pods]
    for p in pods:
        k = p.C if n_chan_per_pod is None else min(n_chan_per_pod, p.C)
        names = p.channel_names or [f"ch{i}" for i in range(p.C)]
        for c in range(k):
            cols.append(np.asarray(p.data[:T, c], dtype=float))
            var_names.append(f"{p.name}:{names[c]}")
            pod_of.append(p.name)
            kind_of.append(names[c])
    data = np.column_stack(cols)
    return data, var_names, pod_of, kind_of, pod_names


class ClusterCausalEngine(Protocol):
    """Engine contract: cluster MTS + channel names -> (regime labels, graphs, params)."""

    name: str

    def run(
        self, data: np.ndarray, var_names: list[str], **params: object
    ) -> tuple[np.ndarray, list[StateCausalGraph], dict]: ...


class E2USDPCMCIEngine:
    """Decoupled engine: E2USD regimes, then masked PCMCI+ per regime."""

    name = "e2usd_pcmci"

    def run(
        self,
        data: np.ndarray,
        var_names: list[str],
        *,
        n_states: int = 6,
        win: int = 100,
        step: int = 50,
        nb_steps: int = 60,
        tau_max: int = 3,
        pc_alpha: float = 0.05,
        seed: int = 42,
        **_: object,
    ) -> tuple[np.ndarray, list[StateCausalGraph], dict]:
        mts = MTS(data, channel_names=var_names, name="cluster")
        det = E2USDDetector(
            win_size=win, step=step, nb_steps=nb_steps, out_channels=4,
            n_states=n_states, min_seg_len=win, seed=seed,
        )
        regimes = det.fit(mts).predict(mts).labels
        # Regimes are independent, so the masked PCMCI+ runs are parallelised.
        res = PCMCIPlusDiscoverer(tau_min=0, tau_max=tau_max, pc_alpha=pc_alpha, n_jobs=-1).run(
            data, var_names, regimes
        )
        params = {
            "engine": self.name, "n_states": n_states, "win": win, "step": step,
            "nb_steps": nb_steps, "tau_max": tau_max, "pc_alpha": pc_alpha,
        }
        return np.asarray(regimes).astype(int), res.graphs, params


# Engine registry.
CLUSTER_ENGINES: dict[str, type] = {
    "e2usd_pcmci": E2USDPCMCIEngine,
}


def strip_self_loops(graph: StateCausalGraph) -> StateCausalGraph:
    """Drop self-loops (``src == dst``, i.e. ``X^{t-1} -> X^t`` autocorrelation).

    The cluster graph answers which channel drives *other* channels. Lagged self-loops are
    real but only say a series has inertia, and their strength often dominates, crowding out
    cross-channel edges in a top-K view. ``pod:memory -> pod:CPU`` is not a self-loop and is
    kept.
    """
    kept = [e for e in graph.edges if e.src != e.dst]
    return StateCausalGraph(
        state=graph.state, n_samples=graph.n_samples, var_names=graph.var_names, edges=kept,
    )


def cap_edges_by_strength(graph: StateCausalGraph, top_k: int) -> StateCausalGraph:
    """Keep only the ``top_k`` edges with the largest ``|strength|``.

    Highly coupled channels produce dense graphs (dozens of edges per regime). Every PCMCI
    edge carries a ``strength`` (partial correlation statistic), so keeping the strongest K
    leaves the interpretable backbone. Returns unchanged when ``top_k <= 0`` or already small.
    """
    if top_k <= 0 or len(graph.edges) <= top_k:
        return graph
    kept = sorted(graph.edges, key=lambda e: abs(e.strength), reverse=True)[:top_k]
    return StateCausalGraph(
        state=graph.state, n_samples=graph.n_samples, var_names=graph.var_names, edges=kept,
    )


def run_cluster(
    pods: list[MTS],
    engine: str = "e2usd_pcmci",
    n_chan_per_pod: Optional[int] = 3,
    max_len: int = 3000,
    max_edges_per_regime: Optional[int] = None,
    drop_self_loops: bool = True,
    **params: object,
) -> ClusterCausalResult:
    """Flatten pods, optionally downsample, run the engine, assemble a ClusterCausalResult.

    Downsampling only bounds runtime (PCMCI's CI tests are O(m) in samples); regimes and
    causal structure are not sensitive to the sampling rate. ``max_len=0`` disables it.

    ``max_edges_per_regime`` optionally keeps only the strongest edges per regime
    (``None`` = keep everything). On highly coupled real data a small value (8-10) gives an
    interpretable backbone.
    """
    if engine not in CLUSTER_ENGINES:
        raise ValueError(f"unknown engine '{engine}'; available: {list(CLUSTER_ENGINES)}")
    data, var_names, pod_of, kind_of, pod_names = flatten_pods(pods, n_chan_per_pod)
    T0 = int(data.shape[0])
    stride = 1
    if max_len and T0 > max_len:                       # even-stride downsample
        stride = int(np.ceil(T0 / max_len))
        data = data[::stride]
    eng = CLUSTER_ENGINES[engine]()
    regimes, graphs, eparams = eng.run(data, var_names, **params)
    if drop_self_loops:                                # before top-K, or they dominate
        graphs = [strip_self_loops(g) for g in graphs]
        eparams["drop_self_loops"] = True
    if max_edges_per_regime:                           # keep the strongest backbone
        graphs = [cap_edges_by_strength(g, int(max_edges_per_regime)) for g in graphs]
        eparams["max_edges_per_regime"] = int(max_edges_per_regime)
    # stride = downsample factor: lags are in downsampled steps; multiply to get raw steps.
    return ClusterCausalResult(
        engine=engine, regimes=regimes, graphs=graphs,
        var_names=var_names, pod_of=pod_of, kind_of=kind_of, pods=pod_names,
        params=eparams,
        meta={"T": int(data.shape[0]), "T_raw": T0, "N": int(data.shape[1]),
              "max_len": max_len, "stride": stride},
    )
