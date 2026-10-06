"""Per-dataset detection parameters for per-metric state detection."""

from __future__ import annotations

# Fixed small n_states + min_seg_len so states recur often enough for state causality (min_occ)
METRIC_DETECT_DEFAULTS: dict[str, dict] = {
    "petshop": {"win_size": 100, "step": 30, "nb_steps": 20, "n_states": 4, "min_seg_len": 20},
    "lemma_rca": {"win_size": 100, "step": 30, "nb_steps": 20, "n_states": 3, "min_seg_len": 100},
    "wadi": {"win_size": 80, "step": 20, "nb_steps": 50, "n_states": 4, "min_seg_len": 50},
}
