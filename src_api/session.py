"""Session state and per-stage runners; rerunning a stage clears everything downstream."""

from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from typing import Callable, Optional

import numpy as np

import data as datalayer
from statescope.core.types import AlignedStates, CorrelationResult, MTS, StateCausalResult, StateSequence
from statescope.stage2_features import ISSDSelector, UnlabeledRanker, WeakLabelRanker
from statescope.stage3_detection import detect_metric
from statescope.stage4_correlation import OverallCorrelation, PartialCorrelation
from statescope.stage5_causality import discover_state_causality

STAGES = ["data", "select", "detect", "correlate", "causality"]

# LRU cap: each session holds the full dataset plus every stage output.
MAX_SESSIONS = 32


@dataclass
class SessionState:
    id: str
    params: dict
    series: list[MTS]
    truth: list[StateSequence]
    has_truth: bool = True       # real datasets often have no per-timestep ground truth
    stats: dict = field(default_factory=dict)
    info: dict = field(default_factory=dict)
    # Per-stage output; None means the stage has not run
    picks: Optional[dict[str, list[int]]] = None  # entity -> channel indices; empty entities are skipped
    selector_meta: dict = field(default_factory=dict)
    ranking: dict = field(default_factory=dict)   # entity -> [{name, score}], descending
    detected: Optional[list[StateSequence]] = None  # one sequence per "entity.metric"
    owner: dict = field(default_factory=dict)       # series "entity.metric" -> (entity, metric)
    correlations: dict[str, CorrelationResult] = field(default_factory=dict)
    causality: Optional[StateCausalResult] = None
    # Sync endpoints run in a thread pool; serialise stage runs per session.
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def completed(self) -> list[str]:
        done = ["data"]
        if self.picks is not None:
            done.append("select")
        if self.detected is not None:
            done.append("detect")
        if self.correlations:
            done.append("correlate")
        if self.causality is not None:
            done.append("causality")
        return done

    def invalidate_from(self, stage: str) -> None:
        """Clear everything from ``stage`` onwards."""
        idx = STAGES.index(stage)
        if idx <= STAGES.index("select"):
            self.picks, self.selector_meta, self.ranking = None, {}, {}
        if idx <= STAGES.index("detect"):
            self.detected, self.owner = None, {}
        if idx <= STAGES.index("correlate"):
            self.correlations = {}
        if idx <= STAGES.index("causality"):
            self.causality = None


class SessionStore:
    """Thread-safe in-memory LRU session store."""

    def __init__(self, max_sessions: int = MAX_SESSIONS) -> None:
        self._sessions: OrderedDict[str, SessionState] = OrderedDict()
        self._lock = threading.Lock()
        self.max_sessions = max_sessions

    def get(self, sid: str) -> SessionState:
        with self._lock:
            if sid not in self._sessions:
                raise KeyError(sid)
            self._sessions.move_to_end(sid)
            return self._sessions[sid]

    def delete(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)

    def __len__(self) -> int:
        return len(self._sessions)

    def _add(self, st: SessionState) -> None:
        with self._lock:
            self._sessions[st.id] = st
            while len(self._sessions) > self.max_sessions:
                self._sessions.popitem(last=False)

    def create(self, params: dict) -> SessionState:
        """Load a dataset and open a session (KeyError: unknown id; ValueError: not integrated)."""
        dataset_id = params.get("dataset") or "synthetic_abstract"
        knobs = {k: params[k] for k in ("n_series", "seg_len", "n_useful", "n_noise", "lag", "seed")
                 if params.get(k) is not None}
        ds = datalayer.load_dataset(dataset_id, **knobs)

        if ds.ground_truth is not None:
            truth, has_truth = ds.ground_truth, True
        else:
            # Placeholder truth so downstream interfaces still work.
            truth = [StateSequence(np.zeros(s.T, dtype=int), source="none", name=s.name)
                     for s in ds.series]
            has_truth = False

        sid = uuid.uuid4().hex[:12]
        st = SessionState(
            id=sid, params={**params, "dataset": dataset_id}, series=ds.series, truth=truth,
            has_truth=has_truth, stats=ds.stats(), info=asdict(ds.info),
        )
        self._add(st)  # load outside the lock; only registration holds it
        return st


