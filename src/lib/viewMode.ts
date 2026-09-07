import { useSyncExternalStore } from "react";

// Global view mode:
//   "preview" - hides datasets that need a download and the ground-truth overlay;
//   "full"    - shows every dataset (greying out unavailable ones) and the overlay.
// The switch only appears in DEV builds; production is always "preview".
export type ViewMode = "full" | "preview";

export const IS_DEV: boolean = import.meta.env.DEV;

const KEY = "statescope.viewMode";
let current: ViewMode = readInitial();

function readInitial(): ViewMode {
  try {
    // ?mode=full wins, then localStorage, then the default.
    const u = new URLSearchParams(window.location.search).get("mode");
    if (u === "full" || u === "preview") return u;
    const v = localStorage.getItem(KEY);
    return v === "full" || v === "preview" ? v : "preview";
  } catch {
    return "preview";
  }
}

const subs = new Set<() => void>();

export function getViewMode(): ViewMode {
  return IS_DEV ? current : "preview";
}

export function setViewMode(m: ViewMode): void {
  current = m;
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* ignore */
  }
  subs.forEach((f) => f());
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

// Read the mode in a component; re-renders on change.
export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getViewMode, () => "preview");
}
