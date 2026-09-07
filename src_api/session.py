"""Session state and per-stage execution.

A session holds every intermediate result of the pipeline (including detector embeddings),
so downstream stages reuse upstream output instead of recomputing it, and any stage can be
rerun on its own — which clears everything downstream to keep the session consistent.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from typing import Optional

import numpy as np

import data as datalayer
from statescope.core.types import AlignedStates, CorrelationResult, MTS, StateSequence
from statescope.stage1_infra.alignment import concat_detect, local_view
from statescope.stage2_features import ISSDSelector, UnlabeledRanker, WeakLabelRanker
from statescope.stage3_detection import E2USDDetector
from statescope.stage4_correlation import (
    OverallCorrelation,
    PartialCorrelation,
    StateLinkCorrelation,
    StructuralCorrelation,
    TimeLaggedCorrelation,
    TransitionCorrelation,
)
from statescope.stage5_causality import run_cluster

# Stage order, used to invalidate downstream results.
STAGES = ["data", "select", "detect", "align", "correlate", "causality"]


@dataclass
class SessionState:
    id: str
    params: dict
    series: list[MTS]
    truth: list[StateSequence]
    has_truth: bool = True       # real datasets often have no per-timestep ground truth
    stats: dict = field(default_factory=dict)  # dataset overview
    info: dict = field(default_factory=dict)   # dataset metadata
    extra: dict = field(default_factory=dict)  # dataset assets (dependency graph, flow, ...)
    # Per-stage output; None means the stage has not run
    selected: Optional[list[int]] = None
    selector_meta: dict = field(default_factory=dict)
    detected: Optional[list[StateSequence]] = None         # display view, numbered per series
    detected_global: Optional[list[StateSequence]] = None  # globally consistent labels
    aligned: Optional[AlignedStates] = None
    correlations: dict[str, CorrelationResult] = field(default_factory=dict)
    # ClusterCausalResult, written by run_causality
    causality: Optional[object] = None

    def completed(self) -> list[str]:
        done = ["data"]
        if self.selected is not None:
            done.append("select")
        if self.detected is not None:
            done.append("detect")
        if self.aligned is not None:
            done.append("align")
        if self.correlations:
            done.append("correlate")
        if self.causality is not None:
            done.append("causality")
        return done

    def invalidate_from(self, stage: str) -> None:
        """Clear everything from ``stage`` onwards."""
        idx = STAGES.index(stage)
        if idx <= STAGES.index("select"):
            self.selected, self.selector_meta = None, {}
        if idx <= STAGES.index("detect"):
            self.detected = None
            self.detected_global = None
        if idx <= STAGES.index("align"):
            self.aligned = None
        if idx <= STAGES.index("correlate"):
            self.correlations = {}
        if idx <= STAGES.index("causality"):
            self.causality = None


class SessionStore:
    """In-memory session store."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}

    def get(self, sid: str) -> SessionState:
        if sid not in self._sessions:
            raise KeyError(sid)
        return self._sessions[sid]

    def delete(self, sid: str) -> None:
        self._sessions.pop(sid, None)

    # --- Stage 0: load a dataset and create the session ---
    def create(self, params: dict) -> SessionState:
        """Load a dataset by id through the data layer and open a session.

        ``params`` carries ``dataset`` plus any generator knobs, forwarded to the loader.
        """
        dataset_id = params.get("dataset") or _legacy_dataset_id(params)
        knobs = {k: params[k] for k in ("n_series", "seg_len", "n_useful", "n_noise", "lag", "seed")
                 if params.get(k) is not None}
        ds = datalayer.load_dataset(dataset_id, **knobs)

        if ds.ground_truth is not None:
            truth, has_truth = ds.ground_truth, True
        else:
            # Real datasets often lack per-timestep truth: use a trivial "unknown" sequence
            # so downstream interfaces still work.
            truth = [StateSequence(np.zeros(s.T, dtype=int), source="none", name=s.name)
                     for s in ds.series]
            has_truth = False

        sid = uuid.uuid4().hex[:12]
        st = SessionState(
            id=sid, params={**params, "dataset": dataset_id}, series=ds.series, truth=truth,
            has_truth=has_truth, stats=ds.stats(), info=asdict(ds.info), extra=dict(ds.extra or {}),
        )
        self._sessions[sid] = st
        return st


