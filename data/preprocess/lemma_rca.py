"""LEMMA-RCA preprocessing: raw zip (data_origin) -> clean data (data/processed).

Extracts the pod-level metric zip, drops idle pods, picks one representative per service
(application services first), keeps the six core channels, downsamples and standardises per
channel, then writes a compact npz. The loader only reads that artefact.

Run directly to build explicitly (otherwise the loader calls ``build`` on first use):
    uv run python -m data.preprocess.lemma_rca [domain] [date]

Licence: CC-BY-ND-4.0. Neither the raw data nor the artefacts are committed. See
``data_origin/lemma_rca/README.md`` for the archive layout.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np

from statescope.core.types import MTS

from ..schema import DatasetInfo, StandardDataset
from ._bundle import load_bundle, save_bundle

_DATA = Path(__file__).resolve().parent.parent
_ORIGIN = _DATA.parent / "data_origin" / "lemma_rca"
_PROCESSED = _DATA / "processed" / "lemma_rca"

# The six core pod-level metrics shared by 8 of the 10 fault dates; cpu_usage comes first so
# it can drive the activity ranking.
_CORE_METRICS = [
    "cpu_usage", "memory_usage",
    "rate_received_packets", "rate_transmitted_packets",
    "received_bandwidth", "transmit_bandwidth",
]
_CH_LABELS = {
    "cpu_usage": "CPU", "memory_usage": "memory",
    "received_bandwidth": "rx bandwidth", "transmit_bandwidth": "tx bandwidth",
    "rate_received_packets": "rx packet rate", "rate_transmitted_packets": "tx packet rate",
}
_DOMAIN_DEFAULT_DATE = {"product_review": "20210517", "cloud_computing": "20231207"}

LEMMA_RCA_INFO = DatasetInfo(
    id="lemma_rca",
    label="LEMMA-RCA (real multi-domain RCA)",
    group="public",
    source="Zheng et al., NeurIPS 2024 D&B · lemma-rca.github.io · HF: Lemma-RCA-NEC · CC-BY-ND-4.0",
    background="A real multi-domain root-cause-analysis benchmark (NEC microservices / cloud "
    "computing): six operating metrics per pod (CPU, memory, packet rates, bandwidth), "
    "block-averaged down to ~6000 steps, with the pod-to-node placement topology. Ground truth is "
    "fault root-cause labels, not per-timestep states.",
    available=True,
    tunable=False,
    note="Place the raw data in data_origin/lemma_rca/ (CC-BY-ND, not committed); it is "
    "preprocessed and cached to data/processed/ on first use.",
)


def zip_path(domain: str, date: str) -> Path:
    return _ORIGIN / domain / "Metrics Data" / f"{date}.zip"


def processed_path(domain: str, date: str, n_pods: int, length: int) -> Path:
    # The channel count is in the filename, so changing _CORE_METRICS invalidates old caches.
    return _PROCESSED / f"{domain}_{date}_p{n_pods}_l{length}_c{len(_CORE_METRICS)}.npz"


def build(domain: str = "product_review", date: str | None = None,
          n_pods: int = 8, length: int = 6000) -> StandardDataset:
    """Raw zip -> a clean ``StandardDataset``, written to data/processed and returned."""
    if domain not in _DOMAIN_DEFAULT_DATE:
        raise ValueError(f"unknown domain '{domain}'. available: {list(_DOMAIN_DEFAULT_DATE)}")
    date = date or _DOMAIN_DEFAULT_DATE[domain]
    zpath = zip_path(domain, date)
    if not zpath.exists():
        raise FileNotFoundError(
            f"LEMMA-RCA raw data missing: {zpath}\n"
            f"Put the Metrics Data from HF Lemma-RCA-NEC into data_origin/lemma_rca/{domain}/ "
            f"(see data_origin/lemma_rca/README.md)."
        )
    series, extra = _build_from_zip(n_pods, length, zpath)
    ds = StandardDataset(info=LEMMA_RCA_INFO, series=series, ground_truth=None, state_names=None, extra=extra)
    save_bundle(processed_path(domain, date, n_pods, length), ds)
    return ds


def load_or_build(domain: str, date: str | None, n_pods: int, length: int) -> StandardDataset:
    """Loader entry point: read the artefact, or build it now."""
    date = date or _DOMAIN_DEFAULT_DATE[domain]
    path = processed_path(domain, date, n_pods, length)
    if path.exists():
        return load_bundle(path, LEMMA_RCA_INFO)
    return build(domain, date, n_pods, length)


# ---------------------------------------------------------------------------
# Raw zip -> series
# ---------------------------------------------------------------------------

def _build_from_zip(n_pods: int, length: int, zpath: Path):
    zf = zipfile.ZipFile(zpath)
    names = zf.namelist()

    def find(metric: str) -> str | None:
        suffix = f"pod_level_data_{metric}.npy"
        return next((n for n in names if n.endswith(suffix)), None)

    metrics = [m for m in _CORE_METRICS if find(m)]
    if not metrics:
        raise RuntimeError(f"{zpath.name} lacks the core pod-level metrics {_CORE_METRICS}.")

    base_pods: list[str] | None = None
    chan_arrays: list[np.ndarray] = []
    sub_key: str | None = None
    for m in metrics:
        obj = _load_npy(zf, find(m))  # type: ignore[arg-type]
        if sub_key is None:
            sub_key = max(obj.keys(), key=lambda k: np.asarray(obj[k]["Sequence"]).shape[0])
        inner = obj.get(sub_key) or obj[next(iter(obj))]
        seq = np.asarray(inner["Sequence"], dtype=float)
        pods = [str(p) for p in inner["Pod_Name"]]
        n = min(seq.shape[1], len(pods))  # Sequence occasionally has one column more
        seq, pods = seq[:, :n], pods[:n]
        if base_pods is None:
            base_pods = pods
        chan_arrays.append(_downsample(seq, length))

    assert base_pods is not None and sub_key is not None
    n_cols = min(a.shape[1] for a in chan_arrays)
    chan_arrays = [a[:, :n_cols] for a in chan_arrays]
    base_pods = base_pods[:n_cols]

    keep = _select_pods(chan_arrays, base_pods, n_pods)

    ch_names = [_CH_LABELS.get(m, m) for m in metrics]
    series: list[MTS] = []
    seen: set[str] = set()
    for j in keep:
        mat = _standardize(np.column_stack([a[:, j] for a in chan_arrays]))
        nm = _short_pod(base_pods[j])
        while nm in seen:
            nm += "·"
        seen.add(nm)
        series.append(MTS(mat, channel_names=list(ch_names), name=nm))

    extra = _build_extra(zf, names, {base_pods[j] for j in keep})
    return series, extra


# Short-name tokens of k8s infrastructure services. Application pods are preferred; these
# are only used to fill remaining slots.
_INFRA_HINTS = {
    "node", "node-ca", "tuned", "ovs", "sdn", "multus", "etcd", "kube", "dns", "router",
    "machine", "istio", "ingress", "operator", "controller", "daemon", "prometheus",
    "exporter", "apiserver", "scheduler", "proxy", "coredns", "metrics", "cluster",
    "monitoring", "alertmanager", "grafana", "marketplace", "olm", "registry", "image",
    "network", "calico", "csi", "cni", "snapshot", "ca", "telemetry", "collector",
    "fluentd", "fluent", "console", "oauth", "insights", "catalog-operator",
    "packageserver", "authentication", "openshift", "apiserver", "server", "webhook",
    "redhat", "samples", "migrator", "approver", "signer", "version", "downloads",
}


def _is_infra(svc_name: str) -> bool:
    toks = svc_name.lower().split("-")
    return any(svc_name.lower() == h or svc_name.lower().startswith(h + "-") or h in toks
               for h in _INFRA_HINTS)


# Excluding catalog and community/certified (openshift operator catalogues) makes
# product_review converge on the six application/backend services.
def _excluded(name: str) -> bool:
    return name.lower() in ("catalog", "community", "certified")


def _select_pods(chan_arrays: list[np.ndarray], base_pods: list[str], n_pods: int,
                 min_dyn: float = 0.3, n_replica: int = 0) -> list[int]:
    """Pick n_pods pods: drop idle flat lines, prefer one representative per application
    service (infrastructure only fills gaps), then add extra replicas of one service so
    same-service pod interactions are visible.

    Activity score = sum of per-channel temporal std after global standardisation; idle pods
    score about zero.
    """
    n_cols = chan_arrays[0].shape[1]
    dyn = np.zeros(n_cols)
    for a in chan_arrays:
        col = np.nan_to_num(a, nan=0.0)
        sd = col.std()
        z = (col - col.mean()) / sd if sd > 1e-9 else col * 0.0
        dyn += np.nanstd(z, axis=0)

    svc = [_short_pod(p) for p in base_pods]
    cand = sorted((j for j in range(n_cols) if dyn[j] > min_dyn), key=lambda j: dyn[j], reverse=True)
    if not cand:  # all flat: fall back to top-N by activity
        cand = sorted(range(n_cols), key=lambda j: dyn[j], reverse=True)
    cand = [j for j in cand if not _excluded(svc[j])]  # drop non-application pods

    by_svc: dict[str, list[int]] = {}
    app_reps: list[int] = []   # application service representatives, by activity
    infra_reps: list[int] = []  # infrastructure representatives, by activity
    for j in cand:
        first = svc[j] not in by_svc
        by_svc.setdefault(svc[j], []).append(j)
        if first:
            (infra_reps if _is_infra(svc[j]) else app_reps).append(j)

    reserve = n_replica if n_pods >= 6 else 0          # no replica slots for small n_pods
    keep = app_reps[: max(1, n_pods - reserve)]        # application services first
    if reserve:                                         # replica group, application first
        multi_app = [s for s in by_svc if len(by_svc[s]) >= 2 and not _is_infra(s)]
        multi_inf = [s for s in by_svc if len(by_svc[s]) >= 2 and _is_infra(s)]
        pool = multi_app or multi_inf
        if pool:
            top = max(pool, key=lambda s: dyn[by_svc[s][0]])
            if by_svc[top][0] not in keep and len(keep) < n_pods:
                keep.append(by_svc[top][0])             # that service's representative
            keep += [j for j in by_svc[top][1:] if j not in keep][:reserve]
    for j in app_reps + infra_reps:                     # fill up: more apps, then infra
        if len(keep) >= n_pods:
            break
        if j not in keep:
            keep.append(j)
    return keep[:n_pods]


def _load_npy(zf: zipfile.ZipFile, name: str) -> dict:
    with zf.open(name) as f:
        return np.load(io.BytesIO(f.read()), allow_pickle=True).item()


def _downsample(seq: np.ndarray, length: int) -> np.ndarray:
    """[T, N] -> [length, N] by block averaging (anti-aliasing, uses every sample).

    Splits T steps into ``length`` contiguous blocks and averages each; the remainder joins
    the last block. Returns unchanged when T <= length.
    """
    T = seq.shape[0]
    if T <= length:
        return seq
    edges = np.linspace(0, T, length + 1).astype(int)
    return np.stack([np.nanmean(seq[a:b], axis=0) for a, b in zip(edges[:-1], edges[1:])])


def _standardize(mat: np.ndarray) -> np.ndarray:
    """Per-channel z-score; missing values are forward-, then back-, then zero-filled."""
    out = mat.astype(float).copy()
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


def _short_pod(name: str) -> str:
    """Long pod name -> short service name, e.g. ``adservice-7df8c84f69-zgsdx`` -> ``adservice``."""
    parts = name.split("-")
    while len(parts) > 1 and parts[-1].isalnum() and (
        parts[-1].isdigit() or any(ch.isdigit() for ch in parts[-1]) or len(parts[-1]) >= 5
    ):
        parts.pop()
        if len(parts) <= 1:
            break
    return "-".join(parts)[:16] or name[:16]


def _build_extra(zf: zipfile.ZipFile, names: list[str], kept_pods: set[str]) -> dict:
    """Extract the pod-to-node placement for the selected pods; empty when p2n is absent."""
    p2n_name = next((n for n in names if n.endswith("p2n.npy")), None)
    placement: list[dict] = []
    if p2n_name:
        try:
            for pod, node in _load_npy(zf, p2n_name).items():
                if str(pod) in kept_pods:
                    placement.append({"pod": _short_pod(str(pod)), "node": str(node)})
        except Exception:
            pass
    return {"pod_node": placement}


if __name__ == "__main__":
    import sys

    dom = sys.argv[1] if len(sys.argv) > 1 else "product_review"
    dt = sys.argv[2] if len(sys.argv) > 2 else None
    ds = build(dom, dt)
    print(f"built {dom}/{dt or _DOMAIN_DEFAULT_DATE[dom]} → {processed_path(dom, dt or _DOMAIN_DEFAULT_DATE[dom], 6, 2000)}")
    print(ds.stats())
