"""Unified data contracts shared by every pipeline stage (numpy + stdlib only).

``Segment`` / ``StateSequence`` mirror labelState's types so they round-trip without translation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np


@dataclass
class MTS:
    """A multivariate time series; ``data`` has shape ``(T, C)``."""

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
        """Return a new MTS keeping only ``indices``."""
        names = [self.channel_names[i] for i in indices]
        return MTS(self.data[:, indices], names, self.timestamps, self.name)


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
    """Per-timestep state labels for one series."""

    labels: np.ndarray  # shape (T,), int
    label_names: Optional[dict[int, str]] = None
    source: str = "unknown"
    confidence: Optional[np.ndarray] = None  # shape (T,), float in [0, 1]
    name: str = "series"

    def __post_init__(self) -> None:
        self.labels = np.asarray(self.labels).astype(int)

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


@dataclass
class AlignedStates:
    """A set of time-aligned state sequences, the input of stages 4 and 5."""

    sequences: list[StateSequence]


@dataclass
class CorrelationResult:
    """Result of one correlation analysis.

    ``matrix`` holds series-vs-series scores; ``pairs`` holds individual state-level findings.
    """

    kind: str
    matrix: Optional[np.ndarray] = None
    labels: Optional[list[str]] = None  # axis labels for ``matrix``
    pairs: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)


@dataclass
class StateMechanism:
    """Mechanism for one effect event: trigger parents plus conditions ``[(event, negated)]``.

    Events are named ``"<series>:<state>"``; ``matches`` holds ``(parent, parent time, child start)``.
    """

    child: str
    triggers: list[str]
    cond: list[tuple[str, bool]]
    op: str
    kind: str
    gain: float                    # MDL gain in bits over the background-only model
    params: dict = field(default_factory=dict)
    matches: list[tuple[str, int, int]] = field(default_factory=list)


@dataclass
class StateCausalResult:
    """Result of one state-causality run; ``mechanisms`` sorted by gain, descending.

    ``dropped`` lists state events excluded for too few occurrences.
    """

    engine: str
    events: list[dict] = field(default_factory=list)
    dropped: list[dict] = field(default_factory=list)
    mechanisms: list[StateMechanism] = field(default_factory=list)
    params: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)