def reduced_series(st: SessionState) -> list[MTS]:
    """Raw series reduced to the picked channels; entities without picks are dropped."""
    picks = st.picks or {}
    return [s.select_channels(picks[s.name]) for s in st.series if picks.get(s.name)]


def _rank_entities(st: SessionState) -> dict:
    """Unlabeled ranking per entity: entity -> [{name, score}], descending."""
    out = {}
    for s in st.series:
        ranker = UnlabeledRanker(win=100, stride=50)
        ranker.select([s], K=s.C)
        sc = ranker.scores_ if ranker.scores_ is not None else np.zeros(s.C)
        order = np.argsort(sc)[::-1]
        out[s.name] = [{"name": s.channel_names[c], "score": round(float(sc[c]), 4)} for c in order]
    return out


def run_select(st: SessionState, selector: str, K: int, picks: Optional[dict[str, list[str]]] = None) -> None:
    """Stage 2: explicit ``picks`` by name, else K metrics per entity.

    ``unlabeled`` ranks each entity on its own; ``issd`` / ``weak`` need ground truth and pick one
    channel set that is applied to every entity.
    """
    st.invalidate_from("select")
    if picks is not None:
        by_name = {s.name: s for s in st.series}
        sel: dict[str, list[int]] = {}
        for ent, metrics in picks.items():
            if ent not in by_name:
                raise ValueError(f"Unknown entity '{ent}'.")
            names = list(by_name[ent].channel_names)
            bad = [m for m in metrics if m not in names]
            if bad:
                raise ValueError(f"Entity '{ent}' has no metric {bad}.")
            if metrics:
                sel[ent] = [names.index(m) for m in metrics]
        if not sel:
            raise ValueError("Select at least one metric of one entity.")
        st.ranking = _rank_entities(st)
        st.picks = {s.name: sel[s.name] for s in st.series if s.name in sel}  # keep dataset entity order
        st.selector_meta = {"selector": "manual", "qf": [], "cf": []}
        return
    if selector == "unlabeled":
        st.ranking = _rank_entities(st)
        st.picks = {s.name: [list(s.channel_names).index(r["name"]) for r in st.ranking[s.name][:K]]
                    for s in st.series}
        st.selector_meta = {"selector": "unlabeled", "qf": [], "cf": []}
        return
    if not st.has_truth:
        raise ValueError("This dataset has no ground-truth state labels; use the unlabeled selector.")
    if selector == "weak":
        idx = WeakLabelRanker(win=80).select(st.series, K=K, state_seqs=st.truth)
        st.selector_meta = {"selector": "weak", "qf": [], "cf": []}
    else:
        sel_ = ISSDSelector(n_jobs=1)
        idx = sel_.select(st.series, K=K, state_seqs=st.truth)
        st.selector_meta = {"selector": "issd", "qf": sel_.last.qf_solution, "cf": sel_.last.cf_solution}
    st.picks = {s.name: list(idx) for s in st.series}


def run_detect(st: SessionState, win_size: int, step: int, nb_steps: int, n_states: int,
               min_seg_len: int = 0,
               on_metric: Optional[Callable[[StateSequence, str, str, int, int], None]] = None) -> None:
    """Stage 3: univariate E2USD per "entity.metric"; ``n_states`` <= 1 lets the DP choose."""
    st.invalidate_from("detect")
    reduced = reduced_series(st)
    if not reduced:
        raise ValueError("Nothing to detect: select at least one metric of one entity in indicator selection first.")
    seqs, owner = [], {}
    total = sum(m.C for m in reduced)
    for mts in reduced:
        for ch in mts.channel_names:
            r = detect_metric(mts, ch, win_size=win_size, step=step, nb_steps=nb_steps,
                              n_states=n_states if n_states >= 2 else None, min_seg_len=min_seg_len, seed=42)
            seqs.append(r.sequence)
            owner[r.name] = (mts.name, ch)
            if on_metric is not None:
                on_metric(r.sequence, mts.name, ch, len(seqs), total)
    st.detected, st.owner = seqs, owner