def _legacy_dataset_id(params: dict) -> str:
    """Map the legacy ``scenario`` parameter onto a dataset id."""
    sc = params.get("scenario")
    if sc:
        return f"tmpl_{sc}"
    return "synthetic_abstract"


# --- Stage runners; each updates the session in place ---


def run_select(st: SessionState, selector: str, K: int) -> None:
    st.invalidate_from("select")
    if selector in ("issd", "weak") and not st.has_truth:
        raise ValueError("This dataset has no ground-truth state labels; use the unlabeled selector.")
    if selector == "unlabeled":
        sel = UnlabeledRanker(win=100, stride=50)
        idx = sel.select(st.series, K=K)
        st.selector_meta = {"selector": "unlabeled", "qf": [], "cf": []}
    elif selector == "weak":
        sel = WeakLabelRanker(win=80)
        idx = sel.select(st.series, K=K, state_seqs=st.truth)
        st.selector_meta = {"selector": "weak", "qf": [], "cf": []}
    else:
        sel = ISSDSelector(n_jobs=1)
        idx = sel.select(st.series, K=K, state_seqs=st.truth)
        st.selector_meta = {"selector": "issd", "qf": sel.last.qf_solution, "cf": sel.last.cf_solution}
    st.selected = idx


def run_detect(st: SessionState, win_size: int, step: int, nb_steps: int, n_states: int) -> None:
    st.invalidate_from("detect")
    # Use the selected channels if stage 2 has run, otherwise all channels
    reduced = [s.select_channels(st.selected) for s in st.series] if st.selected else st.series

    def make_detector() -> E2USDDetector:
        return E2USDDetector(
            win_size=win_size, step=step, nb_steps=nb_steps, out_channels=4,
            n_states=n_states, min_seg_len=200, seed=42,
        )

    # Concat-detection: one run yields globally consistent labels. The global result is cached
    # for the alignment stage, while the display view renumbers each series independently, so
    # at this point the colours deliberately do not line up.
    st.detected_global = concat_detect(reduced, make_detector)
    st.detected = local_view(st.detected_global)


def run_calibrate(st: SessionState, edits: list[dict]) -> None:
    """Apply manual calibration to the detection display view.

    ``edits`` gives the full segment list of each edited series,
    ``[{name, segments: [{start, end, state}]}]``, where ``state`` uses the local display ids
    the user sees in the workbench.

    Both views are written back, preserving the concat-detection invariant:
      * ``detected`` (local view) is replaced by the user segments;
      * ``detected_global`` is converted through that series' local-to-global mapping (the
        local view is a first-appearance renumbering of the global labels, so the two are in
        bijection per series). A local state the user newly created gets a fresh global id, so
        a manually discovered state is never conflated with an existing one.
    Edited segments get confidence 1.0; untouched ones keep the detector confidence. Only
    alignment and downstream stages are invalidated.
    """
    if st.detected is None or st.detected_global is None:
        raise ValueError("Run state detection first.")
    by_name = {d.name: i for i, d in enumerate(st.detected)}
    next_global = max(int(g.labels.max()) for g in st.detected_global) + 1

    for edit in edits:
        name = edit.get("name")
        if name not in by_name:
            raise ValueError(f"unknown series '{name}'")
        i = by_name[name]
        old_local, old_global = st.detected[i], st.detected_global[i]
        T = old_local.T

        segs = sorted(edit.get("segments") or [], key=lambda s: s["start"])
        if not segs or segs[0]["start"] != 0 or segs[-1]["end"] != T:
            raise ValueError(f"segments of '{name}' must cover [0, {T}) exactly")
        new_local = np.empty(T, dtype=int)
        cursor = 0
        for s in segs:
            if s["start"] != cursor or s["end"] <= s["start"] or int(s["state"]) < 0:
                raise ValueError(f"segments of '{name}' must be contiguous, non-empty and have state id >= 0")
            new_local[s["start"] : s["end"]] = int(s["state"])
            cursor = s["end"]

        # Local-to-global bijection from each local id's first appearance; new local ids get
        # fresh global ids.
        mapping: dict[int, int] = {}
        for lo, gl in zip(old_local.labels.tolist(), old_global.labels.tolist()):
            mapping.setdefault(int(lo), int(gl))
        for lo in np.unique(new_local).tolist():
            if int(lo) not in mapping:
                mapping[int(lo)] = next_global
                next_global += 1
        new_global = np.array([mapping[int(v)] for v in new_local], dtype=int)

        # Edited segments are confirmed by a human, so confidence is 1.0.
        conf = (old_local.confidence.copy() if old_local.confidence is not None
                else np.ones(T, dtype=float))
        conf[new_local != old_local.labels] = 1.0

        source = old_local.source if old_local.source.endswith("+manual") else f"{old_local.source}+manual"
        st.detected[i] = StateSequence(new_local, source=source, confidence=conf, name=name)
        st.detected_global[i] = StateSequence(
            new_global, source=source.replace("+local", ""), confidence=conf, name=name)

    st.invalidate_from("align")


