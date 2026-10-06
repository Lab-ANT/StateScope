"""NIAGARA causal discovery on interval events (event starts only), after Cornanguer et al., AAAI 2026.

Each child picks one mechanism (background / trigger / cond_trigger / cond_pp) by MDL gain; greedy, acyclic.
"""

from __future__ import annotations

import math
import time
from bisect import bisect_left, bisect_right
from itertools import combinations

import numpy as np

from . import events as ev
from .events import IntervalEvents
from .mdl import bern_nll, geom_fit, geom_nll, l_real, parent_set_cost, trigger_nll
from .mechanism import CausalResult, Found, Mechanism


def model_cost(m: Mechanism, n_events: int) -> float:
    """L(κ): log2|Σ| per trigger; conditional parent set log2 C(|Σ|, n_F) + n_F (negation flags);
    OR costs 1 extra bit."""
    cost = len(m.triggers) * math.log2(n_events)
    if m.cond:
        k = len(m.cond)
        cost += parent_set_cost(n_events, k) + k
        if k > 1 and m.op == "or":
            cost += 1
    return cost


def condition_region(E: IntervalEvents, cond: tuple[tuple[int, bool], ...], op: str) -> ev.Region:
    regions = [ev.complement(E.on[c], E.T) if neg else E.on[c] for c, neg in cond]
    r = regions[0]
    for other in regions[1:]:
        r = ev.union(r, other) if op == "or" else ev.intersect(r, other)
    return r


def fit_background(E: IntervalEvents, child: int) -> float:
    n = len(E.starts[child])
    return bern_nll(n, E.T) + l_real(n / E.T)


def fit_cond_pp(E: IntervalEvents, m: Mechanism) -> Found | None:
    region = condition_region(E, m.cond, m.op)
    d_in = ev.measure(region)
    d_out = E.T - d_in
    if d_in == 0:
        return None
    inside = ev.contains(region, E.starts[m.child])
    n_in, n_out = int(inside.sum()), int((~inside).sum())
    if n_in == 0:
        return None
    c, lam0 = n_in / d_in, (n_out / d_out if d_out > 0 else 0.0)
    cost = bern_nll(n_in, d_in) + bern_nll(n_out, d_out) + l_real(c) + l_real(lam0) + model_cost(m, E.n)
    return Found(m, -cost, {"rate": c, "noise_rate": lam0, "n_in": n_in, "n_out": n_out, "coverage": d_in / E.T})


def fit_trigger(E: IntervalEvents, m: Mechanism, allow_instant: bool) -> Found | None:
    """(Conditional) trigger via occurrence matching (NIAGARA Alg. 1); returned ``gain`` holds −cost."""
    (trig,) = m.triggers
    parents = E.starts[trig]
    if m.cond:
        parents = parents[ev.contains(condition_region(E, m.cond, m.op), parents)]
    children = E.starts[m.child]
    P, C = len(parents), len(children)
    if P == 0 or C == 0:
        return None

    d0 = 0 if allow_instant else 1
    search = bisect_right if allow_instant else bisect_left
    avail = sorted(int(p) for p in parents)
    pairs: list[tuple[int, int]] = []
    for c in sorted(int(x) for x in children):
        i = search(avail, c) - 1
        if i >= 0:
            pairs.append((avail.pop(i), c))
    if not pairs:
        return None

    pairs.sort(key=lambda pc: pc[1] - pc[0], reverse=True)
    delays = np.asarray([c - p for p, c in pairs], dtype=float)
    m0 = len(pairs)
    tail_sum = np.concatenate([np.cumsum(delays[::-1])[::-1], [0.0]])

    best: tuple[float, int] | None = None
    for k in range(m0):  # drop k largest-delay pairs; take the global min
        mk = m0 - k
        u = C - mk
        dsum = float(tail_sum[k])
        nll = trigger_nll(mk, P) + geom_nll(mk, dsum, d0) + bern_nll(u, E.T)
        par = l_real(mk / P) + l_real(geom_fit(mk, dsum, d0)) + (l_real(u / E.T) if u else 0.0)
        if best is None or nll + par < best[0]:
            best = (nll + par, k)
    assert best is not None
    cost, k = best
    mk = m0 - k
    dsum = float(tail_sum[k])
    params = {"edges": [{"parent": trig, "alpha": mk / P, "delay_mean": dsum / mk, "n_matched": mk,
                         "n_parents": P}],
              "noise_rate": (C - mk) / E.T}
    matches = sorted(((trig, p, c) for p, c in pairs[k:]), key=lambda x: x[2])
    return Found(m, -(cost + model_cost(m, E.n)), params, matches)


