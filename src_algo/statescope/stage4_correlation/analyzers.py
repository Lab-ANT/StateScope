"""Stage 4 — state correlation detection.

The paper's five correlation types plus the lagged partial correlation of StaCo eq. 5:

* OverallCorrelation    - global agreement between two sequences (ARI / NMI).
* TransitionCorrelation - do state changes co-occur within a tolerance window?
* PartialCorrelation    - does a specific state of A co-occur with one of B, scored by lift.
* TimeLaggedCorrelation - shift one sequence by a small lag and take the best agreement,
  revealing leader/follower direction.
* StructuralCorrelation - Allen interval relations between same-state intervals
  （Precedes / Overlaps / Contains / …）。
* StateLinkCorrelation  - Corr_Partial (StaCo eq. 4+5): per state pair, search the best
  lag under Jaccard overlap and emit directed "service:state -lag-> service:state" edges,
  separating contemporaneous co-occurrence from lagged influence.

All analysers assume the sequences are time-aligned; unequal lengths are truncated to the
shortest (noted in ``meta``).
"""

from __future__ import annotations

import numpy as np
from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

from statescope.core.registry import register
from statescope.core.types import AlignedStates, CorrelationResult


def _min_len(aligned: AlignedStates) -> int:
    return min(seq.T for seq in aligned.sequences)


def _names(aligned: AlignedStates) -> list[str]:
    return [seq.name or f"series{i}" for i, seq in enumerate(aligned.sequences)]


@register("correlation", "overall")
class OverallCorrelation:
    kind = "overall"

    def __init__(self, metric: str = "nmi"):
        self.metric = metric
        self._fn = adjusted_rand_score if metric == "ari" else normalized_mutual_info_score

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        T = _min_len(aligned)
        seqs = [seq.labels[:T] for seq in aligned.sequences]
        n = len(seqs)
        M = np.eye(n)
        for i in range(n):
            for j in range(i + 1, n):
                M[i, j] = M[j, i] = self._fn(seqs[i], seqs[j])
        return CorrelationResult(
            kind=self.kind, matrix=M, labels=_names(aligned),
            meta={"metric": self.metric, "truncated_to": T},
        )


@register("correlation", "transition")
class TransitionCorrelation:
    kind = "transition"

    def __init__(self, tolerance: int = 50):
        self.tolerance = tolerance

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        cps = [np.array(seq.change_points()) for seq in aligned.sequences]
        n = len(cps)
        M = np.eye(n)
        pairs = []
        for i in range(n):
            for j in range(i + 1, n):
                score = self._cooccur(cps[i], cps[j])
                M[i, j] = M[j, i] = score
                pairs.append({"a": i, "b": j, "transition_cooccurrence": round(float(score), 4)})
        return CorrelationResult(
            kind=self.kind, matrix=M, labels=_names(aligned), pairs=pairs,
            meta={"tolerance": self.tolerance},
        )

    def _cooccur(self, a: np.ndarray, b: np.ndarray) -> float:
        """Symmetric F1 of the transition match rates within ±tol, in both directions."""
        if len(a) == 0 or len(b) == 0:
            return 0.0
        a_hit = sum(np.any(np.abs(b - t) <= self.tolerance) for t in a) / len(a)
        b_hit = sum(np.any(np.abs(a - t) <= self.tolerance) for t in b) / len(b)
        return 0.0 if (a_hit + b_hit) == 0 else 2 * a_hit * b_hit / (a_hit + b_hit)


