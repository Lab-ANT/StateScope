"""DDEM encoder: trains the network (FNCC loss) and encodes sliding windows.

Vendored from the torch-2.x port in labelState; only the ``z_normalize`` import is rewired to
statescope.util.
"""

from __future__ import annotations

import numpy as np
import torch
import torch.utils.data

from statescope.util import z_normalize

from .network import DDEM, FNCCLoss


class _WindowDataset(torch.utils.data.Dataset):
    def __init__(self, data: np.ndarray):
        self.data = data

    def __len__(self):
        return self.data.shape[0]

    def __getitem__(self, index):
        return self.data[index]


class DDEMEncoder:
    """Train DDEM and encode time series windows into embeddings."""

    def __init__(
        self,
        win_size: int = 256,
        in_channels: int = 4,
        out_channels: int = 4,
        batch_size: int = 1,
        nb_steps: int = 20,
        lr: float = 0.003,
        channels: int = 30,
        depth: int = 1,
        reduced_size: int = 80,
        kernel_size: int = 3,
        cuda: bool = False,
        gpu: int = 0,
        M: int = 20,
        N: int = 4,
    ):
        self.win_size = win_size
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.batch_size = batch_size
        self.nb_steps = nb_steps
        self.lr = lr
        self.cuda = cuda
        self.gpu = gpu

        self.network = DDEM(
            in_channels=in_channels,
            channels=channels,
            depth=depth,
            reduced_size=reduced_size,
            out_channels=out_channels,
            kernel_size=kernel_size,
        )
        self.network.double()
        if cuda and torch.cuda.is_available():
            self.network.cuda(gpu)

        self.loss_fn = FNCCLoss(win_size, M, N)
        params_to_update = [p for p in self.network.parameters() if p.requires_grad]
        self.optimizer = torch.optim.Adam(params_to_update, lr=lr)

    def fit(self, X: np.ndarray, verbose: bool = False) -> "DDEMEncoder":
        n_timepoints, n_channels = X.shape
        X_tensor = np.transpose(X).reshape(1, n_channels, -1)
        X_tensor = z_normalize(X_tensor)

        train_dataset = _WindowDataset(X_tensor)
        train_loader = torch.utils.data.DataLoader(
            train_dataset, batch_size=self.batch_size, shuffle=True
        )

        self.network.train()
        step = 0
        while step < self.nb_steps:
            for batch in train_loader:
                if self.cuda and torch.cuda.is_available():
                    batch = batch.cuda(self.gpu)
                self.optimizer.zero_grad()
                loss = self.loss_fn(batch, self.network)
                loss.backward()
                self.optimizer.step()
                step += 1
                if verbose and step % 5 == 0:
                    print(f"Step {step}/{self.nb_steps}, Loss: {loss.item():.4f}")
                if step >= self.nb_steps:
                    break
        return self

    def encode(self, X: np.ndarray, batch_size: int = 500) -> np.ndarray:
        test_dataset = _WindowDataset(X)
        test_loader = torch.utils.data.DataLoader(test_dataset, batch_size=batch_size)
        features = np.zeros((X.shape[0], self.out_channels))
        self.network.eval()
        count = 0
        with torch.no_grad():
            for batch in test_loader:
                if self.cuda and torch.cuda.is_available():
                    batch = batch.cuda(self.gpu)
                embeddings, _, _ = self.network(batch)
                bs = embeddings.shape[0]
                features[count : count + bs] = embeddings.cpu().numpy()
                count += bs
        return features

    def encode_windows(
        self, X: np.ndarray, win_size: int, step: int, batch_size: int = 500
    ) -> np.ndarray:
        n_timepoints, n_channels = X.shape
        X_tensor = np.transpose(X).reshape(1, n_channels, -1)
        X_tensor = z_normalize(X_tensor)
        n_windows = (n_timepoints - win_size) // step + 1
        windows = np.array(
            [X_tensor[0, :, i * step : i * step + win_size] for i in range(n_windows)]
        )
        return self.encode(windows, batch_size)