def run_calibrate(st: SessionState, edits: list[dict]) -> None:
    """Replace the segments of edited series; correlation and causality are invalidated."""
    if st.detected is None:
        raise ValueError("Run state detection first.")
    by_name = {d.name: i for i, d in enumerate(st.detected)}
    for edit in edits:
        name = edit.get("name")
        if name not in by_name:
            raise ValueError(f"unknown series '{name}'")
        i = by_name[name]
        old = st.detected[i]
        T = old.T

        segs = sorted(edit.get("segments") or [], key=lambda s: s["start"])
        if not segs or segs[0]["start"] != 0 or segs[-1]["end"] != T:
            raise ValueError(f"segments of '{name}' must cover [0, {T}) exactly")
        labels = np.empty(T, dtype=int)
        cursor = 0
        for s in segs:
            if s["start"] != cursor or s["end"] <= s["start"] or int(s["state"]) < 0:
                raise ValueError(f"segments of '{name}' must be contiguous, non-empty and have state id >= 0")
            labels[s["start"] : s["end"]] = int(s["state"])
            cursor = s["end"]

        conf = old.confidence.copy() if old.confidence is not None else np.ones(T, dtype=float)
        conf[labels != old.labels] = 1.0  # edited timesteps are certain
        source = old.source if old.source.endswith("+manual") else f"{old.source}+manual"
        st.detected[i] = StateSequence(labels, source=source, confidence=conf, name=name)
    st.invalidate_from("correlate")


def run_correlate(st: SessionState, min_lift: float = 1.2, min_jaccard: float = 0.3) -> None:
    """Stage 4: overall NMI and partial (Jaccard) state correlation."""
    if st.detected is None:
        raise ValueError("Run state detection first.")
    aligned = AlignedStates(st.detected)
    st.correlations = {
        "overall": OverallCorrelation("nmi").analyze(aligned),
        "partial": PartialCorrelation(measure="jaccard", min_score=min_jaccard, min_lift=min_lift,
                                      min_support=0.03).analyze(aligned),
    }
    _corroborate(st)  # causality does not depend on correlation; only refresh its annotation


def _corroborate(st: SessionState) -> None:
    """Mark each mechanism ``corroborated`` if every parent co-occurs with the child in stage-4 partial.

    Annotate only: filtering candidates up front would change NIAGARA's greedy choices.
    """
    partial = st.correlations.get("partial")
    if partial is None or st.causality is None:
        return

    def ev(x: str) -> str:  # "series:S3" -> "series:3"
        name, _, state = x.rpartition(":S")
        return f"{name}:{state}"

    assoc = {frozenset((ev(p["from"]), ev(p["to"]))) for p in partial.pairs}
    for m in st.causality.mechanisms:
        parents = list(m.triggers) + [c for c, _ in m.cond]
        m.params["corroborated"] = bool(parents) and all(frozenset((p, m.child)) in assoc for p in parents)
    st.causality.meta["corroborated_by"] = "partial"


def run_causality(st: SessionState, min_occ: int = 3, allow_instant: bool = True, pair_top: int = 8) -> None:
    """Stage 5: NIAGARA state causality, annotated with stage-4 support when available."""
    if st.detected is None:
        raise ValueError("Run state detection first.")
    st.causality = discover_state_causality(st.detected, min_occ=min_occ, allow_instant=allow_instant,
                                            pair_top=pair_top)
    _corroborate(st)
