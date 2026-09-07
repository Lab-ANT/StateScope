"""A tiny plugin registry, realising the paper's "versatile analytical toolkit" goal.

Each stage exposes several interchangeable methods (ISSD vs ranking selectors,
Time2State vs E2USD, overall vs transition correlation). The registry lets the pipeline
and the demo look a method up by name without importing every implementation.

Usage
----
    from statescope.core.registry import register, get

    @register("detector", "e2usd")
    class E2USDDetector(StateDetector):
        ...

    Detector = get("detector", "e2usd")
"""

from __future__ import annotations

from typing import Callable, TypeVar

_REGISTRY: dict[str, dict[str, type]] = {}

T = TypeVar("T")


def register(stage: str, name: str) -> Callable[[type[T]], type[T]]:
    def deco(cls: type[T]) -> type[T]:
        _REGISTRY.setdefault(stage, {})[name] = cls
        return cls

    return deco


def get(stage: str, name: str) -> type:
    try:
        return _REGISTRY[stage][name]
    except KeyError as exc:
        available = list(_REGISTRY.get(stage, {}))
        raise KeyError(
            f"No '{name}' registered for stage '{stage}'. Available: {available}"
        ) from exc


def available(stage: str) -> list[str]:
    return list(_REGISTRY.get(stage, {}))
