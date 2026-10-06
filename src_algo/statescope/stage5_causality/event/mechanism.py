"""Causal mechanism κ = (triggers, cond F) and discovery results used by NIAGARA."""

from __future__ import annotations

from dataclasses import dataclass, field

from .events import IntervalEvents


@dataclass(frozen=True)
class Mechanism:
    child: int
    triggers: tuple[int, ...] = ()
    cond: tuple[tuple[int, bool], ...] = ()
    op: str = "and"

    @property
    def kind(self) -> str:
        if not self.triggers:
            return "cond_pp" if self.cond else "background"
        if self.cond:
            return "cond_trigger"
        return "trigger" if len(self.triggers) == 1 else "trigger_or"

    def parents(self) -> set[int]:
        return set(self.triggers) | {c for c, _ in self.cond}

    def label(self, names: list[str]) -> str:
        conds = [("¬" if neg else "") + f"on({names[c]})" for c, neg in self.cond]
        f = (" ∨ " if self.op == "or" else " ∧ ").join(conds)
        child = names[self.child]
        if not self.triggers:
            return f"{f} ⇒ {child}" if conds else f"∅ ⇒ {child}"
        head = " ∨ ".join(names[t] for t in self.triggers) + (f" ∧ {f}" if conds else "")
        return f"{head} → {child}"


@dataclass
class Found:
    """The mechanism selected for a child event."""

    mech: Mechanism
    gain: float                 # bits saved relative to "background process only"
    params: dict = field(default_factory=dict)
    # attributed occurrences: (parent event index, parent start, child start)
    matches: list[tuple[int, int, int]] = field(default_factory=list)


@dataclass
class CausalResult:
    algo: str
    events: IntervalEvents
    found: dict[int, Found]                       # child event -> mechanism (none = background)
    runtime_s: float = 0.0
    n_fits: int = 0                               # number of candidates scored
    ranked: dict[int, list[Found]] = field(default_factory=dict)  # child -> alternatives, gain desc.
