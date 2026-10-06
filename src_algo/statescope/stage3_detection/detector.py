"""Stage 3: E2USD state detector (DDEM encoder, DPGMM clustering, window voting)."""

from __future__ import annotations

from typing import Optional

import numpy as np

from statescope.core.registry import register
from statescope.core.types import MTS, StateSequence
from statescope.util import compute_confidence, merge_short_segments, normalize_data, reorder_labels
from statescope.vendor.e2usd import DDEMEncoder, DPGMMClustering


@register("detector", "e2usd")
class E2USDDetector:
    """Efficient unsupervised state detection (E2USD, WWW'24).

    Parameters follow the paper. With ``n_states=None`` the Dirichlet-process prior picks
    the number of states, matching the paper's "novel state perception" goal (§3.3).
    """

    def __init__(
        self,
        win_size: int = 256,
        step: int = 50,
        n_states: Optional[int] = None,
        out_channels: int = 4,
        nb_steps: int = 20,
        lr: float = 0.003,
        alpha: float = 1e3,
        min_seg_len: int = 0,
        seed: Optional[int] = 42,  # deterministic by default; None for a stochastic run
        cuda: bool = False,
        verbose: bool = False,
    ):
        self.win_size = win_size
        self.step = step
        self.n_states = n_states
        self.out_channels = out_channels
        self.nb_steps = nb_steps
        self.lr = lr
        self.alpha = alpha
        self.min_seg_len = min_seg_len
        self.seed = seed
        self.cuda = cuda
        self.verbose = verbose
        self.encoder: Optional[DDEMEncoder] = None

    def fit(self, series: MTS) -> "E2USDDetector":
        if self.seed is not None:
            import torch

            np.random.seed(self.seed)
            torch.manual_seed(self.seed)
        X = normalize_data(series.data, mode="channel")
        self.encoder = DDEMEncoder(
            win_size=self.win_size,
            in_channels=X.shape[1],
            out_channels=self.out_channels,
            nb_steps=self.nb_steps,
            lr=self.lr,
            cuda=self.cuda,
        )
        self.encoder.fit(X, verbose=self.verbose)
        return self

    def predict(self, series: MTS) -> StateSequence:
        # Encode each sliding window, cluster with DPGMM, then vote per timestep
        if self.encoder is None:
            raise RuntimeError("Detector not fitted. Call fit() first.")
        T = series.T
        X = normalize_data(series.data, mode="channel")

        embeddings = self.encoder.encode_windows(X, self.win_size, self.step)
        clustering = DPGMMClustering(n_states=self.n_states, alpha=self.alpha)
        embedding_labels = reorder_labels(clustering.fit(embeddings))
        proba = clustering.predict_proba(embeddings)

        state_seq, vote_proba = self._vote(embedding_labels, proba, T)
        if self.min_seg_len > 1:
            state_seq = merge_short_segments(state_seq, self.min_seg_len)
        confidence = compute_confidence(vote_proba)

        return StateSequence(
            labels=state_seq,
            source="e2usd",
            confidence=confidence,
            name=series.name,
        )

    def _vote(
        self, embedding_labels: np.ndarray, proba: np.ndarray, T: int
    ) -> tuple[np.ndarray, np.ndarray]:
        """Overlapping windows vote for the state of each timestep."""
        n_classes = proba.shape[1]
        vote = np.zeros((T, n_classes))
        for i in range(len(embedding_labels)):
            start = i * self.step
            end = min(start + self.win_size, T)
            vote[start:end] += proba[i]
        row_sums = vote.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1.0
        vote_proba = vote / row_sums
        return np.argmax(vote, axis=1), vote_proba
