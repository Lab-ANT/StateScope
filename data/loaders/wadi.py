"""WADI dataset loader (thin read layer).

Source: SUTD iTrust, WADI.A2_19 Nov 2019. Requires a signed agreement; not redistributable.

This module only reads the preprocessed artefacts (`data/processed/wadi/*.npz`); the zip
conversion and ``WADI_INFO`` live in `data/preprocess/wadi.py`. Nothing is committed; place
the raw archive at `data_origin/WaDi.zip` (see `data_origin/wadi/README.md`).
"""

from __future__ import annotations

from ..preprocess.wadi import WADI_INFO, load_or_build
from ..schema import StandardDataset

__all__ = ["WADI_INFO", "load_wadi"]


def load_wadi(length: int = 9000, k_per_phase: int = 5, **_: object) -> StandardDataset:
    """Read (building first if needed) the WADI dataset.

    Three series = three phases (P1 primary / P2 secondary / P3 return grid), each with
    ``k_per_phase`` selected continuous sensors, downsampled to ``length`` steps. Attack
    labels and the flow topology are in ``extra``.
    """
    return load_or_build(length=length, k_per_phase=k_per_phase)
