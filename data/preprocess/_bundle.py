"""Compact serialisation helpers for the processed-data artefacts.

Preprocess modules write a ``StandardDataset`` with ``save_bundle`` into one ``.npz``; the
matching loader reads it back with ``load_bundle``, so the round trip lives in one place.

Convention: all ``series`` share length and channel set, so they stack into
``data[n_series, T, C]``. ``ground_truth`` is optional (``labels[n_series, T]`` +
``label_names``).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from statescope.core.types import MTS, StateSequence

from ..schema import DatasetInfo, StandardDataset


def save_bundle(path: Path, ds: StandardDataset) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.stack([np.asarray(s.data, dtype=float) for s in ds.series], axis=0)  # [n,T,C]
    fields: dict = {
        "data": data,
        "series_names": np.array([s.name or f"s{i}" for i, s in enumerate(ds.series)], dtype=object).astype(str),
        "channel_names": np.array(list(ds.series[0].channel_names or []), dtype=str),
        "extra_json": json.dumps(ds.extra, ensure_ascii=False),
        "state_names_json": json.dumps(ds.state_names, ensure_ascii=False),
        "has_truth": np.array(ds.ground_truth is not None),
    }
    if ds.ground_truth is not None:
        fields["labels"] = np.stack([np.asarray(t.labels, dtype=int) for t in ds.ground_truth], axis=0)
        fields["label_names_json"] = json.dumps(ds.ground_truth[0].label_names or {}, ensure_ascii=False)
    np.savez_compressed(path, **fields)


def load_bundle(path: Path, info: DatasetInfo) -> StandardDataset:
    npz = np.load(path, allow_pickle=False)
    data = npz["data"]
    names = [str(x) for x in npz["series_names"]]
    ch = [str(x) for x in npz["channel_names"]]
    extra = json.loads(str(npz["extra_json"]))
    state_names_raw = json.loads(str(npz["state_names_json"]))
    state_names = {int(k): v for k, v in state_names_raw.items()} if state_names_raw else None
    series = [MTS(data[i], channel_names=list(ch), name=names[i]) for i in range(data.shape[0])]

    ground_truth = None
    if bool(npz["has_truth"]):
        labels = npz["labels"]
        ln_raw = json.loads(str(npz["label_names_json"]))
        label_names = {int(k): v for k, v in ln_raw.items()}
        ground_truth = [
            StateSequence(labels[i].astype(int), source="truth", name=names[i], label_names=label_names)
            for i in range(labels.shape[0])
        ]
    return StandardDataset(info=info, series=series, ground_truth=ground_truth,
                           state_names=state_names, extra=extra)
