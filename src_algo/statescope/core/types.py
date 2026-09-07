"""Unified data contracts shared by the whole StateScope pipeline.

Every stage of the five-stage pipeline speaks the same language, so stages compose
directly with no ad-hoc conversion between them.

Design notes
--------
* Dependencies are kept minimal (numpy + stdlib) so the engine, the API layer and the
  unit tests can all import these contracts directly.
* ``Segment`` / ``StateSequence`` fields mirror labelState's ``Segment`` /
  ``SegmentationResult`` (start, end, label, source, confidence) so the borrowed
  labelling module integrates without translation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# Pipeline input: multivariate time series
# ---------------------------------------------------------------------------


@dataclass
class MTS:
    """A multivariate time series.

    Parameters
    ----
    data : np.ndarray
        Shape ``(T, C)``: T timesteps, C channels/indicators.
    channel_names : list[str] | None
        Channel names of length C. Defaults to ``["ch0", "ch1", ...]``.
    timestamps : np.ndarray | None
        Optional timestamps of length T (epoch seconds or sample index).
    name : str
        Human-readable identifier (e.g. source series or host name).
    """

    data: np.ndarray
    channel_names: Optional[list[str]] = None
    timestamps: Optional[np.ndarray] = None
    name: str = "series"

    def __post_init__(self) -> None:
        self.data = np.asarray(self.data, dtype=np.float64)
        if self.data.ndim == 1:
            self.data = self.data[:, None]
        if self.channel_names is None:
            self.channel_names = [f"ch{i}" for i in range(self.C)]
        elif len(self.channel_names) != self.C:
            raise ValueError(
                f"channel_names has {len(self.channel_names)} entries but data has {self.C} channels"
            )

    @property
    def T(self) -> int:
        return self.data.shape[0]

    @property
    def C(self) -> int:
        return self.data.shape[1]

    def select_channels(self, indices: list[int]) -> "MTS":
        """Return a new MTS keeping only ``indices`` (used by stage-2 selection)."""
        names = [self.channel_names[i] for i in indices]
        return MTS(self.data[:, indices], names, self.timestamps, self.name)


# ---------------------------------------------------------------------------
# Stage 3 output: state sequences (+ derived segment view)
# ---------------------------------------------------------------------------


@dataclass
class Segment:
    """A run of consecutive timesteps in one state. ``end`` is exclusive."""

    start: int
    end: int
    state: int
    confidence: Optional[float] = None
    source: str = "unknown"

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass
class StateSequence:
    """Per-timestep state labels for one series.

    ``labels[t]`` is the integer state id at time t. Ids are meaningful only *within
    this series* until stage-1 alignment maps them onto one global vocabulary
    (see :class:`AlignedStates`).

    ``embeddings`` / ``embedding_step`` optionally carry the detector's per-window latent
    vectors. The current aligner uses concat-detection instead (see
    ``stage1_infra/alignment/concat_aligner.py``) and does not need them, but the fields
    are kept for future aligners.
    """

    labels: np.ndarray  # shape (T,), int
    label_names: Optional[dict[int, str]] = None
    source: str = "unknown"
    confidence: Optional[np.ndarray] = None  # shape (T,), float in [0, 1]
    embeddings: Optional[np.ndarray] = None  # shape (n_windows, d)
    embedding_step: Optional[int] = None
    embedding_win_size: Optional[int] = None
    name: str = "series"

    def __post_init__(self) -> None:
        self.labels = np.asarray(self.labels).astype(int)

    def window_centers(self) -> Optional[np.ndarray]:
        """Centre timestep of each embedding window (needs step + win_size).

        Lets an aligner attribute each window embedding to the final state at its centre,
        without the detector having to export per-window cluster labels.
        """
        if self.embeddings is None or self.embedding_step is None:
            return None
        n = self.embeddings.shape[0]
        win = self.embedding_win_size or 0
        centers = np.arange(n) * self.embedding_step + win // 2
        return np.clip(centers, 0, self.T - 1)

    @property
    def T(self) -> int:
        return int(self.labels.shape[0])

    @property
    def num_states(self) -> int:
        return int(len(np.unique(self.labels)))

    def change_points(self) -> list[int]:
        """Indices where the state changes (start of each new run, excluding 0)."""
        return (np.where(np.diff(self.labels) != 0)[0] + 1).tolist()

    def segments(self) -> list[Segment]:
        """Expand the label array into a run-length list of segments."""
        bounds = [0, *self.change_points(), self.T]
        segs: list[Segment] = []
        for s, e in zip(bounds[:-1], bounds[1:]):
            conf = float(np.mean(self.confidence[s:e])) if self.confidence is not None else None
            segs.append(Segment(s, e, int(self.labels[s]), conf, self.source))
        return segs

    @classmethod
    def from_segments(cls, segments: list[Segment], T: int, **kw) -> "StateSequence":
        """Rebuild a per-timestep label array from a list of segments."""
        labels = np.zeros(T, dtype=int)
        for seg in segments:
            labels[seg.start : seg.end] = seg.state
        return cls(labels, **kw)


# ---------------------------------------------------------------------------
# Stage 1 (alignment) output: many series sharing one global vocabulary
# ---------------------------------------------------------------------------


@dataclass
class AlignedStates:
    """Several :class:`StateSequence` whose labels are aligned.

    After alignment, ``sequences[i].labels`` and ``sequences[j].labels`` use the *same*
    integer for the same physical state. Every cross-series analysis (stage 4 correlation,
    stage 5 causality) depends on this.
    """

    sequences: list[StateSequence]
    global_label_names: Optional[dict[int, str]] = None

    @property
    def n_series(self) -> int:
        return len(self.sequences)

    @property
    def global_states(self) -> list[int]:
        return sorted({int(s) for seq in self.sequences for s in np.unique(seq.labels)})


# ---------------------------------------------------------------------------
# Stage 4 / stage 5 output
# ---------------------------------------------------------------------------


@dataclass
class CorrelationResult:
    """Result of one correlation analysis between series/states.

    ``kind`` is one of ``overall | partial | transition | time_lagged | structural |
    state_link``. ``matrix`` holds pairwise scores when the analysis is series-vs-series;
    ``pairs`` holds individual findings (e.g. a state of A relates to a state of B at some
    lag). ``state_link`` (Corr_Partial, StaCo eq. 4+5) yields directed, lagged influence
    edges per state pair; see ``stage4_correlation/analyzers.py::StateLinkCorrelation``.
    """

    kind: str
    matrix: Optional[np.ndarray] = None
    labels: Optional[list[str]] = None  # axis labels for ``matrix``
    pairs: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)


@dataclass
class CausalRule:
    """One association/causal rule, e.g. ``A:idle -> B:overload`` at lag 2."""

    antecedent: tuple[str, ...]
    consequent: tuple[str, ...]
    support: float
    confidence: float
    lift: float
    lag: int = 0


@dataclass
class CausalGraph:
    """Discovered state-level causal/association structure (stage 5)."""

    rules: list[CausalRule] = field(default_factory=list)
    method: str = "apriori"
    meta: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Stage 5 (PCMCI+ route): one channel-level causal graph per state
# ---------------------------------------------------------------------------
#
# ``CausalGraph`` / ``CausalRule`` above carry Apriori semantics (cross-series state
# co-occurrence). The types below are a different semantics: conditional-independence
# discovery between *channels* inside each state, with lags. The inputs differ too —
# PCMCI+ needs the raw ``[T, N]`` signal plus state labels ``[T]``, not just label
# sequences — hence separate types rather than reusing the ones above.


@dataclass
class CausalEdge:
    """A directed causal edge: ``src`` at ``t-lag`` drives ``dst`` at ``t``.

    ``lag=0`` is contemporaneous. ``link_type`` uses tigramite link notation (``-->``
    directed, ``o-o`` undirected, ``x-x`` ambiguous). ``strength`` is the PCMCI partial
    correlation test statistic.
    """

    src: str
    dst: str
    lag: int
    strength: float
    link_type: str = "-->"


@dataclass
class StateCausalGraph:
    """Channel-level causal graph inside one state (one masked PCMCI+ run)."""

    state: int
    n_samples: int  # samples kept by the mask for this state (drives statistical power)
    var_names: list[str]
    edges: list["CausalEdge"] = field(default_factory=list)


@dataclass
class PCMCIResult:
    """Full result of a per-state PCMCI+ run (one graph per state)."""

    graphs: list["StateCausalGraph"] = field(default_factory=list)
    params: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)
    eval: Optional[dict] = None  # {precision, recall, f1, ...} when ground truth exists
