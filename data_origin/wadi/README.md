# WADI — Water Distribution testbed

SUTD iTrust, `WADI.A2_19 Nov 2019` (Ahmed et al., CySWATER 2017).
**Access requires a signed agreement with iTrust and the data may not be redistributed**, so
nothing is committed here.

## How to obtain

Request access from <https://itrust.sutd.edu.sg/itrust-labs_datasets/> and place the archive
at `data_origin/WaDi.zip`. It does not need to be unpacked;
`data/preprocess/wadi.py` reads the member `WADI.A2_19 Nov 2019/WADI_attackdataLABLE.csv`
directly and caches the result to `data/processed/wadi/`.

## What it is

Three phases run in series, each under its own PLC, with water flowing one way P1 → P2 → P3:

| Phase | Role | Sensors (A2) |
|---|---|---|
| P1 primary grid | intake and first-stage treatment | 19 |
| P2 secondary grid | distribution to consumer tanks | 82 |
| P3 return grid | recovery and return flow | 15 |

About 116 SCADA sensors and actuators at 1 Hz over 16 days (14 normal, then 15 attacks on
pumps, valves and setpoints). The A2 file ships its own attack label column.

In this project each phase is treated as one object, its selected continuous sensors are that
object's channels, and causal edges between phases correspond to physical water propagation —
which makes the one-way P1 → P2 → P3 flow a clean directional reference.
