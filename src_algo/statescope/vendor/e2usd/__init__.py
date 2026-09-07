"""Vendored E2USD detector internals (torch 2.x): DDEM encoder + DPGMM."""
from .clustering import DPGMMClustering
from .encoder import DDEMEncoder
from .network import DDEM, FNCCLoss

__all__ = ["DDEMEncoder", "DPGMMClustering", "DDEM", "FNCCLoss"]
