"""StateScope session-based API: one endpoint per stage; rerunning a stage invalidates downstream.

Run (dev):  uv run uvicorn src_api.app:app --reload --port 8000
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from typing import Optional

from pydantic import BaseModel

from . import serialize as ser
from .defaults import METRIC_DETECT_DEFAULTS
from .session import (
    SessionState,
    SessionStore,
    reduced_series,
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


class DataReq(BaseModel):
    dataset: str = "synthetic_abstract"  # dataset id from the catalog
    n_series: int = 3
    seg_len: int = 400
    n_useful: int = 3
    n_noise: int = 5
    lag: int = 150
    seed: int = 1


class SelectReq(BaseModel):
    selector: str = "unlabeled"  # unlabeled | issd | weak; K per entity
    K: int = 3
    picks: Optional[dict[str, list[str]]] = None  # explicit picks: entity -> metric names


class DetectReq(BaseModel):
    win_size: int = 100
    step: int = 30
    nb_steps: int = 20
    n_states: int = 0  # <= 1: chosen by the DP
    min_seg_len: int = 0


class SegmentIn(BaseModel):
    start: int
    end: int  # exclusive
    state: int


class SeriesEdit(BaseModel):
    name: str
    segments: list[SegmentIn]  # must contiguously cover [0, T)


class CalibrateReq(BaseModel):
    series: list[SeriesEdit]


class CorrelateReq(BaseModel):
    min_lift: float = 1.2
    min_jaccard: float = 0.3


class CausalityReq(BaseModel):
    min_occ: int = 3            # drop state events with fewer occurrences
    allow_instant: bool = True  # allow co-occurring effects
    pair_top: int = 8           # two-parent candidates kept after pre-screening


def _get(sid: str) -> SessionState:
    try:
        return STORE.get(sid)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"session '{sid}' not found")


@contextmanager
def _locked(sid: str) -> Iterator[SessionState]:
    """Fetch a session and hold its lock; a ValueError (unmet precondition) becomes a 409."""
    st = _get(sid)
    with st.lock:
        try:
            yield st
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e))


def _selection_json(st: SessionState) -> dict:
    by = {s.name: s for s in st.series}
    picks = {e: [by[e].channel_names[i] for i in idx] for e, idx in st.picks.items()}
    return {**st.selector_meta, "picks": picks, "ranking": st.ranking}


def _series_json(st: SessionState) -> list[dict]:
    return ser.series_json(st.series, st.picks, MAX_POINTS)


def _correlations_json(st: SessionState) -> dict:
    return {k: ser.correlation_json(v) for k, v in st.correlations.items()}


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
        "true_states": true_states,
        "true_state_names": {int(k): v for k, v in names.items()},
        "has_ground_truth": st.has_truth,
        "stats": st.stats,
        "info": st.info,
        "metric_detect_defaults": METRIC_DETECT_DEFAULTS.get(st.params.get("dataset") or ""),
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/datasets")
def datasets() -> dict:
    """List every selectable dataset, including ones that need a download."""
    import data as datalayer

    items = [
        {"id": i.id, "label": i.label, "group": i.group, "source": i.source,
         "background": i.background, "available": i.available, "note": i.note, "tunable": i.tunable}
        for i in datalayer.list_datasets()
    ]
    return {"datasets": items}


@app.post("/api/sessions")
def create_session(req: DataReq) -> dict:
    try:
        st = STORE.create(req.model_dump())
    except KeyError as e:  # unknown dataset id
        raise HTTPException(status_code=404, detail=str(e.args[0]) if e.args else str(e))
    except (ValueError, FileNotFoundError) as e:  # listed but not integrated / raw data missing
        raise HTTPException(status_code=409, detail=str(e))
    return {
        "meta": _meta(st),
        "series": _series_json(st),
    }


@app.get("/api/sessions/{sid}")
def get_session(sid: str) -> dict:
    with _locked(sid) as st:  # read under the lock to avoid half-written stage output
        out: dict = {"meta": _meta(st), "series": _series_json(st)}
        if st.picks is not None:
            out["selection"] = _selection_json(st)
        if st.detected is not None:
            out["detected"] = ser.detected_json(st.detected, st.owner)
        if st.correlations:
            out["correlations"] = _correlations_json(st)
        if st.causality is not None:
            out["causality"] = ser.state_causal_json(st.causality, st.owner)
        return out


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str) -> dict:
    STORE.delete(sid)
    return {"deleted": sid}


@app.post("/api/sessions/{sid}/select")
def select(sid: str, req: SelectReq) -> dict:
    with _locked(sid) as st:
        run_select(st, req.selector, req.K, picks=req.picks)
        return {
            "meta": _meta(st),
            "selection": _selection_json(st),
            "series": _series_json(st),
        }


def _detect_args(req: DetectReq) -> tuple:
    return req.win_size, req.step, req.nb_steps, req.n_states, req.min_seg_len


@app.post("/api/sessions/{sid}/detect")
def detect(sid: str, req: DetectReq) -> dict:
    with _locked(sid) as st:
        run_detect(st, *_detect_args(req))
        return {"meta": _meta(st), "detected": ser.detected_json(st.detected, st.owner)}


@app.post("/api/sessions/{sid}/detect/stream")
def detect_stream(sid: str, req: DetectReq) -> StreamingResponse:
    """Stage 3 as NDJSON: a ``plan`` line, one ``metric`` line per metric, then ``done`` or ``error``."""
    import json
    import queue
    import threading

    st = _get(sid)
    q: queue.Queue = queue.Queue()

    def on_metric(seq, entity, metric, done, total):
        item = ser.detected_json([seq], {seq.name: (entity, metric)})[0]
        q.put({"type": "metric", "done": done, "total": total, "detected": item})

    def work():
        try:
            with st.lock:
                q.put({"type": "plan", "items": [{"entity": m.name, "metric": ch}
                                                 for m in reduced_series(st) for ch in m.channel_names]})
                run_detect(st, *_detect_args(req), on_metric=on_metric)
                out = {"type": "done", "meta": _meta(st), "detected": ser.detected_json(st.detected, st.owner)}
            q.put(out)
        except Exception as e:  # noqa: BLE001 - the stream has started, so errors go into it
            q.put({"type": "error", "detail": str(e)})

    threading.Thread(target=work, daemon=True).start()

    def lines():
        while True:
            msg = q.get()
            yield json.dumps(msg, ensure_ascii=False) + "\n"
            if msg["type"] in ("done", "error"):
                return

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@app.post("/api/sessions/{sid}/detect/calibrate")
def calibrate(sid: str, req: CalibrateReq) -> dict:
    """Apply manual calibration; correlation and causality are invalidated."""
    with _locked(sid) as st:
        run_calibrate(st, [e.model_dump() for e in req.series])
        return {"meta": _meta(st), "detected": ser.detected_json(st.detected, st.owner)}


@app.post("/api/sessions/{sid}/correlate")
def correlate(sid: str, req: CorrelateReq) -> dict:
    with _locked(sid) as st:
        run_correlate(st, req.min_lift, req.min_jaccard)
        return {"meta": _meta(st), "correlations": _correlations_json(st)}


@app.post("/api/sessions/{sid}/causality")
def causality(sid: str, req: CausalityReq) -> dict:
    with _locked(sid) as st:
        run_causality(st, req.min_occ, req.allow_instant, req.pair_top)
        return {"meta": _meta(st), "causality": ser.state_causal_json(st.causality, st.owner)}


# Serve the built frontend (./dist) when present.
_dist = Path(__file__).resolve().parent.parent / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
