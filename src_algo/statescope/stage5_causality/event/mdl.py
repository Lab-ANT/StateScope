"""MDL code lengths in bits over discrete time: Bernoulli per step for rates, geometric for delays."""

from __future__ import annotations

import math

PRECISION = 2  # encoding precision for real parameters (significant digits)


def l_int(n: int) -> float:
    """Rissanen universal integer code length L_N(n) (n ≥ 1)."""
    bits = math.log2(2.865064)
    x = float(n)
    while x > 1:
        x = math.log2(x)
        bits += x
    return bits


def l_real(v: float) -> float:
    """Real parameter code length L_R: scale to PRECISION significant digits, encode as integer, +1 bit."""
    if v == 0 or not math.isfinite(v):
        return 0.0
    v = abs(v)
    s = math.ceil(math.log10((10**PRECISION) / v))
    return 1 + l_int(abs(s) + 1) + l_int(max(1, math.ceil(v * 10.0**s)))


def _xlog2(n: float, p: float) -> float:
    return n * math.log2(p) if n > 0 else 0.0


def bern_nll(n: int, dur: int) -> float:
    """NLL of n occurrences in a region of length dur (Bernoulli per step, MLE p = n/dur)."""
    if n <= 0 or dur <= 0:
        return 0.0
    if n >= dur:
        return 0.0
    p = n / dur
    return -(_xlog2(n, p) + _xlog2(dur - n, 1 - p))


def geom_fit(m: int, dsum: float, d0: int) -> float:
    """MLE p of the geometric delay (support d ≥ d0); p = 1 when all delays equal d0, avoiding infinite NLL."""
    excess = dsum - m * d0
    return 1.0 if excess <= 0 else m / (m + excess)


def geom_nll(m: int, dsum: float, d0: int) -> float:
    """Negative log-likelihood of m delays (sum dsum) under the geometric distribution."""
    if m == 0:
        return 0.0
    p = geom_fit(m, dsum, d0)
    return -(_xlog2(m, p) + _xlog2(dsum - m * d0, 1 - p))


def trigger_nll(m: int, n_parents: int) -> float:
    """Bernoulli cost of trigger probability α (m of n_parents parent occurrences trigger)."""
    return bern_nll(m, n_parents)


def parent_set_cost(n_events: int, k: int) -> float:
    """Choosing k parents among |Σ| events: log2 C(|Σ|, k)."""
    return math.log2(math.comb(n_events, k)) if k > 0 else 0.0