@register("correlation", "partial")
class PartialCorrelation:
    """Score each state pair by lift = P(a,b) / (P(a)P(b))."""

    kind = "partial"

    def __init__(self, min_lift: float = 1.2, min_support: float = 0.02):
        self.min_lift = min_lift
        self.min_support = min_support

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        T = _min_len(aligned)
        names = _names(aligned)
        seqs = [seq.labels[:T] for seq in aligned.sequences]
        n = len(seqs)
        pairs = []
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                a, b = seqs[i], seqs[j]
                for sa in np.unique(a):
                    pa = np.mean(a == sa)
                    for sb in np.unique(b):
                        pb = np.mean(b == sb)
                        joint = np.mean((a == sa) & (b == sb))
                        if joint < self.min_support or pa == 0 or pb == 0:
                            continue
                        lift = joint / (pa * pb)
                        if lift >= self.min_lift:
                            pairs.append({
                                "from": f"{names[i]}:S{int(sa)}",
                                "to": f"{names[j]}:S{int(sb)}",
                                "support": round(float(joint), 4),
                                "lift": round(float(lift), 3),
                            })
        pairs.sort(key=lambda d: d["lift"], reverse=True)
        return CorrelationResult(
            kind=self.kind, labels=names, pairs=pairs,
            meta={"min_lift": self.min_lift, "min_support": self.min_support, "truncated_to": T},
        )


@register("correlation", "time_lagged")
class TimeLaggedCorrelation:
    """Lagged correlation (StaCo eq. 5): shift j and take the lag maximising NMI.

    A naive argmax over NMI reports spurious lags: larger shifts mean shorter overlaps, and
    NMI does not penalise the smaller sample, so it inflates. Any pair, even unrelated ones,
    then yields some "best" shift. Three gates keep this honest:

    1. ``min_gain``: the shifted NMI must beat the lag-0 baseline by this margin
       (``best - s0 >= min_gain``) to count as lagged; otherwise the pair is contemporaneous.
    2. ``min_nmi``: overall correlation must clear a noise floor before a pair is emitted.
       NMI is positively biased on blocky sequences (two independent series reach ~0.05-0.1
       per window, and taking the max over ~30 shifts lifts that to ~0.17), so the default
       sits above that empirical ceiling; real lags usually score >=0.5.
    3. ``min_overlap``: the overlap must be >= ``min_overlap * T``, keeping windows long
       enough that short-window NMI inflation cannot dominate.

    ``matrix`` stores the decided value: the best NMI when lagged, otherwise ``s0``.
    """

    kind = "time_lagged"

    def __init__(
        self,
        max_lag: int = 300,
        step: int = 10,
        min_nmi: float = 0.25,
        min_gain: float = 0.05,
        min_overlap: float = 0.85,
    ):
        self.max_lag = max_lag
        self.step = step
        self.min_nmi = min_nmi
        self.min_gain = min_gain
        self.min_overlap = min_overlap

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        T = _min_len(aligned)
        names = _names(aligned)
        seqs = [seq.labels[:T] for seq in aligned.sequences]
        n = len(seqs)
        M = np.eye(n)
        Lag = np.zeros((n, n))
        pairs = []
        min_len = int(self.min_overlap * T)  # minimum overlap window
        lags = range(-self.max_lag, self.max_lag + 1, self.step)
        for i in range(n):
            for j in range(i + 1, n):
                s0 = float(normalized_mutual_info_score(seqs[i], seqs[j]))  # lag-0 baseline
                best_score, best_lag = s0, 0
                for d in lags:
                    if d == 0:
                        continue
                    if d > 0:
                        a, b = seqs[i][: T - d], seqs[j][d:]
                    else:
                        a, b = seqs[i][-d:], seqs[j][: T + d]
                    if len(a) < min_len:
                        continue
                    sc = float(normalized_mutual_info_score(a, b))
                    if sc > best_score:
                        best_score, best_lag = sc, d
                # Gates 1+2: a shift must clearly beat lag 0 and be correlated overall.
                is_lag = (
                    best_lag != 0
                    and best_score - s0 >= self.min_gain
                    and best_score >= self.min_nmi
                )
                score = best_score if is_lag else s0
                lag = best_lag if is_lag else 0
                M[i, j] = M[j, i] = score
                Lag[i, j], Lag[j, i] = lag, -lag
                # Gate 3: only emit pairs that are correlated enough.
                if score >= self.min_nmi:
                    leader, follower = (i, j) if lag >= 0 else (j, i)
                    pairs.append({
                        "leader": names[leader], "follower": names[follower],
                        "lag": int(abs(lag)), "nmi": round(float(score), 4),
                    })
        return CorrelationResult(
            kind=self.kind, matrix=M, labels=names, pairs=pairs,
            meta={"max_lag": self.max_lag, "step": self.step, "min_nmi": self.min_nmi,
                  "min_gain": self.min_gain, "min_overlap": self.min_overlap,
                  "lag_matrix": Lag.tolist()},
        )


