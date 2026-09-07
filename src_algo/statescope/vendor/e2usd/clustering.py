"""Dirichlet-process Gaussian mixture clustering over window embeddings."""

from __future__ import annotations

from typing import Optional

import numpy as np
from sklearn import mixture


class DPGMMClustering:
    """Bayesian GMM with a Dirichlet-process prior: unused states are pruned."""

    def __init__(self, n_states: Optional[int] = None, alpha: float = 1e3):
        self.alpha = alpha
        self.n_states = n_states if n_states is not None else 20
        self.model: Optional[mixture.BayesianGaussianMixture] = None

    def fit(self, X: np.ndarray) -> np.ndarray:
        self.model = mixture.BayesianGaussianMixture(
            init_params="kmeans",
            n_components=self.n_states,
            covariance_type="full",
            weight_concentration_prior=self.alpha,
            weight_concentration_prior_type="dirichlet_process",
            max_iter=1000,
            random_state=42,
        )
        self.model.fit(X)
        return self.model.predict(X)

    def predict(self, X: np.ndarray) -> np.ndarray:
        if self.model is None:
            raise RuntimeError("Model not fitted. Call fit() first.")
        return self.model.predict(X)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self.model is None:
            raise RuntimeError("Model not fitted. Call fit() first.")
        return self.model.predict_proba(X)
