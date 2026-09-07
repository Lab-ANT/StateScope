"""Data layer: stores datasets, standardises them, and lists what is available.

Three entry points are exposed to the API and the pipeline:

    from data import list_datasets, load_dataset, StandardDataset

    list_datasets() -> list[DatasetInfo]         # catalog of selectable datasets
    load_dataset(id, **opts) -> StandardDataset  # load by id, standardised

The shared structure lives in ``data/schema.py`` (``StandardDataset``: series, optional
ground truth, stats). Loaders are in ``data/loaders/`` and the catalog in ``data/catalog.py``.
"""

from __future__ import annotations

from .catalog import get_entry, list_infos
from .schema import DatasetInfo, StandardDataset

__all__ = ["list_datasets", "load_dataset", "StandardDataset", "DatasetInfo"]


def list_datasets() -> list[DatasetInfo]:
    """List metadata for every selectable dataset."""
    return list_infos()


def load_dataset(dataset_id: str, **opts: object) -> StandardDataset:
    """Load a dataset by id as a ``StandardDataset``.

    ``opts`` is forwarded to the loader (e.g. the synthetic n_series/lag knobs).
    """
    entry = get_entry(dataset_id)
    if entry.load is None:
        raise ValueError(
            f"dataset '{dataset_id}' is listed but not integrated: {entry.info.note or 'unavailable'}"
        )
    return entry.load(**opts)
