"""WADI preprocessing: raw zip (data_origin/WaDi.zip) -> clean data (data/processed).

WADI (Water Distribution, SUTD iTrust) is a real water-distribution testbed. Three phases -
P1 primary grid, P2 secondary grid, P3 return grid - each run by their own PLC, with water
flowing one way P1 -> P2 -> P3. About 120 SCADA sensors/actuators at 1 Hz over 16 days of
continuous operation, including 15 attacks on pumps, valves and setpoints.

Mapping onto cluster-level causality: each phase is treated as one object, its selected
sensors are that object's channels, and cross-phase causal edges correspond to physical
water propagation. This is the water-utility counterpart of LEMMA-RCA, with a cleaner
directional prior.

Pipeline:
  1. read the labelled A2_19 Nov 2019 attack data from the zip (it ships an attack column);
  2. keep only continuous process values ``_PV``/``_CO`` (ParCorr-friendly; binary
     ``_STATUS``/``_AL`` columns are dropped);
  3. drop all-NaN and zero-variance columns;
  4. per phase, select ``k_per_phase`` channels by transport-variable weighting (flow FIT/FIC
     and level LT) times normalised dynamics;
  5. block-average down to ``length`` steps and z-score per channel.
Produces three equal-length series (one per phase); attack labels ship in ``extra``.

The loader only reads the artefact. Run directly to build explicitly:
    uv run python -m data.preprocess.wadi

Licence: SUTD iTrust; a signed agreement is required and the data may not be redistributed.
Neither the zip nor the artefacts are committed. Place the archive at ``data_origin/WaDi.zip``
(see ``data_origin/wadi/README.md``).
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from statescope.core.types import MTS

from ..schema import DatasetInfo, StandardDataset
from ._bundle import load_bundle, save_bundle

_DATA = Path(__file__).resolve().parent.parent
_ORIGIN_ZIP = _DATA.parent / "data_origin" / "WaDi.zip"
_PROCESSED = _DATA / "processed" / "wadi"

# Member inside the zip: the labelled A2_19 Nov 2019 attack data.
_MEMBER = "WaDi/WADI.A2_19 Nov 2019/WADI_attackdataLABLE.csv"

# Each phase is one object.
_PHASE_NAME = {"1": "P1 primary grid", "2": "P2 secondary grid", "3": "P3 return grid"}
# Physical flow topology, used as a directional reference for the causality stage.
_FLOW_TOPOLOGY = [["P1 primary grid", "P2 secondary grid"],
                  ["P2 secondary grid", "P3 return grid"]]

# Continuous process-value suffixes; binary _STATUS/_AL/_AH are dropped.
_CONT_SUFFIX = ("_PV", "_CO")
# Transport variables (flow, level) carry the cross-phase coupling, so they are up-weighted.
_TYPE_W = {
    "FIT": 1.0, "LT": 1.0, "LIT": 1.0, "FIC": 0.95, "DPIT": 0.85, "PIT": 0.85,
    "AIT": 0.7, "PIC": 0.7, "MCV": 0.6,
}

WADI_INFO = DatasetInfo(
    id="wadi",
    label="WADI (real water-distribution testbed)",
    group="public",
    source="SUTD iTrust - WADI.A2_19 Nov 2019 - Ahmed et al., CySWATER 2017 - agreement "
    "required, not redistributable",
    background="A real water-distribution SCADA testbed: three phases (P1 primary grid -> P2 "
    "secondary grid -> P3 return grid), each driven by its own PLC with water flowing one way. "
    "Each phase is treated as one object whose channels are selected continuous sensors, so "
    "causality between phases corresponds to physical water propagation. 16 days of continuous "
    "operation containing 15 attacks (~6% of samples). Ground truth is a binary attack/normal "
    "flag rather than per-timestep states, provided via extra.",
    available=True,
    tunable=False,
    note="Place the raw archive at data_origin/WaDi.zip (iTrust agreement, not committed); it "
    "is preprocessed and cached to data/processed/ on first use.",
)


def processed_path(length: int, k_per_phase: int) -> Path:
    # length and k are in the filename, so changing them invalidates old caches.
    return _PROCESSED / f"A2_attack_l{length}_k{k_per_phase}.npz"


def build(length: int = 9000, k_per_phase: int = 5) -> StandardDataset:
    """Raw zip -> a clean ``StandardDataset``, written to data/processed and returned."""
    if not _ORIGIN_ZIP.exists():
        raise FileNotFoundError(
            f"WADI raw data missing: {_ORIGIN_ZIP}\n"
            f"Put the SUTD iTrust WADI archive at data_origin/WaDi.zip "
            f"(see data_origin/wadi/README.md)."
        )
    series, extra = _build_from_zip(length, k_per_phase)
    ds = StandardDataset(info=WADI_INFO, series=series, ground_truth=None, state_names=None, extra=extra)
    save_bundle(processed_path(length, k_per_phase), ds)
    return ds


def load_or_build(length: int = 9000, k_per_phase: int = 5) -> StandardDataset:
    """Loader entry point: read the artefact, or build it now."""
    path = processed_path(length, k_per_phase)
    if path.exists():
        ds = load_bundle(path, WADI_INFO)
        return _restore_phase_names(ds)
    return build(length, k_per_phase)


# ---------------------------------------------------------------------------
# Raw zip -> series
# ---------------------------------------------------------------------------

def _parse(col: str) -> tuple[str, str] | None:
    """``1_FIT_001_PV`` -> (phase "1", type "FIT"); non-sensor columns return None."""
    m = re.match(r"^(\d)_([A-Z]+)_", col)
    return (m.group(1), m.group(2)) if m else None


def _short(col: str) -> str:
    """``1_FIT_001_PV`` -> ``FIT_001``: the channel display name."""
    s = re.sub(r"^\d_", "", col)
    return re.sub(r"_(PV|CO)$", "", s)


def _downsample(arr: np.ndarray, length: int, fn) -> np.ndarray:
    """[T, N] -> [length, N] by block averaging. Returns unchanged when T <= length."""
    T = arr.shape[0]
    if T <= length:
        return arr
    edges = np.linspace(0, T, length + 1).astype(int)
    return np.stack([fn(arr[a:b], axis=0) for a, b in zip(edges[:-1], edges[1:])])


def _build_from_zip(length: int, k_per_phase: int):
    with zipfile.ZipFile(_ORIGIN_ZIP) as zf:
        member = _MEMBER if _MEMBER in zf.namelist() else next(
            (n for n in zf.namelist() if n.endswith("WADI_attackdataLABLE.csv")), None)
        if member is None:
            raise RuntimeError(f"{_ORIGIN_ZIP} does not contain WADI_attackdataLABLE.csv.")
        with zf.open(member) as f:
            # Row 1 is an integer column index, so skip it and use the real header row.
            df = pd.read_csv(f, skiprows=1, low_memory=False)
    df.columns = [c.strip() for c in df.columns]

    label_col = next((c for c in df.columns if "LABLE" in c.upper() or "LABEL" in c.upper()), None)
    label = (df[label_col].to_numpy() == -1).astype(int) if label_col else np.zeros(len(df), dtype=int)

    # Keep continuous process values, drop zero-variance/all-NaN columns, group by phase.
    cont = [c for c in df.columns if _parse(c) and c.endswith(_CONT_SUFFIX)]
    X = df[cont].apply(pd.to_numeric, errors="coerce")
    sd = X.std(skipna=True)
    keep = [c for c in cont if not (np.isnan(sd[c]) or sd[c] == 0)]
    X = X[keep].ffill().bfill().fillna(0.0)

    Xds = _downsample(X.to_numpy(dtype=float), length, np.mean)
    lab_ds = _downsample(label.reshape(-1, 1), length, np.max).ravel().astype(int)

    phases: dict[str, list[int]] = {}
    for i, c in enumerate(keep):
        phases.setdefault(_parse(c)[0], []).append(i)  # type: ignore[index]

    series: list[MTS] = []
    phase_channels: list[list[str]] = []
    for p in sorted(phases):
        idx = phases[p]
        sub = Xds[:, idx]
        # Normalised dynamics (std after min-max, so z-scoring does not flatten it to 1)
        # times the transport-variable weight.
        mn, mx = sub.min(0), sub.max(0)
        norm = (sub - mn) / np.where(mx - mn > 1e-9, mx - mn, 1.0)
        w = np.array([_TYPE_W.get(_parse(keep[j])[1], 0.5) for j in idx])  # type: ignore[index]
        score = norm.std(0) * w
        order = np.argsort(score)[::-1][: min(k_per_phase, len(idx))]
        chosen = [idx[o] for o in order]
        names = [_short(keep[c]) for c in chosen]
        mat = Xds[:, chosen].astype(float)
        mat = (mat - mat.mean(0)) / np.where(mat.std(0) > 1e-9, mat.std(0), 1.0)
        series.append(MTS(mat, channel_names=names, name=_PHASE_NAME[p]))
        phase_channels.append(names)

    extra = {
        "phase_channels": phase_channels,        # per-phase channel names (see _restore below)
        "attack_label": lab_ds.tolist(),         # per-step attack label (1 = attack)
        "flow_topology": _FLOW_TOPOLOGY,         # physical flow direction, P1 -> P2 -> P3
        "attack_fraction": round(float(lab_ds.mean()), 4),
    }
    return series, extra


def _restore_phase_names(ds: StandardDataset) -> StandardDataset:
    """_bundle stores only series[0] channel names; restore per-phase names from extra."""
    pc = ds.extra.get("phase_channels")
    if pc and len(pc) == len(ds.series):
        ds.series = [MTS(s.data, channel_names=list(pc[i]), name=s.name) for i, s in enumerate(ds.series)]
    return ds


if __name__ == "__main__":
    ds = build()
    print(f"built WADI A2 → {processed_path(9000, 5)}")
    print(ds.stats())
    for s in ds.series:
        print(f"  {s.name}: T={s.T} C={s.C} channels={s.channel_names}")
    print("  attack_fraction:", ds.extra["attack_fraction"], "| flow:", ds.extra["flow_topology"])
