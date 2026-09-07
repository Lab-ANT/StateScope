"""PetShop dataset loader (thin read layer).

Source: *The PetShop Dataset - Finding Causes of Performance Issues across Microservices*
(Hardt et al., CLeaR 2024, arXiv:2311.04806). Data licensed CC-BY-4.0.

This module only reads the preprocessed artefacts (`data/processed/petshop/*.npz`). The raw
CSV conversion and the ``PETSHOP_INFO`` metadata live in `data/preprocess/petshop.py`;
artefacts are built on first use if missing.
"""

from __future__ import annotations

from ..preprocess.petshop import PETSHOP_INFO, load_or_build
from ..schema import StandardDataset

__all__ = ["PETSHOP_INFO", "load_petshop"]


def load_petshop(
    scenario: str = "temporal_traffic1", n_services: int = 6, n_decoys: int = 2,
    select_by: str = "core", **_: object,
) -> StandardDataset:
    """Read (building first if needed) the PetShop dataset. Options pass through.

    ``n_services``: how many services to keep (one series each). ``select_by``: ``core``
    (default, hubs of the call topology) or ``busy`` (by request volume). ``n_decoys``:
    injected demo noise channels (0 = real metrics only; default 2, to show stage-2
    selection pruning uninformative channels).
    """
    return load_or_build(scenario, n_services, n_decoys, select_by)
