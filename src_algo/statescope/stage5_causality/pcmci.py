"""Stage 5 (PCMCI+ route) — per-state, channel-level causal discovery.

Unlike Apriori (cross-series state co-occurrence), this follows the decoupled
"E2USD + PCMCI+" route: E2USD produces per-timestep state labels, tigramite's mask
(``mask_type='y'``) hides samples outside the state, and ``run_pcmciplus`` runs once per
state, yielding a channel-level graph with lagged and contemporaneous edges.

PCMCI+ fits because it is natively temporal, supports masking, and handles strong
autocorrelation and higher dimensionality.

The input contract differs from Apriori: this needs the raw ``data[T, N]`` signal plus
state labels ``labels[T]``, not just label sequences, so the class is a standalone module
rather than an implementation of ``CausalDiscoverer.discover(aligned)``.

Determinism: ParCorr is deterministic, and E2USD labels use ``seed=42``.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from statescope.core.types import CausalEdge, PCMCIResult, StateCausalGraph

# tigramite encodes contemporaneous edges symmetrically: graph[i,j,0]=='-->' and
# graph[j,i,0]=='<--'. To avoid double counting, tau=0 edges are taken only at '-->'.
_DIRECTED = "-->"


def _run_pcmci_state(args: tuple) -> "StateCausalGraph":
    """Masked PCMCI+ for one state (top-level so it can be pickled by a process pool).

    States are independent, so this parallelises without changing results. BLAS is pinned to
    one thread per process to avoid CPU oversubscription.
    """
    data, names, mask, state, n_keep, tau_min, tau_max, pc_alpha, cit = args
    try:
        from threadpoolctl import threadpool_limits
        limiter = threadpool_limits(limits=1)
    except Exception:
        limiter = None
    try:
        disc = PCMCIPlusDiscoverer(tau_min=tau_min, tau_max=tau_max, pc_alpha=pc_alpha, cond_ind_test=cit)
        g, v = disc._run_one(data, names, mask)
        return StateCausalGraph(
            state=int(state), n_samples=int(n_keep), var_names=names,
            edges=disc._extract_edges(g, v, names),
        )
    finally:
        if limiter is not None:
            limiter.unregister()


class PCMCIPlusDiscoverer:
    """Per-state masked PCMCI+.

    Parameters
    ----
    tau_min, tau_max : int
        Lag range to consider. ``tau_min=0`` also discovers contemporaneous edges.
    pc_alpha : float
        Significance level of the conditional independence test.
    cond_ind_test : {"parcorr"}
        Independence test. ParCorr (linear partial correlation) is fast and deterministic;
        CMIknn/GPDCtorch can be plugged in for nonlinear settings.
    """

    def __init__(
        self,
        tau_min: int = 0,
        tau_max: int = 5,
        pc_alpha: float = 0.05,
        cond_ind_test: str = "parcorr",
        n_jobs: int = 1,
    ):
        self.tau_min = tau_min
        self.tau_max = tau_max
        self.pc_alpha = pc_alpha
        self.cond_ind_test = cond_ind_test
        self.n_jobs = n_jobs  # >1 or <0 (all cores) parallelises over states

    def _make_test(self, mask_type: Optional[str]):
        from tigramite.independence_tests.parcorr import ParCorr

        if self.cond_ind_test != "parcorr":
            raise ValueError(f"unsupported cond_ind_test '{self.cond_ind_test}'")
        return ParCorr(mask_type=mask_type)

    def _extract_edges(
        self, graph: np.ndarray, val_matrix: np.ndarray, var_names: list[str]
    ) -> list[CausalEdge]:
        """Extract directed edges from tigramite's ``graph`` ([N, N, tau+1] of strings).

        ``graph[i, j, tau] == '-->'`` means i at t-tau drives j at t. Contemporaneous edges
        are taken only at '-->' to avoid duplicating '<--'.
        """
        N, _, L = graph.shape
        edges: list[CausalEdge] = []
        for i in range(N):
            for j in range(N):
                for tau in range(L):
                    link = graph[i, j, tau]
                    if link == "":
                        continue
                    if tau == 0 and link != _DIRECTED:
                        continue  # contemporaneous: keep '-->' only
                    if i == j and tau == 0:
                        continue  # a contemporaneous self-loop is meaningless
                    edges.append(
                        CausalEdge(
                            src=var_names[i],
                            dst=var_names[j],
                            lag=int(tau),
                            strength=round(float(val_matrix[i, j, tau]), 4),
                            link_type=str(link),
                        )
                    )
        return edges

    def _run_one(
        self, data: np.ndarray, var_names: list[str], mask: Optional[np.ndarray]
    ) -> tuple[np.ndarray, np.ndarray]:
        """Run PCMCI+ once on (optionally masked) data; return (graph, val_matrix)."""
        import tigramite.data_processing as pp
        from tigramite.pcmci import PCMCI

        df = pp.DataFrame(data, var_names=var_names, mask=mask)
        pcmci = PCMCI(dataframe=df, cond_ind_test=self._make_test("y" if mask is not None else None))
        res = pcmci.run_pcmciplus(
            tau_min=self.tau_min, tau_max=self.tau_max, pc_alpha=self.pc_alpha
        )
        return res["graph"], res["val_matrix"]

    def run(
        self,
        data: np.ndarray,
        var_names: Optional[list[str]] = None,
        state_labels: Optional[np.ndarray] = None,
    ) -> PCMCIResult:
        """Run PCMCI+.

        ``state_labels=None`` runs once over the whole series. Otherwise each state is run
        separately with ``mask_type='y'`` hiding samples outside that state.
        """
        data = np.asarray(data, dtype=float)
        T, N = data.shape
        names = var_names or [f"X{i}" for i in range(N)]
        params = {
            "tau_min": self.tau_min, "tau_max": self.tau_max,
            "pc_alpha": self.pc_alpha, "cond_ind_test": self.cond_ind_test,
        }

        graphs: list[StateCausalGraph] = []
        if state_labels is None:
            g, v = self._run_one(data, names, None)
            graphs.append(StateCausalGraph(
                state=-1, n_samples=T, var_names=names,
                edges=self._extract_edges(g, v, names),
            ))
        else:
            state_labels = np.asarray(state_labels).astype(int)
            states = sorted(np.unique(state_labels).tolist())
            jobs = []
            for s in states:
                keep = state_labels == s
                # mask=True means "hide", so invert; broadcast across channels.
                mask = np.repeat((~keep)[:, None], N, axis=1)
                jobs.append((data, names, mask, s, int(keep.sum()),
                             self.tau_min, self.tau_max, self.pc_alpha, self.cond_ind_test))
            if self.n_jobs == 1 or len(states) <= 1:
                graphs = [_run_pcmci_state(j) for j in jobs]
            else:  # states are independent: run them in a process pool (map keeps order)
                import multiprocessing as mp
                from concurrent.futures import ProcessPoolExecutor

                workers = len(states) if self.n_jobs < 0 else min(self.n_jobs, len(states))
                # fork lets children inherit the imported tigramite and avoids spawn's
                # re-import-main recursion; fall back to sequential if unavailable.
                try:
                    ctx = mp.get_context("fork")
                    with ProcessPoolExecutor(max_workers=workers, mp_context=ctx) as ex:
                        graphs = list(ex.map(_run_pcmci_state, jobs))
                except (ValueError, OSError):
                    graphs = [_run_pcmci_state(j) for j in jobs]

        return PCMCIResult(graphs=graphs, params=params, meta={"T": T, "N": N})
