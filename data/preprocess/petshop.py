"""PetShop preprocessing: raw metric CSVs (data_origin/petshop) -> data/processed.

Takes the ``noissue`` baseline of the ``temporal_traffic1`` scenario, selects top-N services
and five real channels (mean/p90/p99 latency, requests, availability) plus ``n_decoys``
injected noise channels, then fills and standardises per channel. The service dependency
graph and injected root causes go into ``extra``. Loaders only read the artefact.

Why inject noise and keep one near-constant real channel: to demonstrate stage-2 selection.
PetShop has no per-timestep ground truth, so only the unlabelled selector applies (scoring
by global divergence minus local similarity). The injected noise has no state structure and
availability is near-constant in the ``noissue`` baseline, so both score lowest, while the
latency/request channels score high. At K=4 the selector therefore keeps the four dynamic
metrics and drops availability and the noise channels.

Build explicitly (otherwise the loader calls ``build`` on first use):
    uv run python -m data.preprocess.petshop

Raw data lives in data_origin/petshop (CC-BY-4.0, vendored); see its README for the layout.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import numpy as np

from statescope.core.types import MTS

from ..schema import DatasetInfo, StandardDataset
from ._bundle import load_bundle, save_bundle

# Service selection modes:
#   "busy" - top-N services by request volume; may pull in high-traffic infrastructure or
#            isolated leaves.
#   "core" - hubs of the call topology: drop managed/external nodes, then take top-N by call
#            graph degree. Purely topological (no root-cause labels), and the selected
#            services stay connected, so discovered cross-service edges land on the real
#            call topology far more often than with "busy".
# Infrastructure/external exclusion terms. "lambda" is matched exactly, otherwise it would
# also catch the business service lambdastatusu (LambdaStatusUpdater).
_INFRA_EXACT = {"lambda"}
_INFRA_SUB = (
    "AWS::", "StepFunc", "SSM", "STS", "DynamoDB", "S3", "Evidently", "SimpleNotific",
    "SimpleSyst", "sqs", "execute-api", "servi-", "Servi-", "amazon", "www.", "PGSQL",
    "169.254", "invalid", "https",
)


def _is_infra(short_name: str) -> bool:
    return short_name in _INFRA_EXACT or any(k in short_name for k in _INFRA_SUB)


def _select_core(rows: list, graph_edges: list[dict], n_services: int) -> list:
    """Pick core business services: drop infrastructure, dedupe short names (keeping the
    busiest), then take top-N by call-graph degree with request volume breaking ties.

    ``rows`` is ``[(comp, arr, busy)]``; ``graph_edges`` is ``[{src, dst}]`` over short names.
    """
    deg: Counter = Counter()
    for e in graph_edges:
        if e["src"] == e["dst"]:
            continue  # skip self-loops; they would inflate the degree
        deg[e["src"]] += 1
        deg[e["dst"]] += 1
    # Keep only the busiest component per short name, so replicas do not take several slots.
    best: dict[str, tuple] = {}
    for r in rows:
        sc = _short(r[0])
        if _is_infra(sc):
            continue
        if sc not in best or r[2] > best[sc][2]:
            best[sc] = r
    ranked = sorted(best.values(), key=lambda r: (deg.get(_short(r[0]), 0), r[2]), reverse=True)
    return ranked[: max(2, n_services)]

_DATA = Path(__file__).resolve().parent.parent
_ORIGIN = _DATA.parent / "data_origin" / "petshop"
_PROCESSED = _DATA / "processed" / "petshop"

# Five real channels. Availability is near-constant in the noissue baseline, so it is
# naturally low-information.
_WANTED = [
    ("latency", "Average"), ("latency", "p90"), ("latency", "p99"),
    ("requests", "Sum"), ("availability", "Average"),
]
_CH_LABELS = ["latency", "latency p90", "latency p99", "requests", "availability"]
_REQ_IDX = _CH_LABELS.index("requests")        # request volume measures how busy a service is
_LOWINFO = ["availability"]                    # near-constant, so selectors drop it first
# Injected noise channels: no state structure, so the unlabelled selector scores them lowest
# and drops them at K=4. Generated deterministically (seeded per service index), each channel
# seeded independently so no spurious cross-series correlation is created.
_DECOY_LABELS = ["noise white", "noise jitter", "noise background", "noise hiss"]

PETSHOP_INFO = DatasetInfo(
    id="petshop",
    label="PetShop (real microservice RCA)",
    group="public",
    source="Hardt et al., CLeaR 2024 - amazon-science/petshop-root-cause-analysis - CC-BY-4.0",
    background="Operational metrics of a real pet-adoption microservice application on AWS "
    "(the temporal scenario, where load varies over time): five real metrics per service "
    "(mean/p90/p99 latency, requests, availability) plus injected noise channels, 1652 steps. "
    "Availability is near-constant in the noissue baseline and the injected noise carries no "
    "state structure, so the stage-2 unlabelled selector ranks by information content and at "
    "K=4 keeps the dynamic latency/request metrics. Ships the real service dependency graph "
    "and root-cause labels for the injected faults.",
    available=True,
    tunable=False,
    note="Includes 2 injected demo noise channels (n_decoys is tunable; their names start "
    "with 'noise'); everything else is really collected.",
)


def processed_path(scenario: str, n_services: int, n_decoys: int, select_by: str = "core") -> Path:
    # Encoding the counts and mode in the filename invalidates stale caches automatically.
    tag = "" if select_by == "busy" else f"_{select_by}"
    return _PROCESSED / f"{scenario}_s{n_services}_d{n_decoys}{tag}.npz"


def build(
    scenario: str = "temporal_traffic1", n_services: int = 6, n_decoys: int = 2,
    select_by: str = "core",
) -> StandardDataset:
    """Raw CSVs -> a clean ``StandardDataset``, written to data/processed and returned.

    ``select_by``: ``core`` (default) picks call-topology hubs; ``busy`` picks by requests.
    """
    import pandas as pd

    base = _ORIGIN / scenario
    if not (base / "noissue" / "metrics.csv").exists():
        raise FileNotFoundError(
            f"PetShop raw data missing: {base}\n"
            f"Expected data_origin/petshop/{scenario}/ (see the README in that directory)."
        )
    df = pd.read_csv(base / "noissue" / "metrics.csv", header=[0, 1, 2], index_col=0)
    comps = list(dict.fromkeys(df.columns.get_level_values(0)))
    graph_edges = _load_graph(base)  # [{src, dst}] over short names; "core" uses the degrees

    def slice_comp(comp: str) -> np.ndarray | None:
        cols = []
        for metric, stat in _WANTED:
            key = (comp, metric, stat)
            if key not in df.columns:
                return None
            cols.append(df[key].to_numpy(dtype=float))
        return np.column_stack(cols)

    rows = []
    for comp in comps:
        arr = slice_comp(comp)
        if arr is None:
            continue
        busy = np.nanmean(arr[:, _REQ_IDX])
        rows.append((comp, arr, busy if np.isfinite(busy) else -1.0))

    if select_by == "core":
        rows = _select_core(rows, graph_edges, n_services)
    else:  # "busy"
        rows.sort(key=lambda r: r[2], reverse=True)
        rows = rows[: max(2, n_services)]

    n_decoys = max(0, min(n_decoys, len(_DECOY_LABELS)))
    ch_names = list(_CH_LABELS) + _DECOY_LABELS[:n_decoys]
    series: list[MTS] = []
    seen: set[str] = set()
    for k, (comp, arr, _) in enumerate(rows):
        clean = _fill_and_standardize(arr)                       # [T, 5] real channels
        if n_decoys:
            clean = np.column_stack([clean, _make_decoys(len(clean), n_decoys, k)])
        nm = _short(comp)
        while nm in seen:
            nm += "·"
        seen.add(nm)
        series.append(MTS(clean, channel_names=list(ch_names), name=nm))

    extra = {
        "dependency_graph": graph_edges,
        "root_causes": _load_root_causes(base),
        "decoy_channels": _DECOY_LABELS[:n_decoys],   # names of the injected noise channels
        "lowinfo_channels": list(_LOWINFO),           # near-constant real channels
        "select_by": select_by,                        # core = topology hubs, busy = requests
    }
    ds = StandardDataset(info=PETSHOP_INFO, series=series, ground_truth=None, state_names=None, extra=extra)
    save_bundle(processed_path(scenario, n_services, n_decoys, select_by), ds)
    return ds


def load_or_build(
    scenario: str, n_services: int, n_decoys: int = 2, select_by: str = "core",
) -> StandardDataset:
    """Loader entry point: read the artefact, or build it now. ``select_by`` defaults to core."""
    path = processed_path(scenario, n_services, n_decoys, select_by)
    if path.exists():
        return load_bundle(path, PETSHOP_INFO)
    return build(scenario, n_services, n_decoys, select_by)


def _make_decoys(T: int, n: int, service_idx: int) -> np.ndarray:
    """Generate n z-scored noise channels with no state structure, deterministically seeded.

    All are stationary, light-tailed white noise, so global divergence matches local
    similarity and the unlabelled selector ranks them below every real channel. Heavy tails
    or random walks are avoided because they would raise the global divergence.
    """
    rs = np.random.RandomState(7000 + 13 * service_idx)
    cols = []
    for _ in range(n):
        x = rs.standard_normal(T)                            # light-tailed white noise
        sd = x.std()
        cols.append((x - x.mean()) / (sd if sd > 1e-9 else 1.0))
    return np.column_stack(cols)


# ---------------------------------------------------------------------------
# Processing helpers
# ---------------------------------------------------------------------------

def _short(name: str) -> str:
    """Long component name -> short display name."""
    s = name
    for sep in ("_AWS::", "_Database::", "_remote", "_client"):
        if sep in s:
            s = s.split(sep)[0]
            break
    s = s.split("@")[0]
    if "_" in s and "::" not in s:
        s = s.split("_")[0]
    return s[:13]


def _fill_and_standardize(arr: np.ndarray) -> np.ndarray:
    out = arr.copy()
    for c in range(out.shape[1]):
        col = out[:, c]
        last = np.nan
        for i in range(len(col)):
            if np.isnan(col[i]):
                col[i] = last
            else:
                last = col[i]
        nxt = np.nan
        for i in range(len(col) - 1, -1, -1):
            if np.isnan(col[i]):
                col[i] = nxt if not np.isnan(nxt) else 0.0
            else:
                nxt = col[i]
        mu, sd = np.nanmean(col), np.nanstd(col)
        out[:, c] = (col - mu) / sd if sd > 1e-9 else col - mu
    return out


def _load_graph(base: Path) -> list[dict]:
    import pandas as pd

    try:
        g = pd.read_csv(base / "graph.csv", index_col=0)
    except Exception:
        return []
    edges = []
    nodes = list(g.index)
    for i, src in enumerate(nodes):
        for j, dst in enumerate(g.columns):
            if i < len(g.values) and float(g.values[i][j]) != 0:
                edges.append({"src": _short(str(src)), "dst": _short(str(dst))})
    return edges[:200]


def _load_root_causes(base: Path) -> list[dict]:
    import json

    try:
        data = json.load(open(base / "issues.json"))
    except Exception:
        return []
    out = []
    for it in data.get("issues", []):
        tgt = (it.get("target") or {}).get("node")
        rc = (it.get("root_cause") or {}).get("node")
        if tgt and rc:
            out.append({"symptom": _short(tgt), "root_cause": _short(rc)})
    return out


if __name__ == "__main__":
    ds = build()
    print(f"built petshop → {processed_path('temporal_traffic1', 6, 2)}")
    print(ds.stats())
    print("  channels:", ds.series[0].channel_names)
    print("  decoys:", ds.extra.get("decoy_channels"), "| lowinfo:", ds.extra.get("lowinfo_channels"))
