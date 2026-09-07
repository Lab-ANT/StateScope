"""ISSD core: completeness-first (CF) and quality-first (QF) channel selection.

Vendored and slimmed from ISSD (SIGMOD'25). The only behavioural difference: with
``n_jobs <= 1`` the per-channel matrices are computed serially instead of via
``multiprocessing.Pool``, avoiding macOS spawn/pickle issues. Results are identical.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.feature_selection import mutual_info_regression

from .miniutils import (
    calculate_true_matrix_cf,
    cluster_corr,
    cost,
    exclude_trival_segments,
    find_k_by_acf,
    matrix_OR,
    moving_average,
    pair_wise_nntest,
)


def compute_matrices(
    indicators, state_seq, num_samples=30, min_seg_len_to_exclude=100,
    two_sample_method="nn", n_jobs=10,
):
    """Per-channel pairwise two-sample test matrices, truth matrix and correlations."""
    indicators = indicators.copy()
    win_size = 10
    offset = win_size // 2
    indicators = moving_average(indicators, window_size=win_size)
    indicators = indicators[offset:-offset, :]
    state_seq = state_seq[offset:-offset]

    if len(indicators) != len(state_seq):
        raise ValueError("indicators and state_seq have different lengths.")

    non_trival_idx = exclude_trival_segments(state_seq, min_seg_len_to_exclude)
    indicators = indicators[non_trival_idx]
    state_seq = state_seq[non_trival_idx]
    num_channels = indicators.shape[1]

    true_matrix, cut_points = calculate_true_matrix_cf(state_seq)
    min_seg_len = int(np.min(np.diff(cut_points)))
    acf = find_k_by_acf(
        indicators, min_seg_len if min_seg_len < 500 else 500, default=min_seg_len - 1
    )

    corr_matrix = pd.DataFrame(indicators).corr(method="pearson").to_numpy().copy()
    corr_matrix[np.isnan(corr_matrix)] = 1  # two constant channels yield nan

    pool_args = []
    for channel_id in range(num_channels):
        segments = [
            indicators[cut_points[i] : cut_points[i + 1], channel_id]
            for i in range(len(cut_points) - 1)
        ]
        pool_args.append(
            {"segments": segments, "n": num_samples, "k": acf[channel_id], "method": two_sample_method}
        )

    if n_jobs and n_jobs > 1:
        import multiprocessing

        with multiprocessing.Pool(processes=n_jobs) as pool:
            matrices = pool.map(_nntest_wrapper, pool_args)
    else:
        matrices = [pair_wise_nntest(**arg) for arg in pool_args]
    matrices = np.stack(matrices)
    return matrices, true_matrix, corr_matrix


def _nntest_wrapper(args):
    return pair_wise_nntest(**args)


class ISSD:
    """Indicator selection for state detection.

    After ``fit``, ``qf_solution`` (quality-first), ``cf_solution`` (completeness-first)
    and ``solution`` (the better of the two under an LDA/mutual-information score) are
    lists of channel indices.
    """

    def __init__(
        self,
        corr_threshold=0.8,
        num_samples=30,
        min_seg_len_to_exclude=100,
        test_method="nn",
        inte_strategy="lda",
        n_jobs=1,
    ):
        self.clustering_threshold = 1 - corr_threshold
        self.num_samples = num_samples
        self.min_seg_len_to_exclude = min_seg_len_to_exclude
        self.test_method = test_method
        self.inte_strategy = inte_strategy
        self.n_jobs = n_jobs

    def compute_matrices(self, datalist, state_seq_list):
        self.datalist = datalist
        self.state_seq_list = state_seq_list
        self.matrices, self.true_matrices, self.corr_matrices = [], [], []
        for data, state_seq in zip(datalist, state_seq_list):
            m, tm, cm = compute_matrices(
                data, state_seq, self.num_samples, self.min_seg_len_to_exclude,
                self.test_method, self.n_jobs,
            )
            self.matrices.append(m.reshape(m.shape[0], -1))
            self.true_matrices.append(tm.flatten())
            self.corr_matrices.append(cm)
        self.corr_matrices = np.array(self.corr_matrices).mean(axis=0)
        self.clusters = cluster_corr(self.corr_matrices, threshold=self.clustering_threshold)

    def get_qf_solution(self, K):
        if len(self.matrices) == 1:
            stacked, stacked_true = self.matrices[0], self.true_matrices[0]
        else:
            stacked, stacked_true = np.hstack(self.matrices), np.hstack(self.true_matrices)
        idx_inner = np.argwhere(stacked_true == True)  # noqa: E712
        idx_inter = np.argwhere(stacked_true == False)  # noqa: E712
        mean_inner = np.mean(stacked[:, idx_inner], axis=1).flatten()
        mean_inter = np.mean(stacked[:, idx_inter], axis=1).flatten()
        interval = mean_inter - mean_inner  # quality: inter- vs intra-state separability

        selected, masked = [], np.array([False] * len(mean_inner))
        while len(selected) < K:
            remaining = np.argwhere(~masked).flatten()
            if len(remaining) == 0:
                break
            idx = remaining[np.argmax(interval[remaining])]
            selected.append(int(idx))
            masked[idx] = True
            masked[self.clusters == self.clusters[idx]] = True
        self.qf_solution = selected
        return selected

    def get_cf_solution(self, K):
        ts_interval, indicator_matrices = [], []
        mean_inner = None
        for ts_matrices, ts_true in zip(self.matrices, self.true_matrices):
            idx_inner = np.argwhere(ts_true == True)  # noqa: E712
            idx_inter = np.argwhere(ts_true == False)  # noqa: E712
            mean_inner = np.mean(ts_matrices[:, idx_inner], axis=1).flatten()
            mean_inter = np.mean(ts_matrices[:, idx_inter], axis=1).flatten()
            max_inner = np.max(ts_matrices[:, idx_inner], axis=1).flatten()
            ts_interval.append(mean_inter - mean_inner)
            ind = np.array([m > tau for m, tau in zip(ts_matrices, max_inner)], dtype=bool)
            indicator_matrices.append(ind)
        interval = np.array(ts_interval).mean(axis=0)
        indicator_matrices = (
            indicator_matrices[0] if len(indicator_matrices) == 1 else np.hstack(indicator_matrices)
        )

        selected, masked = [], np.array([False] * len(mean_inner))
        current_matrix = np.zeros(indicator_matrices.shape).astype(bool)
        while len(selected) < K:
            remaining = np.argwhere(~masked).flatten()
            if len(remaining) == 0:
                break
            costlist = np.array([cost(m, current_matrix) for m in indicator_matrices])
            candidate_c = np.max(costlist[remaining])  # completeness gain
            candidate_idx = remaining[np.argwhere(costlist[remaining] == candidate_c).flatten()]
            idx = candidate_idx[np.argmax(interval[candidate_idx])]  # break ties by quality
            selected.append(int(idx))
            masked[idx] = True
            masked[self.clusters == self.clusters[idx]] = True
            current_matrix = matrix_OR([indicator_matrices[c] for c in selected])
        self.cf_solution = selected
        return selected

    def inte_solution(self):
        score_qf = score_cf = 0
        for data, state_seq in zip(self.datalist, self.state_seq_list):
            rq, rc = data[:, self.qf_solution], data[:, self.cf_solution]
            if self.inte_strategy == "lda":
                lq = LinearDiscriminantAnalysis(n_components=1).fit_transform(rq, state_seq)
                lc = LinearDiscriminantAnalysis(n_components=1).fit_transform(rc, state_seq)
                score_qf += np.sum(mutual_info_regression(lq, state_seq))
                score_cf += np.sum(mutual_info_regression(lc, state_seq))
            elif self.inte_strategy == "pca":
                pq = PCA(n_components=1).fit_transform(rq)
                pc = PCA(n_components=1).fit_transform(rc)
                score_qf += np.sum(mutual_info_regression(pq, state_seq))
                score_cf += np.sum(mutual_info_regression(pc, state_seq))
            else:  # 'mi'
                score_qf += np.sum(mutual_info_regression(rq, state_seq))
                score_cf += np.sum(mutual_info_regression(rc, state_seq))
        self.solution = self.qf_solution if score_qf >= score_cf else self.cf_solution
        return self.solution

    def fit(self, datalist, state_seq_list, K):
        self.compute_matrices(datalist, state_seq_list)
        self.get_qf_solution(K)
        self.get_cf_solution(K)
        self.inte_solution()
        return self