def single_candidates(E: IntervalEvents, child: int, same_series: bool = False) -> list[Mechanism]:
    """Single-parent candidates: trigger S_j → S_i, conditional Poisson on(j) ⇒ S_i."""
    ok = [j for j in range(E.n) if E.allowed_parent(j, child, same_series)]
    return [m for j in ok for m in (Mechanism(child, triggers=(j,)), Mechanism(child, cond=((j, False),)))]


def pair_candidates(E: IntervalEvents, child: int, pool: list[int]) -> list[Mechanism]:
    """Two-parent candidates (combined within ``pool`` only): S_j ∧ on/¬on(k) → S_i, on(j) ∧/∨ on(k) ⇒ S_i."""
    out: list[Mechanism] = []
    for j in pool:
        for k in pool:
            if k == j or E.series[k] == E.series[j]:
                continue
            out.append(Mechanism(child, triggers=(j,), cond=((k, False),)))
            out.append(Mechanism(child, triggers=(j,), cond=((k, True),)))
    for j, k in combinations(pool, 2):
        if E.series[j] == E.series[k]:
            continue
        out.append(Mechanism(child, cond=((j, False), (k, False)), op="and"))
        out.append(Mechanism(child, cond=((j, False), (k, False)), op="or"))
    return out


def candidates(E: IntervalEvents, child: int, same_series: bool = False) -> list[Mechanism]:
    """All candidate mechanisms of a child event (at most two parents, exhaustive)."""
    ok = [j for j in range(E.n) if E.allowed_parent(j, child, same_series)]
    return single_candidates(E, child, same_series) + pair_candidates(E, child, ok)


def _reaches(adj: dict[int, set[int]], src: int, dst: int) -> bool:
    stack, seen = [src], {src}
    while stack:
        u = stack.pop()
        if u == dst:
            return True
        for v in adj.get(u, ()):
            if v not in seen:
                seen.add(v)
                stack.append(v)
    return False


def discover(E: IntervalEvents, allow_instant: bool = True, same_series: bool = False,
             keep_top: int = 5, pair_top: int | None = None) -> CausalResult:
    """``pair_top``: if set, two-parent candidates are formed only among the top single-parent gainers."""
    t0 = time.perf_counter()
    pool: list[Found] = []
    ranked: dict[int, list[Found]] = {}
    n_fits = 0
    for i in range(E.n):
        base = fit_background(E, i)
        scored: list[Found] = []

        def score(ms: list[Mechanism]) -> None:
            nonlocal n_fits
            for m in ms:
                n_fits += 1
                f = fit_trigger(E, m, allow_instant) if m.triggers else fit_cond_pp(E, m)
                if f is None:
                    continue
                f.gain = base + f.gain  # f.gain temporarily holds −cost
                if f.gain > 0:
                    scored.append(f)

        if pair_top is None:
            score(candidates(E, i, same_series))
        else:
            score(single_candidates(E, i, same_series))
            best: dict[int, float] = {}
            for f in scored:
                (p,) = f.mech.parents()
                best[p] = max(best.get(p, 0.0), f.gain)
            top = sorted(best, key=lambda p: (-best[p], p))[:pair_top]
            score(pair_candidates(E, i, top))
        scored.sort(key=lambda f: (-f.gain, f.mech.label(E.names)))
        ranked[i] = scored[:keep_top]
        pool.extend(scored)

    pool.sort(key=lambda f: (-f.gain, f.mech.child, f.mech.label(E.names)))
    chosen: dict[int, Found] = {}
    adj: dict[int, set[int]] = {}
    for f in pool:
        m = f.mech
        if m.child in chosen or any(_reaches(adj, m.child, p) for p in m.parents()):
            continue
        chosen[m.child] = f
        for p in m.parents():
            adj.setdefault(p, set()).add(m.child)
    return CausalResult("niagara", E, chosen, time.perf_counter() - t0, n_fits, ranked)
