# `data_origin/` — raw inputs

The data layer is a four-step ETL:

```
① data_origin/      raw inputs (this directory)
② data/preprocess/  conversion scripts
③ data/processed/   ready-to-use artefacts (git-ignored, rebuilt on demand)
④ data/loaders/     thin read layer consumed via `import data`
```

Nothing here is read by the pipeline directly — everything goes through `import data`.

**What is committed.** Raw data is generally *not* committed. The one exception is
`petshop/`, which is small and CC-BY-4.0, so the main demo works straight after a clone.
The other datasets require a download; the instructions are in each subdirectory.

```
data_origin/
├── petshop/                  vendored (CC-BY-4.0)
│   └── temporal_traffic1/    metrics.csv + graph.csv (dependency graph) + issues.json
├── lemma_rca/                download required — see lemma_rca/README.md
│   ├── product_review/Metrics Data/*.zip
│   └── cloud_computing/Metrics Data/*.zip
├── wadi/                     download required — see wadi/README.md
└── WaDi.zip                  the WADI archive, once obtained
```

## Sources and licences

| Dataset | Source | Licence | Committed |
|---|---|---|---|
| PetShop | Hardt et al., CLeaR 2024 · amazon-science/petshop-root-cause-analysis | CC-BY-4.0 | yes |
| LEMMA-RCA | Zheng et al., NeurIPS 2024 D&B · HF `Lemma-RCA-NEC` | CC-BY-ND-4.0 | no |
| WADI | Ahmed et al., CySWATER 2017 · SUTD iTrust | agreement required, not redistributable | no |

Two licence notes worth repeating:

- **LEMMA-RCA is CC-BY-ND**: no derivatives may be redistributed, so neither the raw zips nor
  anything built from them is committed here.
- **WADI** requires a signed agreement with SUTD iTrust and may not be redistributed at all.

Everything under `data/processed/` is a derivative of the above and is git-ignored; it is
rebuilt from `data_origin/` on first use.
