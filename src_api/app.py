"""StateScope session-based API.

Run (dev):  uv run uvicorn src_api.app:app --reload --port 8000

The pipeline is split into per-stage endpoints rather than one batch call. Intermediate
results live in a server-side session: downstream stages reuse upstream output, and
rerunning an upstream stage invalidates everything below it.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import serialize as ser
from .session import (
    SessionState,
    SessionStore,
    reduced_series,
    run_align,
    run_calibrate,
    run_causality,
    run_correlate,
    run_detect,
    run_select,
)

STORE = SessionStore()
MAX_POINTS = 1000

app = FastAPI(title="StateScope Dynamic API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ----------------------------- Request models ---------------------------- #


class DataReq(BaseModel):
    dataset: str = "synthetic_abstract"  # dataset id from the catalog
    n_series: int = 3
    seg_len: int = 400
    n_useful: int = 3
    n_noise: int = 5
    lag: int = 150
    seed: int = 1
    scenario: str | None = None  # legacy parameter, kept for compatibility


class SelectReq(BaseModel):
    selector: str = "issd"  # issd | weak | unlabeled
    K: int = 3


class DetectReq(BaseModel):
    win_size: int = 100
    step: int = 50
    nb_steps: int = 60
    n_states: int = 6


class SegmentIn(BaseModel):
    start: int
    end: int  # exclusive
    state: int  # the local id shown in the calibration workbench


class SeriesEdit(BaseModel):
    name: str
    segments: list[SegmentIn]  # full segment list, contiguously covering [0, T)


class CalibrateReq(BaseModel):
    # Manual calibration: only the edited series need to be submitted.
    series: list[SeriesEdit]


class CorrelateReq(BaseModel):
    kinds: list[str] = ["overall", "transition", "partial", "time_lagged", "structural"]
    tolerance: int = 60
    max_lag: int = 400
    min_lift: float = 1.2


class CausalityReq(BaseModel):
    # Cluster-level regimes + causality: concatenate the cluster, run E2USD for regimes,
    # then masked PCMCI+ inside each regime.
    n_states: int = 4       # maximum number of cluster regimes
    tau_max: int = 2
    pc_alpha: float = 0.05
    max_edges_per_regime: int | None = None  # top-K pruning (None = keep all)


# ----------------------------- Helpers ----------------------------------- #


def _get(sid: str) -> SessionState:
    try:
        return STORE.get(sid)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"session '{sid}' not found")


def _meta(st: SessionState) -> dict:
    names = (st.truth[0].label_names or {}) if st.has_truth else {}
    true_states = (sorted(int(x) for x in set(st.truth[0].labels.tolist())) if st.has_truth else [])
    return {
        "session_id": st.id,
        "completed": st.completed(),
        "params": st.params,
        "n_channels": st.series[0].C,
        "T": st.series[0].T,
        "dataset": st.params.get("dataset"),
        "scenario": st.params.get("scenario"),
        "true_states": true_states,
        "true_state_names": {int(k): v for k, v in names.items()},
        "has_ground_truth": st.has_truth,
        "stats": st.stats,
        "info": st.info,
    }


# ----------------------------- Endpoints --------------------------------- #




@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/datasets")
def datasets() -> dict:
    """List every selectable dataset, including entries that need a download."""
    import data as datalayer

    items = [
        {"id": i.id, "label": i.label, "group": i.group, "source": i.source,
         "background": i.background, "available": i.available, "note": i.note, "tunable": i.tunable}
        for i in datalayer.list_datasets()
    ]
    return {"datasets": items}


@app.post("/api/sessions")
def create_session(req: DataReq) -> dict:
    st = STORE.create(req.model_dump())
    return {
        "meta": _meta(st),
        "series": ser.series_json(st.series, None, MAX_POINTS),
        "ground_truth": [{"name": t.name, "segments": ser.segments_json(t)} for t in st.truth],
    }


@app.get("/api/sessions/{sid}")
def get_session(sid: str) -> dict:
    st = _get(sid)
    out: dict = {"meta": _meta(st), "series": ser.series_json(st.series, st.selected, MAX_POINTS)}
    if st.selected is not None:
        out["selection"] = {"indices": st.selected, **st.selector_meta,
                            "names": [st.series[0].channel_names[i] for i in st.selected]}
    if st.detected is not None:
        out["detected"] = ser.detected_json(st.detected, st.truth if st.has_truth else None)
    if st.aligned is not None:
        out["aligned"] = ser.aligned_json(st.aligned)
        out["state_profiles"] = ser.state_profiles_json(reduced_series(st), st.aligned)
    if st.correlations:
        out["correlations"] = {k: ser.correlation_json(v) for k, v in st.correlations.items()}
    if st.causality is not None:
        out["causality"] = ser.cluster_json(st.causality, st.extra)
    return out


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str) -> dict:
    STORE.delete(sid)
    return {"deleted": sid}


@app.post("/api/sessions/{sid}/select")
def select(sid: str, req: SelectReq) -> dict:
    st = _get(sid)
    try:
        run_select(st, req.selector, req.K)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {
        "meta": _meta(st),
        "selection": {"indices": st.selected, **st.selector_meta,
                      "names": [st.series[0].channel_names[i] for i in st.selected]},
        "series": ser.series_json(st.series, st.selected, MAX_POINTS),
    }


@app.post("/api/sessions/{sid}/detect")
def detect(sid: str, req: DetectReq) -> dict:
    st = _get(sid)
    run_detect(st, req.win_size, req.step, req.nb_steps, req.n_states)
    return {"meta": _meta(st), "detected": ser.detected_json(st.detected, st.truth if st.has_truth else None)}


@app.post("/api/sessions/{sid}/detect/calibrate")
def calibrate(sid: str, req: CalibrateReq) -> dict:
    """Apply manual calibration, then invalidate alignment and everything downstream."""
    st = _get(sid)
    try:
        run_calibrate(st, [e.model_dump() for e in req.series])
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"meta": _meta(st), "detected": ser.detected_json(st.detected, st.truth if st.has_truth else None)}


@app.post("/api/sessions/{sid}/align")
def align(sid: str) -> dict:
    st = _get(sid)
    try:
        run_align(st)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {
        "meta": _meta(st),
        "aligned": ser.aligned_json(st.aligned),
        "state_profiles": ser.state_profiles_json(reduced_series(st), st.aligned),
    }


@app.post("/api/sessions/{sid}/correlate")
def correlate(sid: str, req: CorrelateReq) -> dict:
    st = _get(sid)
    try:
        run_correlate(st, req.kinds, req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"meta": _meta(st),
            "correlations": {k: ser.correlation_json(v) for k, v in st.correlations.items()}}


@app.post("/api/sessions/{sid}/causality")
def causality(sid: str, req: CausalityReq) -> dict:
    st = _get(sid)
    try:
        run_causality(st, req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"meta": _meta(st), "causality": ser.cluster_json(st.causality, st.extra)}


# Serve the built frontend (./dist) when present.
_dist = Path(__file__).resolve().parent.parent / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
