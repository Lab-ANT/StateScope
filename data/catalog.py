"""Dataset catalog: selectable datasets and the loader for each id (download-only ones are listed too)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .loaders import lemma_rca as _lemma
from .loaders import petshop as _petshop
from .loaders import synthetic as _syn
from .loaders import wadi as _wadi
from .schema import DatasetInfo, StandardDataset

Loader = Callable[..., StandardDataset]


@dataclass
class CatalogEntry:
    info: DatasetInfo
    load: Optional[Loader]  # None: listed but not integrated


def _build() -> dict[str, CatalogEntry]:
    entries: list[CatalogEntry] = []

    entries.append(CatalogEntry(_syn._ABSTRACT_INFO, _syn.load_abstract))

    # WADI first: the frontend defaults to it and falls back to PetShop when its data is missing.
    entries.append(CatalogEntry(_wadi.WADI_INFO, _wadi.load_wadi))
    entries.append(CatalogEntry(_petshop.PETSHOP_INFO, _petshop.load_petshop))
    entries.append(CatalogEntry(_lemma.LEMMA_RCA_INFO, _lemma.load_lemma_rca))

    return {e.info.id: e for e in entries}


CATALOG: dict[str, CatalogEntry] = _build()


def list_infos() -> list[DatasetInfo]:
    return [e.info for e in CATALOG.values()]


def get_entry(dataset_id: str) -> CatalogEntry:
    if dataset_id not in CATALOG:
        raise KeyError(f"unknown dataset '{dataset_id}'. available: {list(CATALOG)}")
    return CATALOG[dataset_id]
