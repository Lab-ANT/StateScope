"""Slimmed helpers for ISSD channel selection (SIGMOD'25).

Only the functions on the ``ISSD.fit`` call path are vendored, modernized for
numpy>=1.26 / scipy>=1.11 / scikit-learn>=1.4. The one change vs. upstream:
``squareform`` is imported from ``scipy.spatial.distance`` (robust across scipy
versions) instead of via ``scipy.cluster.hierarchy.distance``.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import stats
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.signal import find_peaks
from scipy.spatial.distance import squareform
from sklearn.neighbors import BallTree, KDTree


def is_constant(signal, tolerance=1e-5):
    return np.all(np.abs(np.diff(signal)) < tolerance)


def moving_average(signal, window_size=3):
    num_channels = signal.shape[1]
    channels = []
    for i in range(num_channels):
        if is_constant(signal[:, i]):
            channels.append(signal[:, i])
            continue
        filtered = np.convolve(signal[:, i], np.ones(window_size) / window_size, mode="same")
        channels.append(filtered)
    return np.column_stack(channels)


def matrix_OR(matrices):
    if len(matrices) == 0:
        return None
    result = matrices[0]
    for i in range(1, len(matrices)):
        result = np.logical_or(result, matrices[i])
    return result


def cost(mat, current_matrix):
    """Count positions where ``mat`` is True but ``current_matrix`` is not."""
    return np.sum(np.logical_and(np.logical_not(current_matrix), mat))


def cluster_corr(correlation_matrix, threshold=0.2):
    condensed_matrix = squareform(1 - correlation_matrix)
    linkage_matrix = linkage(condensed_matrix, method="average")
    return fcluster(linkage_matrix, threshold, criterion="distance")


def compact(series):
    compacted = [series[0]]
    pre = series[0]
    for e in series[1:]:
        if e != pre:
            pre = e
            compacted.append(e)
    return compacted


def find_cut_points_from_state_seq(state_seq):
    cut_point_list = []
    c = state_seq[0]
    i = 0
    for i, e in enumerate(state_seq):
        if e != c:
            cut_point_list.append(i)
            c = e
    cut_point_list.insert(0, 0)
    cut_point_list.append(i + 1)
    return cut_point_list


def calculate_true_matrix_cf(state_seq):
    """Same-state segment-pair indicator; singleton states are split in two."""
    cut_points = find_cut_points_from_state_seq(state_seq)
    compacted_seq = compact(state_seq)
    state, count = np.unique(compacted_seq, return_counts=True)
    state_list = []
    for s in compacted_seq:
        if count[state == s] == 1:
            state_list.append(s)
            state_list.append(s)
        else:
            state_list.append(s)
    cps = [0]
    cnt = 0
    for cp in cut_points[1:]:
        if count[state == compacted_seq[cnt]] == 1:
            cps.append(int((cp + cut_points[cnt]) / 2))
            cps.append(cp)
        else:
            cps.append(cp)
        cnt += 1
    num_segments = len(state_list)
    matrix = np.eye(num_segments) == 1
    for i in range(num_segments):
        for j in range(num_segments):
            if i >= j:
                continue
            if state_list[i] == state_list[j]:
                matrix[i, j] = True
                matrix[j, i] = True
    return matrix, cps


def exclude_trival_segments(state_seq, exclude_lenth):
    cps = find_cut_points_from_state_seq(state_seq)
    len_list = np.diff(cps)
    segs = []
    for seg_len in len_list:
        if seg_len > exclude_lenth:
            segs.append(np.ones(seg_len, dtype=bool))
        else:
            segs.append(np.zeros(seg_len, dtype=bool))
    return np.concatenate(segs)


def sample_subseries(X, n, k):
    length = X.shape[0]
    start_points = np.linspace(0, length - k, n, dtype=int)
    return [X[sp : sp + k] for sp in start_points]


def calculate_acf(x, lags):
    x = x.copy().astype(float)
    n = len(x)
    result = [np.correlate(x[i:], x[: n - i]) for i in range(1, lags + 1)]
    return np.array(result)


def find_k_by_acf(x, max_lag=500, default=50):
    x = x.copy()
    number_channels = x.shape[1]
    acf_list = []
    for channel_idx in range(number_channels):
        channel = x[:, channel_idx]
        acf = calculate_acf(channel, max_lag)
        peak, _ = find_peaks(acf.flatten(), height=0, prominence=0.1)
        if len(peak) == 0:
            peak = default
        elif peak[0] > max_lag or peak[0] < 10:
            peak = default
        else:
            peak = peak[0]
        acf_list.append(peak)
    return np.array(acf_list)


def nn_test(sample1, sample2, n, k, nnmethod="ball"):
    """Schilling–Henze nearest-neighbor two-sample statistic in [0, 1]."""
    A1 = [e.flatten() for e in sample_subseries(sample1, n, k)]
    A2 = [e.flatten() for e in sample_subseries(sample2, n, k)]
    p = n * 2
    r = int(math.log(p))
    A = A1 + A2
    T_rp = 0
    tree = KDTree(A, metric="euclidean", leaf_size=10) if nnmethod == "kd" else BallTree(
        A, metric="euclidean", leaf_size=10
    )
    for i in range(p):
        _, idx = tree.query(A[i].reshape(1, -1), k=r + 1)
        idx = idx[0]
        for j in range(r):
            if (i < n and idx[j + 1] < n) or (i >= n and idx[j + 1] >= n):
                T_rp += 1
    return T_rp / (p * r)


def pair_wise_nntest(segments, n, k, method="nn"):
    num_segments = len(segments)
    matrix = np.zeros((num_segments, num_segments))
    for i in range(num_segments):
        for j in range(num_segments):
            if i >= j:
                continue
            if method == "ks":
                result = stats.ks_2samp(segments[i], segments[j])
                matrix[i, j] = matrix[j, i] = result.pvalue
            else:  # 'nn'
                result = nn_test(segments[i], segments[j], n, k)
                matrix[i, j] = matrix[j, i] = result
    return matrix


def pair_wise_nntest_wrapper(args):
    return pair_wise_nntest(**args)
