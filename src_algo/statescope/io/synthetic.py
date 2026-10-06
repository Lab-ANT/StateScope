"""Synthetic state data for reproducible end-to-end validation.

Generates several multivariate series that share one ground-truth state vocabulary with a
controllable cross-series lag, so
correlation/causality have a real leader-follower signal. Noisy and redundant channels are
injected for the selectors to prune.
"""

from __future__ import annotations

import numpy as np

from statescope.core.types import MTS, StateSequence


def _state_signal(
    state: int, length: int, level_map: np.ndarray, rng: np.random.Generator
) -> np.ndarray:
    """Signal for one state: each (channel, state) gets a distinct constant level, plus a
    light sinusoidal texture and noise. ``level_map`` has shape ``(n_useful, n_states)``;
    each channel orders the states differently, so useful channels are individually
    discriminative yet complementary — exactly what ISSD's completeness logic selects for.
    """
    t = np.arange(length)
    n_useful = level_map.shape[0]
    out = np.zeros((length, n_useful))
    for c in range(n_useful):
        freq = 0.01 * (1 + ((state + c) % 3))
        level = level_map[c, state]
        out[:, c] = level + 0.25 * np.sin(2 * np.pi * freq * t) + rng.normal(0, 0.1, length)
    return out


def _build_level_map(n_useful: int, n_states: int, rng: np.random.Generator) -> np.ndarray:
    """Build an (n_useful, n_states) level table whose codes are complementary."""
    is_pow2 = n_states >= 2 and (n_states & (n_states - 1)) == 0
    if is_pow2 and n_useful <= n_states - 1:
        from scipy.linalg import hadamard

        H = hadamard(n_states)  # +-1, orthogonal rows; row 0 is constant, so skipped
        codes = (H[1 : n_useful + 1] + 1) / 2  # -> {0,1}
        return codes.astype(float) * 2.0
    return np.stack([rng.permutation(n_states) for _ in range(n_useful)]).astype(float) * 1.2


def make_cascading_dataset(
    n_series: int = 3,
    seg_len: int = 600,
    n_useful: int = 3,
    n_noise: int = 5,
    lag: int = 200,
    state_plan: tuple[int, ...] = (0, 1, 2, 1, 3, 0, 2),
    seed: int = 0,
) -> tuple[list[MTS], list[StateSequence]]:
    """Generate ``n_series`` series following one state plan, each lagged ``lag`` steps
    behind the previous one (a cascade down the topology).

    Returns
    ----
    (series, ground_truth) : (list[MTS], list[StateSequence])
        ``series`` holds useful plus noise channels; ``ground_truth`` holds per-timestep
        labels sharing one vocabulary across series.
    """
    rng = np.random.default_rng(seed)
    n_seg = len(state_plan)
    base_T = n_seg * seg_len
    total_T = base_T + lag * (n_series - 1)
    n_states = max(state_plan) + 1

    # One shared (channel, state) level table so the same state maps to the same signal in
    # every series, which cross-series alignment depends on. For power-of-two state counts
    # this uses orthogonal Hadamard codes: each useful channel separates the states only
    # partly, but together they are complete and mutually uncorrelated, which is what lets
    # ISSD pick the whole complementary set.
    level_map = _build_level_map(n_useful, n_states, rng)

    channel_names = [f"u{c}" for c in range(n_useful)] + [f"noise{c}" for c in range(n_noise)]
    series_names = [f"host{si}" for si in range(n_series)]
    label_names = None

    series: list[MTS] = []
    truths: list[StateSequence] = []
    for si in range(n_series):
        shift = si * lag
        labels = np.zeros(total_T, dtype=int)
        useful = np.zeros((total_T, n_useful))
        # Leading idle region (state 0) before the cascade reaches this series
        if shift > 0:
            useful[:shift] = _state_signal(0, shift, level_map, rng)
        last_end = shift
        for k, state in enumerate(state_plan):
            start = shift + k * seg_len
            end = min(start + seg_len, total_T)
            if start >= total_T:
                break
            labels[start:end] = state
            useful[start:end] = _state_signal(state, end - start, level_map, rng)
            last_end = end
        # Trailing idle region (state 0) so no channel ends on a constant-zero run
        if last_end < total_T:
            labels[last_end:] = 0
            useful[last_end:] = _state_signal(0, total_T - last_end, level_map, rng)

        noise = rng.normal(0, 1.0, (total_T, n_noise))  # uninformative noise channels
        data = np.hstack([useful, noise])
        series.append(MTS(data, channel_names=list(channel_names), name=series_names[si]))
        truths.append(StateSequence(
            labels, source="ground_truth", name=series_names[si], label_names=label_names,
        ))
    return series, truths
