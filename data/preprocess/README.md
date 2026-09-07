# `data/preprocess/` — raw data to ready-to-use artefacts

Converts raw inputs in `data_origin/` into cached artefacts in `data/processed/`.

Each dataset module exports:

```python
<DS>_INFO          # DatasetInfo metadata, surfaced through the catalog
build(...)         # read data_origin -> process -> write data/processed -> StandardDataset
load_or_build(...) # read the artefact if present, otherwise build it now
processed_path(..) # path of the npz artefact
```

`_bundle.py` holds the shared `StandardDataset` <-> npz round trip, so every dataset writes
the same on-disk format. The heavy lifting lives here; `data/loaders/` is a thin read layer.

## Usage

Building is optional — the loader builds on first use — but can be triggered explicitly:

```bash
uv run python -m data.preprocess.petshop
uv run python -m data.preprocess.lemma_rca product_review 20210517
uv run python -m data.preprocess.wadi
```

Everything under `data/processed/` is a derivative and is git-ignored; it can always be
rebuilt from `data_origin/`.

## Adding a dataset

1. Put the raw data under `data_origin/<id>/` with a README covering layout, access and licence.
2. Add `<id>.py` here: define `<ID>_INFO`, `build()` (writing via `_bundle.save_bundle`) and
   `load_or_build()`.
3. Add a thin `data/loaders/<id>.py` re-exporting `<ID>_INFO` and `load_or_build`.
4. Register the entry in `data/catalog.py`, and ignore the raw data in `.gitignore` if needed.