# Allen's 13 interval relations (X relative to Y); inverses are kept where direction matters.
def _allen_relation(xs: int, xe: int, ys: int, ye: int) -> str:
    if xe < ys:
        return "before"
    if xe == ys:
        return "meets"
    if xs > ye:
        return "after"
    if xs == ye:
        return "met_by"
    if xs < ys and xe < ye and xe > ys:
        return "overlaps"
    if xs > ys and xe > ye and xs < ye:
        return "overlapped_by"
    if xs == ys and xe == ye:
        return "equals"
    if xs == ys:
        return "starts" if xe < ye else "started_by"
    if xe == ye:
        return "finishes" if xs > ys else "finished_by"
    if xs > ys and xe < ye:
        return "during"
    if xs < ys and xe > ye:
        return "contains"
    return "overlaps"


def _jaccard(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """StaCo eq. 4 overlap of two binary sequences: p(1,1)/(1-p(0,0)), i.e. Jaccard.

    Returns ``(score, support)``: overlap strength and the co-occurrence share p(1,1).
    """
    both = int(np.sum(x & y))
    union = int(np.sum(x | y))
    if union == 0:
        return 0.0, 0.0
    return both / union, both / len(x)


@register("correlation", "state_link")
class StateLinkCorrelation:
    """Lagged partial state correlation: ``Corr_Partial`` from StaCo eq. 4+5.

    For each ordered series pair ``(i, j)`` and state pair ``(Sa in i, Sb in j)``, reduce both
    to binary single-state sequences ``X = [labels_i == Sa]``, ``Y = [labels_j == Sb]`` and
    score them with the eq. 4 Jaccard overlap:

        score(X, Y) = p(X=1, Y=1) / (1 - p(X=0, Y=0))            # eq. 4, Jaccard

    Contemporaneous vs lagged: compute the lag-0 overlap ``s0``, then shift Y by
    ``k in [step, max_lag]`` and search for the best ``s_lag, k*`` (the ``argmax_k`` of eq. 5,
    run in both directions; the larger one decides who leads).

    * If ``s_lag - s0 >= min_gain`` the shift genuinely improves overlap, so the pair is
      ``lead-lag``: the leader enters its state ``k*`` steps earlier. This is real cascade.
    * Otherwise the states already overlap at lag 0, so the pair is ``synchronous`` with
      strength ``s0``.

    Without the gain test, a background state that fills most of the timeline overlaps well
    at any k and would be reported as a large spurious lag. ``pairs`` can be drawn directly
    as directed service-state influence edges. The computation is deterministic.
    """

    kind = "state_link"

    def __init__(
        self,
        max_lag: int = 200,
        step: int = 10,
        min_score: float = 0.2,
        min_support: float = 0.02,
        min_gain: float = 0.04,
    ):
        self.max_lag = max_lag
        self.step = step
        self.min_score = min_score
        self.min_support = min_support
        self.min_gain = min_gain  # a shift must beat lag 0 by this much to count as lagged

    def _best_lagged(self, x: np.ndarray, y: np.ndarray, T: int) -> tuple[float, int, float]:
        """Shift Y by k in [step, max_lag] (X[t] vs Y[t+k]); return (best score, k*, support)."""
        best_score, best_k, best_sup = -1.0, 0, 0.0
        for k in range(self.step, self.max_lag + 1, self.step):
            if T - k < T // 2:  # less than half overlap: unreliable
                break
            a, b = x[: T - k], y[k:]
            score, sup = _jaccard(a, b)
            if score > best_score:
                best_score, best_k, best_sup = score, k, sup
        return best_score, best_k, best_sup

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        T = _min_len(aligned)
        names = _names(aligned)
        seqs = [seq.labels[:T] for seq in aligned.sequences]
        bin_cache = [{s: (seq == s) for s in np.unique(seq)} for seq in seqs]
        n = len(seqs)
        pairs = []
        for i in range(n):
            for j in range(i + 1, n):
                for sa, xa in bin_cache[i].items():
                    for sb, yb in bin_cache[j].items():
                        s0, sup0 = _jaccard(xa, yb)                      # contemporaneous
                        s_ij, k_ij, sup_ij = self._best_lagged(xa, yb, T)  # i leads j
                        s_ji, k_ji, sup_ji = self._best_lagged(yb, xa, T)  # j leads i
                        if s_ij >= s_ji:
                            s_lag, k_lag, sup_lag, lead, ls, fl, fs = s_ij, k_ij, sup_ij, i, sa, j, sb
                        else:
                            s_lag, k_lag, sup_lag, lead, ls, fl, fs = s_ji, k_ji, sup_ji, j, sb, i, sa
                        # A clear gain means lagged influence; otherwise contemporaneous.
                        if (s_lag - s0 >= self.min_gain
                                and s_lag >= self.min_score and sup_lag >= self.min_support):
                            score, lag, sup, ftype = s_lag, k_lag, sup_lag, "lead-lag"
                            from_s, from_t, to_s, to_t = names[lead], int(ls), names[fl], int(fs)
                        elif s0 >= self.min_score and sup0 >= self.min_support:
                            score, lag, sup, ftype = s0, 0, sup0, "synchronous"
                            from_s, from_t, to_s, to_t = names[i], int(sa), names[j], int(sb)
                        else:
                            continue
                        pairs.append({
                            "from": f"{from_s}:S{from_t}", "to": f"{to_s}:S{to_t}",
                            "from_series": from_s, "from_state": from_t,
                            "to_series": to_s, "to_state": to_t,
                            "lag": int(lag),
                            "score": round(float(score), 4),
                            "support": round(float(sup), 4),
                            "type": ftype,
                        })
        pairs.sort(key=lambda d: d["score"], reverse=True)
        return CorrelationResult(
            kind=self.kind, labels=names, pairs=pairs,
            meta={"max_lag": self.max_lag, "step": self.step,
                  "min_score": self.min_score, "min_support": self.min_support,
                  "min_gain": self.min_gain, "truncated_to": T},
        )


@register("correlation", "structural")
class StructuralCorrelation:
    """Dominant Allen interval relation between same-state intervals across series.

    For each ordered pair (i, j) and shared global state g, classify how i's g-intervals
    relate to j's and report the dominant relation. ``before``/``overlaps`` means i tends to
    enter state g first — a structural cascade signal.
    """

    kind = "structural"

    def __init__(self, min_count: int = 2):
        self.min_count = min_count

    def analyze(self, aligned: AlignedStates) -> CorrelationResult:
        names = _names(aligned)
        seqs = aligned.sequences
        n = len(seqs)
        # Per series: state -> list of (start, end) intervals
        intervals: list[dict[int, list[tuple[int, int]]]] = []
        for seq in seqs:
            d: dict[int, list[tuple[int, int]]] = {}
            for seg in seq.segments():
                d.setdefault(seg.state, []).append((seg.start, seg.end))
            intervals.append(d)

        pairs = []
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                for g in sorted(set(intervals[i]) & set(intervals[j])):
                    counts: dict[str, int] = {}
                    for xs, xe in intervals[i][g]:
                        # Find the same-state interval in j with the closest start
                        ys, ye = min(intervals[j][g], key=lambda iv: abs(iv[0] - xs))
                        rel = _allen_relation(xs, xe, ys, ye)
                        counts[rel] = counts.get(rel, 0) + 1
                    if not counts:
                        continue
                    rel, cnt = max(counts.items(), key=lambda kv: kv[1])
                    if cnt >= self.min_count:
                        pairs.append({
                            "from": names[i], "to": names[j], "state": int(g),
                            "relation": rel, "count": cnt,
                        })
        return CorrelationResult(kind=self.kind, labels=names, pairs=pairs, meta={})
