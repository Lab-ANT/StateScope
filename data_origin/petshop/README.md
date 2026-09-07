# PetShop (vendored subset)

*The PetShop Dataset - Finding Causes of Performance Issues across Microservices*
(Hardt, Kirschbaum et al., CLeaR 2024, PMLR v236; arXiv:2311.04806).
Upstream: <https://github.com/amazon-science/petshop-root-cause-analysis>

- Code: Apache-2.0 (see `LICENSE`)
- **Data: CC-BY-4.0** — attribution only, so this subset is committed and the demo works
  immediately after a clone.

## What is here

```
temporal_traffic1/
├── noissue/metrics.csv   1652 x 287: 41 components x {latency, requests, availability}
│                         x {Average, Sum, p50, p90, p95, p99}, on a regular 5-minute grid
├── graph.csv             service dependency (call) graph
└── issues.json           8 injected faults, each with symptom and root-cause components
```

This project uses the `noissue` baseline: no injected fault, just load varying over time, so
detection finds the real operating regimes. Preprocessing keeps five real channels per
service (mean/p90/p99 latency, requests, availability) and adds a couple of synthetic noise
channels to demonstrate stage-2 indicator selection.

## Ground truth

There are no per-timestep state labels. Supervision exists at two other levels: the call
graph in `graph.csv` (a structural prior, explicitly *not* causal ground truth) and the
root-cause labels in `issues.json`. Both ship in `extra` for the causality stage to compare
against.
