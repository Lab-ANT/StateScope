import { useSyncExternalStore, type ReactNode } from "react";
import { zh } from "./zh";
import { en } from "./en";

// Minimal i18n core (an external store read with useSyncExternalStore):
//   - dictionaries are flat dotted key -> string; `zh` is the source of truth and `en` is
//     type-checked against it, so a missing key is a compile error;
//   - `{name}` interpolates, `**bold**` is rendered as <b> by `rt()`, so no JSX in dictionaries;
//   - language priority: ?lang deep link, then localStorage, then the default.

export type Lang = "zh" | "en";
export type Dict = typeof zh;
export type Key = keyof Dict;

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

const KEY = "statescope.lang";

function readInitial(): Lang {
  try {
    // A ?lang deep link wins and is persisted, so navigating away does not reset it.
    const u = new URLSearchParams(window.location.search).get("lang");
    if (u === "en" || u === "zh") {
      try {
        localStorage.setItem(KEY, u);
      } catch {
        /* private mode: keep it for this session only */
      }
      return u;
    }
    const v = localStorage.getItem(KEY);
    return v === "en" || v === "zh" ? v : "zh";
  } catch {
    return "zh";
  }
}

let current: Lang = readInitial();
const subs = new Set<() => void>();

syncHtmlLang();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  syncHtmlLang();
  subs.forEach((f) => f());
}

function syncHtmlLang(): void {
  try {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  } catch {
    /* ignore (no document, e.g. in tests) */
  }
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "zh" as Lang);
}

type Vars = Record<string, string | number>;

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Module-level lookup, usable outside components (e.g. lib/knowledge.ts).
export function t(key: Key, vars?: Vars): string {
  const d = DICTS[current];
  const s = d[key as string] ?? DICTS.zh[key as string] ?? (key as string);
  return interpolate(s, vars);
}

export type TFn = (key: Key, vars?: Vars) => string;

// Component hook: re-renders when the language changes.
export function useT(): TFn {
  useLang();
  return t;
}

// Render `**bold**` as <b>; everything else passes through.
export function rt(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== "");
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <b key={i} className="font-medium text-fg">
            {p.slice(2, -2)}
          </b>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

// Look a string up and render its rich text in one call.
export function tr(key: Key, vars?: Vars): ReactNode {
  return rt(t(key, vars));
}
