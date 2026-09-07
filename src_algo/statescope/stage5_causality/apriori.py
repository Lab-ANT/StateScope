"""Stage 5 — state causality via Apriori association rules.

Mines cross-series state co-occurrence, then orients each rule by temporal order to get a
leader/follower "pseudo-causal" direction — an approximation of the paper's
transition-triggered framing.

Pipeline:
  1. Slide a window over the aligned sequences; each window is a transaction whose items are
     ``"<series>=<global state>"`` (the dominant state of that series in the window).
  2. Apriori -> frequent itemsets -> association rules (support/confidence/lift).
  3. For each cross-series single-item rule, compare the mean occurrence time of antecedent
     and consequent: the earlier one is the cause and the difference is the lag.

This is association plus temporal order, not proven causality. A structural causal
discovery method can replace it behind the same ``CausalDiscoverer`` interface.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from mlxtend.frequent_patterns import apriori, association_rules

from statescope.core.registry import register
from statescope.core.types import AlignedStates, CausalGraph, CausalRule


def _dominant(segment: np.ndarray) -> int:
    return int(np.bincount(segment).argmax())


@register("causality", "apriori")
class AprioriCausalDiscoverer:
    def __init__(
        self,
        win: int = 100,
        stride: int = 50,
        min_support: float = 0.05,
        min_confidence: float = 0.5,
        max_lag: int | None = None,
    ):
        self.win = win
        self.stride = stride
        self.min_support = min_support
        self.min_confidence = min_confidence
        self.max_lag = max_lag

    def discover(self, aligned: AlignedStates) -> CausalGraph:
        seqs = aligned.sequences
        names = [s.name or f"series{i}" for i, s in enumerate(seqs)]
        T = min(s.T for s in seqs)

        # --- 1. Build sliding-window transactions + mean occurrence time per item ---
        starts = range(0, max(1, T - self.win + 1), self.stride)
        rows: list[dict[str, bool]] = []
        onset_sum: dict[str, float] = {}
        onset_cnt: dict[str, int] = {}
        for st in starts:
            center = st + self.win // 2
            row: dict[str, bool] = {}
            for nm, s in zip(names, seqs):
                item = f"{nm}=S{_dominant(s.labels[st : st + self.win])}"
                row[item] = True
                onset_sum[item] = onset_sum.get(item, 0.0) + center
                onset_cnt[item] = onset_cnt.get(item, 0) + 1
            rows.append(row)
        mean_time = {it: onset_sum[it] / onset_cnt[it] for it in onset_sum}

        df = pd.DataFrame(rows).fillna(False).astype(bool)
        if df.shape[1] < 2:
            return CausalGraph(rules=[], method="apriori", meta={"reason": "too few items"})

        # --- 2. Frequent itemsets + association rules ---
        freq = apriori(df, min_support=self.min_support, use_colnames=True)
        if freq.empty:
            return CausalGraph(rules=[], method="apriori", meta={"reason": "no frequent itemsets"})
        rules = association_rules(freq, metric="confidence", min_threshold=self.min_confidence)

        # --- 3. Keep cross-series single-item rules and orient them by time ---
        seen: set[tuple[str, str]] = set()
        out: list[CausalRule] = []
        for _, r in rules.iterrows():
            ante, cons = tuple(r["antecedents"]), tuple(r["consequents"])
            if len(ante) != 1 or len(cons) != 1:
                continue
            a, b = ante[0], cons[0]
            if a.split("=")[0] == b.split("=")[0]:
                continue  # same series: not a cross-series influence
            # Orient forward in time: the cause occurs earlier on average
            lag = mean_time[b] - mean_time[a]
            if lag < 0:
                a, b, lag = b, a, -lag
            if self.max_lag is not None and lag > self.max_lag:
                continue
            key = (a, b)
            if key in seen:
                continue
            seen.add(key)
            out.append(CausalRule(
                antecedent=(a,), consequent=(b,),
                support=round(float(r["support"]), 4),
                confidence=round(float(r["confidence"]), 4),
                lift=round(float(r["lift"]), 3),
                lag=int(round(lag)),
            ))
        out.sort(key=lambda c: (c.lift, c.confidence), reverse=True)
        return CausalGraph(
            rules=out, method="apriori",
            meta={"win": self.win, "stride": self.stride, "n_transactions": len(rows)},
        )
