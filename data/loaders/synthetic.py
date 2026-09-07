"""Synthetic dataset loader wrapping ``statescope.io.synthetic.make_cascading_dataset``.

Tunable knobs: number of series, lag, segment length, useful and noise channel counts.
"""

from __future__ import annotations

from statescope.io.synthetic import make_cascading_dataset

from ..schema import DatasetInfo, StandardDataset


def load_abstract(
    n_series: int = 3, seg_len: int = 400, n_useful: int = 3, n_noise: int = 5,
    lag: int = 150, seed: int = 1, **_: object,
) -> StandardDataset:
    series, truth = make_cascading_dataset(
        n_series=n_series, seg_len=seg_len, n_useful=n_useful, n_noise=n_noise,
        lag=lag, seed=seed,
    )
    info = _ABSTRACT_INFO
    return StandardDataset(info=info, series=series, ground_truth=truth, state_names=None)


_ABSTRACT_INFO = DatasetInfo(
    id="synthetic_abstract",
    label="Abstract synthetic (cascading states)",
    group="synthetic",
    source="StateScope synthetic generator (Hadamard orthogonal-code levels + lagged cascade)",
    background="Reproducible synthetic data: several series share one state vocabulary and "
    "cascade into each other with a lag, plus injected redundant/noisy channels. Ships "
    "per-timestep ground truth, so ARI is computable end to end.",
    available=True,
    tunable=True,
)


