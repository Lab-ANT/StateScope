# LEMMA-RCA

*LEMMA-RCA: A Large Multi-modal Multi-domain Dataset for Root Cause Analysis*
(Zheng et al., NeurIPS 2024 Datasets & Benchmarks) — <https://lemma-rca.github.io/>,
Hugging Face `Lemma-RCA-NEC`. **Licence: CC-BY-ND-4.0** (attribution, no derivatives).

The raw archives (~1.3 GB) are not committed. Place them here and they will be preprocessed
and cached to `data/processed/lemma_rca/` on first use.

## How to obtain

Download only the **Metrics Data** (multi-channel metric time series). The Log Data is
gigabytes of text and is not used by this project.

```
data_origin/lemma_rca/
├── product_review/Metrics Data/<date>.zip     # microservice domain
└── cloud_computing/Metrics Data/<date>.zip    # cloud domain
```

Each zip is one fault date. `data/preprocess/lemma_rca.py` reads them directly; there is no
need to unpack anything by hand.

## Archive layout

A zip expands into a directory named after the date:

```
20210517/
├── KPI.csv                    system-level KPI series
├── pod_level_data_*.npy       one file per pod-level metric
├── node_level_data_*.npy      one file per node-level metric
├── p2n.npy                    pod -> node placement
└── *_golden_signal_*.npy      root-cause / anomaly annotations (some dates)
```

The `.npy` files are zero-dimensional object arrays; unpack with
`np.load(..., allow_pickle=True).item()` to get nested dicts of the form:

```
{ <subsystem>: {
    'Pod_Name' / 'Node_Name': [str, ...],   # N entities
    'KPI_Feature':            [str],        # metric name
    'Sequence':               [T, N] array, # columns aligned with the names above
    'time':                   [int, ...],   # unix timestamps (unevenly sampled)
}}
```

Mapped onto StateScope, each pod becomes one series and each pod-level metric a channel;
`p2n` ships in `extra` as a reference topology for the causality stage. Ground truth is
fault root-cause labels rather than per-timestep states, so detection runs unsupervised.

Note that subsystem keys and metric sets differ slightly between dates and domains, so the
loader reads them tolerantly.
