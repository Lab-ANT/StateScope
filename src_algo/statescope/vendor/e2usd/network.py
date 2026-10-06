"""E2USD DDEM network and FNCC loss.

Vendored verbatim from the modernised torch-2.x port in labelState. Original paper:
E2USD (WWW'24), "Efficient-yet-effective Unsupervised State Detection".
"""

import numpy as np
import torch
import torch.nn as nn


class MovingAvg(nn.Module):
    """Moving-average block used for series decomposition."""

    def __init__(self, kernel_size: int, stride: int = 1):
        super().__init__()
        self.kernel_size = kernel_size
        self.avg = nn.AvgPool1d(kernel_size=kernel_size, stride=stride, padding=0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        front = x[:, :, 0:1].repeat(1, 1, (self.kernel_size - 1) // 2)
        end = x[:, :, -1:].repeat(1, 1, (self.kernel_size - 1) // 2)
        x = torch.cat([front, x, end], dim=-1)
        return self.avg(x)


class SeriesDecomp(nn.Module):
    """Decompose a series into trend and seasonal parts."""

    def __init__(self, kernel_size: int = 5):
        super().__init__()
        self.moving_avg = MovingAvg(kernel_size, stride=1)

    def forward(self, x: torch.Tensor):
        moving_mean = self.moving_avg(x)
        residual = x - moving_mean
        return residual, moving_mean  # seasonal, trend


class DDEM(nn.Module):
    """Deep decomposition embedding model: window -> fixed-length embedding."""

    def __init__(
        self,
        in_channels: int,
        channels: int = 30,
        depth: int = 1,
        reduced_size: int = 80,
        out_channels: int = 4,
        kernel_size: int = 3,
    ):
        super().__init__()
        self.decomposition = SeriesDecomp(kernel_size=5)
        self.trend_cnn = nn.Conv1d(in_channels, reduced_size, kernel_size=kernel_size)
        self.seasonal_cnn = nn.Conv1d(in_channels, reduced_size, kernel_size=kernel_size)
        # Freeze the conv layers; only the linear head is trained.
        self.trend_cnn.requires_grad_(False)
        self.seasonal_cnn.requires_grad_(False)
        self.trend_pooling = nn.AdaptiveMaxPool1d(1)
        self.seasonal_pooling = nn.AdaptiveMaxPool1d(1)
        self.linear_trend = nn.Linear(reduced_size, out_channels)
        self.linear_seasonal = nn.Linear(reduced_size, out_channels)
        self.linear = nn.Linear(out_channels * 2, out_channels)
        self.trade_off_freq = 33

    def forward(self, x: torch.Tensor):
        # Low-frequency filtering via FFT (torch 2.x rfft/irfft).
        low_specx = torch.fft.rfft(x, dim=-1)
        low_specx = low_specx[:, :, : self.trade_off_freq]
        x = torch.fft.irfft(low_specx, dim=-1) * self.trade_off_freq / x.size(-1)

        seasonal_init, trend_init = self.decomposition(x)
        trend_x = self.trend_cnn(trend_init)
        seasonal_x = self.seasonal_cnn(seasonal_init)
        trend_x_reduced = self.trend_pooling(trend_x).squeeze(2)
        seasonal_x_reduced = self.seasonal_pooling(seasonal_x).squeeze(2)
        trend_embedding = self.linear_trend(trend_x_reduced)
        seasonal_embedding = self.linear_seasonal(seasonal_x_reduced)
        embedding = torch.cat([trend_embedding, seasonal_embedding], dim=-1)
        embedding = self.linear(embedding)
        return embedding, trend_embedding, seasonal_embedding


class FNCCLoss(nn.Module):
    """Frequency-based neighbourhood contrastive clustering loss (FNCC)."""

    def __init__(self, win_size: int, M: int = 20, N: int = 4, win_type: str = "rect"):
        super().__init__()
        self.win_size = win_size
        self.M = M
        self.N = N

    def forward(self, batch: torch.Tensor, encoder: nn.Module, save_memory: bool = False):
        M = self.M
        N = self.N
        length_pos_neg = self.win_size
        total_length = batch.size(2)

        total_embeddings = []
        total_trend_embeddings = []
        total_seasonal_embeddings = []
        loss1 = 0
        size_repr = None

        for _ in range(M):
            random_pos = np.random.randint(0, high=total_length - length_pos_neg * 2 + 1, size=1)
            rand_samples = [
                batch[0, :, i : i + length_pos_neg]
                for i in range(random_pos[0], random_pos[0] + N)
            ]
            intra_sample = torch.stack(rand_samples)
            embeddings, trend_emb, seasonal_emb = encoder(intra_sample)
            total_embeddings.append(embeddings)
            total_trend_embeddings.append(trend_emb)
            total_seasonal_embeddings.append(seasonal_emb)
            size_repr = embeddings.size(1)
            for i in range(N):
                for j in range(i + 1, N):
                    similarity = torch.bmm(
                        embeddings[i].view(1, 1, size_repr),
                        embeddings[j].view(1, size_repr, 1),
                    )
                    loss1 -= torch.mean(torch.nn.functional.logsigmoid(similarity))

        loss2 = 0
        smi = []
        loss2_items = []
        total_number = 0
        for i in range(M):
            for ii in range(N):
                for j in range(i + 1, M):
                    for jj in range(N):
                        total_number += 1
                        sim_trend = torch.bmm(
                            total_trend_embeddings[i][ii].view(1, 1, size_repr),
                            total_trend_embeddings[j][jj].view(1, size_repr, 1),
                        )
                        sim_seasonal = torch.bmm(
                            total_seasonal_embeddings[i][ii].view(1, 1, size_repr),
                            total_seasonal_embeddings[j][jj].view(1, size_repr, 1),
                        )
                        loss2_term = torch.bmm(
                            total_embeddings[i][ii].view(1, 1, size_repr),
                            total_embeddings[j][jj].view(1, size_repr, 1),
                        )
                        smi_value = sim_trend * sim_seasonal
                        smi.append(smi_value.item())
                        loss2_items.append(loss2_term)

        sorted_indices = sorted(range(len(smi)), key=lambda k: smi[k])
        half_index = len(sorted_indices) // 2
        for idx in sorted_indices[:half_index]:
            loss2 += loss2_items[idx]

        loss1 = loss1 / (M * N * (N - 1) / 2)
        loss2 = loss2 / (total_number / 2) if total_number > 0 else 0
        return loss1 + loss2
