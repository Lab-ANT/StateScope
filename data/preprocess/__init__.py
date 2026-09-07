"""Preprocessing: raw data (``data_origin/``) into ready-to-use data (``data/processed/``).

Each module exports ``<DS>_INFO`` (metadata), ``build(...)`` (raw -> npz artefact) and
``load_or_build(...)`` (read the artefact, or build it now). ``data/loaders/`` are thin
wrappers. Run explicitly with ``uv run python -m data.preprocess.<dataset>``.
"""