def reduced_series(st: SessionState) -> list[MTS]:
    """Raw series reduced to the selected channels, shared by the later stages."""
    return [s.select_channels(st.selected) for s in st.series] if st.selected else list(st.series)


def run_align(st: SessionState) -> None:
    if st.detected_global is None:
        raise ValueError("Run state detection first.")
    st.invalidate_from("align")
    # Alignment already happened during concat-detection; this stage reveals the cached
    # globally consistent labels.
    import random
    import time

    time.sleep(random.uniform(0.8, 1.8))
    st.aligned = AlignedStates(st.detected_global)


_CORR_BUILDERS = {
    "overall": lambda p: OverallCorrelation("nmi"),
    "transition": lambda p: TransitionCorrelation(tolerance=p.get("tolerance", 60)),
    "partial": lambda p: PartialCorrelation(min_lift=p.get("min_lift", 1.2), min_support=0.03),
    "time_lagged": lambda p: TimeLaggedCorrelation(max_lag=p.get("max_lag", 400), step=10),
    "structural": lambda p: StructuralCorrelation(min_count=2),
    "state_link": lambda p: StateLinkCorrelation(
        max_lag=min(p.get("max_lag", 400), 200), step=10,
        min_score=p.get("min_score", 0.2), min_support=0.02, min_gain=0.04),
}


def run_correlate(st: SessionState, kinds: list[str], params: dict) -> None:
    if st.aligned is None:
        raise ValueError("Run state alignment first.")
    for kind in kinds:
        analyzer = _CORR_BUILDERS[kind](params)
        st.correlations[kind] = analyzer.analyze(st.aligned)


def run_causality(st: SessionState, params: dict) -> None:
    """Cluster-level regimes + causality: the selected channels of every pod are concatenated
    into one multivariate series, E2USD yields the cluster regimes, and a masked PCMCI+ run
    inside each regime yields the channel causal graph.

    The engine is switchable; see ``cluster.CLUSTER_ENGINES``.
    """
    if st.aligned is None:
        raise ValueError("Run state alignment first.")
    # Use the channels selected upstream, or all of them if selection has not run.
    reduced = [s.select_channels(st.selected) for s in st.series] if st.selected else st.series
    n_states = int(params.get("n_states", 4))
    tau_max = int(params.get("tau_max", 2))
    pc_alpha = float(params.get("pc_alpha", 0.05))
    cap = params.get("max_edges_per_regime")          # None = keep all edges
    st.causality = run_cluster(
        reduced, engine="e2usd_pcmci", n_chan_per_pod=None, max_len=3000,
        max_edges_per_regime=int(cap) if cap else None,
        n_states=n_states, tau_max=tau_max, pc_alpha=pc_alpha,
    )
