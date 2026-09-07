"""LEMMA-RCA dataset loader (thin read layer).

Source: Zheng et al., NeurIPS 2024 D&B; HF ``Lemma-RCA-NEC``; licensed CC-BY-ND-4.0.

This module only reads the preprocessed artefacts (`data/processed/lemma_rca/*.npz`); the
zip conversion and ``LEMMA_RCA_INFO`` live in `data/preprocess/lemma_rca.py`. Neither the
raw data nor the artefacts are committed (CC-BY-ND); place the raw zip in
`data_origin/lemma_rca/` (see the README there).
"""

from __future__ import annotations

from ..preprocess.lemma_rca import LEMMA_RCA_INFO, load_or_build
from ..schema import StandardDataset

__all__ = ["LEMMA_RCA_INFO", "load_lemma_rca"]


def load_lemma_rca(
    domain: str = "product_review", date: str | None = None,
    n_pods: int = 4, length: int = 6000, **_: object,
) -> StandardDataset:
    """Read (building first if needed) the LEMMA-RCA dataset.

    ``domain``: product_review | cloud_computing. ``date``: fault date (None = domain
    default). ``n_pods`` / ``length``: number of top pods and downsampled steps.

    ``n_pods=4`` by default: on product_review this selects the Bookinfo services
    catalogue/productpage/reviews/details, which keeps the co-occurrence matrix readable
    (6 pairs), the state NMI moderate (~0.6 rather than the ~0.9 of 5 pods) and the cluster
    graph at 12 channel nodes. Larger values show more services but denser relations.
    """
    return load_or_build(domain, date, n_pods, length)
