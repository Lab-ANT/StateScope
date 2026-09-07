"""Numeric helpers shared across stages.

Adapted from labelState's ``algorithms/utils.py`` (updated for numpy>=1.26). Kept
dependency-light (numpy + stdlib) so every stage and the vendored detectors can import it.
"""

from __future__ import annotations

import math

import numpy as np


def normalize_data(X: np.ndarray, mode: str = "channel") -> np.ndarray:
    """Min-max normalisation, per channel (default) or global."""
    X = X.copy().astype(np.float64)
    if mode == "channel":
        for i in range(X.shape[1]):
            lo, hi = np.min(X[:, i]), np.max(X[:, i])
            if hi - lo > 0:
                X[:, i] = (X[:, i] - lo) / (hi - lo)
    elif mode == "all":
        lo, hi = np.min(X), np.max(X)
        if hi - lo > 0:
            X = (X - lo) / (hi - lo)
    return X


def z_normalize(data: np.ndarray) -> np.ndarray:
    """Z-score standardisation over the whole array."""
    mean = np.mean(data)
    var = np.var(data)
    if var > 0:
        data = (data - mean) / math.sqrt(var)
    return data


def reorder_labels(labels: np.ndarray) -> np.ndarray:
    """Renumber labels to 0, 1, 2, ... in order of first appearance."""
    labels = np.asarray(labels)
    seen: list[int] = []
    for v in labels:
        if int(v) not in seen:
            seen.append(int(v))
    mapping = {old: new for new, old in enumerate(seen)}
    return np.array([mapping[int(v)] for v in labels], dtype=int)


def find_change_points(labels: np.ndarray) -> list[int]:
    """Indices where adjacent labels differ."""
    return (np.where(np.diff(labels) != 0)[0] + 1).tolist()


def get_run_length_segments(state_seq: np.ndarray) -> list[tuple[int, int, int]]:
    """Run-length encode into ``(start, end_exclusive, label)`` tuples."""
    state_seq = np.asarray(state_seq, dtype=int)
    if state_seq.size == 0:
        return []
    change_idx = np.where(np.diff(state_seq) != 0)[0] + 1
    bounds = np.concatenate(([0], change_idx, [len(state_seq)]))
    return [
        (int(bounds[i]), int(bounds[i + 1]), int(state_seq[bounds[i]]))
        for i in range(len(bounds) - 1)
    ]


def merge_short_segments(state_seq: np.ndarray, min_duration: int = 200) -> np.ndarray:
    """Greedily merge runs shorter than ``min_duration`` into the longer neighbour
    (ties go left). Output is renumbered to 0..K-1."""
    result = np.asarray(state_seq, dtype=int).copy()
    if result.size == 0 or min_duration <= 1:
        return reorder_labels(result)
    while True:
        segments = get_run_length_segments(result)
        if len(segments) <= 1:
            break
        lengths = [e - s for s, e, _ in segments]
        min_len = min(lengths)
        if min_len >= min_duration:
            break
        idx = lengths.index(min_len)
        s, e, _ = segments[idx]
        left_len = lengths[idx - 1] if idx > 0 else -1
        right_len = lengths[idx + 1] if idx < len(segments) - 1 else -1
        merge_label = segments[idx - 1][2] if left_len >= right_len else segments[idx + 1][2]
        result[s:e] = merge_label
    return reorder_labels(result)


def compute_confidence(probabilities: np.ndarray) -> np.ndarray:
    """Per-timestep confidence = 1 - normalised entropy of the class probabilities."""
    n_classes = probabilities.shape[1]
    if n_classes <= 1:
        return np.ones(probabilities.shape[0])
    p = np.clip(probabilities, 1e-12, 1.0)
    entropy = -np.sum(p * np.log(p), axis=1)
    return 1.0 - entropy / np.log(n_classes)
