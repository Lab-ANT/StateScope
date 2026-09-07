"""Shared data structures of the data layer.

Every dataset (synthetic or public) is standardised into ``StandardDataset`` so the rest of
the project can consume it directly:

    StandardDataset
      ├─ info: DatasetInfo            # name, source, background, availability
      ├─ series: list[MTS]            # one multivariate series per host/entity
      ├─ ground_truth: list[StateSequence] | None   # per-timestep truth, if any
      └─ extra: dict                  # dataset-specific assets (e.g. dependency graph)

``series`` / ``ground_truth`` use the ``statescope.core.types`` contracts directly, so no
conversion is needed downstream. ``stats()`` feeds the dataset overview in the UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from statescope.core.types import MTS, StateSequence


@dataclass
class DatasetInfo:
    """Metadata for one selectable dataset."""

    id: str
    label: str  # display name
    group: str  # "synthetic" | "public"
    source: str  # citation / provenance and licence
    background: str  # domain background
    available: bool = True  # False: listed but needs a download or extra dependency
    note: str = ""  # reason for unavailability, or any caveat
    tunable: bool = False  # exposes generator knobs (synthetic only)


@dataclass
class StandardDataset:
    """A dataset standardised for downstream consumption."""

    info: DatasetInfo
    series: list[MTS]
    ground_truth: list[StateSequence] | None = None
    state_names: dict[int, str] | None = None
    extra: dict = field(default_factory=dict)

    def stats(self) -> dict:
        """Overview: series count, length, channels, states, ground truth."""
        lengths = [int(s.T) for s in self.series]
        n_channels = int(self.series[0].C) if self.series else 0
        has_gt = self.ground_truth is not None
        n_states = None
        if has_gt:
            states: set[int] = set()
            for t in self.ground_truth:  # type: ignore[union-attr]
                states.update(int(x) for x in set(t.labels.tolist()))
            n_states = len(states)
        # Report the size of dataset-specific assets (dependency graph, root causes, ...).
        extra_summary = {
            k: len(v) for k, v in self.extra.items() if isinstance(v, (list, tuple)) and v
        }
        return {
            "n_series": len(self.series),
            "length_min": min(lengths) if lengths else 0,
            "length_max": max(lengths) if lengths else 0,
            "total_samples": sum(lengths),
            "n_channels": n_channels,
            "channel_names": list(self.series[0].channel_names or []) if self.series else [],
            "n_states": n_states,  # None when there is no ground truth
            "has_ground_truth": has_gt,
            "state_names": self.state_names,
            "extra": extra_summary,  # e.g. {"dependency_graph": 44, "root_causes": 26}
        }
