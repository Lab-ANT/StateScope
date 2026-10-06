"""Tiny plugin registry: look up a stage implementation by name (``register`` / ``get``)."""

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
