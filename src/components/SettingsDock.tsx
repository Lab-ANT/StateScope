import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { setLang, useLang, useT } from "../i18n";

// Floating language capsule, kept out of the sidebar and header:
//   - fixed to the viewport, so it can be dragged out of the window onto the desktop area;
//   - free placement, snapping only when released near a viewport edge; position persists;
//   - collapsible to a small ball showing the active language code;
//   - dragging uses pointer events while the toggles use click, so keyboard and assistive
//     technology work as usual.
// z-40 keeps it below modals, so a dialog covers it rather than competing for focus.

interface Dock {
  x: number;
  y: number;
  collapsed: boolean;
}

const KEY = "statescope.settingsDock";
const MARGIN = 14; // gap kept from the viewport edge
const SNAP = 28; // release within this distance snaps flush
const SLOP = 4; // movement below this counts as a click

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function readDock(): Dock {
  const fallback = (): Dock => ({
    x: Math.max(MARGIN, (typeof window === "undefined" ? 1200 : window.innerWidth) - 360),
    y: Math.max(MARGIN, (typeof window === "undefined" ? 800 : window.innerHeight) - 64),
    collapsed: false,
  });
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback();
    const d = JSON.parse(raw) as Dock;
    if (typeof d.x !== "number" || typeof d.y !== "number") return fallback();
    return { x: d.x, y: d.y, collapsed: !!d.collapsed };
  } catch {
    return fallback();
  }
}

export function SettingsDock() {
  const t = useT();
  const lang = useLang();

  const [dock, setDock] = useState<Dock>(readDock);
  const [dragging, setDragging] = useState(false);
  const elRef = useRef<HTMLDivElement>(null);
  const grab = useRef({ dx: 0, dy: 0, moved: 0 });

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(dock));
    } catch {
      /* ignore */
    }
  }, [dock]);

  // Keep the dock inside the viewport, including after collapse or resize.
  const fit = useCallback((x: number, y: number): { x: number; y: number } => {
    const r = elRef.current?.getBoundingClientRect();
    const w = r?.width ?? 320;
    const h = r?.height ?? 44;
    return {
      x: clamp(x, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN)),
      y: clamp(y, MARGIN, Math.max(MARGIN, window.innerHeight - h - MARGIN)),
    };
  }, []);

  useEffect(() => {
    const onResize = () => setDock((d) => ({ ...d, ...fit(d.x, d.y) }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit]);
  useEffect(() => {
    setDock((d) => ({ ...d, ...fit(d.x, d.y) }));
  }, [dock.collapsed, fit]);

  // Dragging: attach window listeners on pointerdown; more robust than pointer capture.
  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return; // toggles do not drag
    e.preventDefault();
    const r = elRef.current!.getBoundingClientRect();
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: 0 };
    const startX = e.clientX;
    const startY = e.clientY;

    const move = (ev: PointerEvent) => {
      grab.current.moved = Math.max(
        grab.current.moved,
        Math.hypot(ev.clientX - startX, ev.clientY - startY),
      );
      if (grab.current.moved < SLOP) return;
      setDragging(true);
      setDock((d) => ({ ...d, ...fit(ev.clientX - grab.current.dx, ev.clientY - grab.current.dy) }));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      if (grab.current.moved < SLOP) return; // a click on the handle, not a drag
      // Snap flush when released near an edge; anywhere else keeps the free position.
      const r2 = elRef.current!.getBoundingClientRect();
      let { x, y } = fit(ev.clientX - grab.current.dx, ev.clientY - grab.current.dy);
      if (x <= MARGIN + SNAP) x = MARGIN;
      else if (x + r2.width >= window.innerWidth - MARGIN - SNAP) x = window.innerWidth - r2.width - MARGIN;
      if (y <= MARGIN + SNAP) y = MARGIN;
      else if (y + r2.height >= window.innerHeight - MARGIN - SNAP) y = window.innerHeight - r2.height - MARGIN;
      setDock((d) => ({ ...d, x, y }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const setCollapsed = (collapsed: boolean) => setDock((d) => ({ ...d, collapsed }));

  const shell = cn(
    "pointer-events-auto fixed z-40 flex select-none items-center rounded-full border border-border",
    "bg-panel/95 shadow-[0_6px_20px_-6px_rgba(0,0,0,0.30)] backdrop-blur",
    dragging ? "cursor-grabbing" : "cursor-grab",
    !dragging && "transition-[left,top] duration-150 ease-out",
  );

  if (dock.collapsed) {
    return (
      <div
        ref={elRef}
        onPointerDown={onPointerDown}
        style={{ left: dock.x, top: dock.y }}
        className={cn(shell, "h-10 w-10 justify-center")}
      >
        <button
          data-no-drag
          onClick={() => setCollapsed(false)}
          aria-label={t("settings.expand")}
          title={t("settings.expand")}
          className="relative flex h-full w-full items-center justify-center rounded-full font-mono text-[11px] font-semibold text-fg-muted transition-colors hover:text-fg"
        >
          {lang === "zh" ? "ZH" : "EN"}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={elRef}
      onPointerDown={onPointerDown}
      style={{ left: dock.x, top: dock.y }}
      className={cn(shell, "h-11 gap-2 pl-2.5 pr-1.5")}
    >
      <span className="text-[13px] leading-none text-fg-faint" title={t("settings.drag")} aria-hidden>
        ⠿
      </span>

      <Group label={t("settings.language")}>
        {(["zh", "en"] as const).map((v) => (
          <Seg key={v} active={lang === v} onClick={() => setLang(v)}>
            {t(v === "zh" ? "lang.zh" : "lang.en")}
          </Seg>
        ))}
      </Group>

      <button
        data-no-drag
        onClick={() => setCollapsed(true)}
        aria-label={t("settings.collapse")}
        title={t("settings.collapse")}
        className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] text-fg-faint transition-colors hover:bg-fg/[0.06] hover:text-fg"
      >
        ✕
      </button>
    </div>
  );
}

// One labelled group of segmented buttons.
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5" title={label}>
      <div data-no-drag className="inline-flex rounded-full border border-border bg-app-bg p-0.5">
        {children}
      </div>
    </div>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      data-no-drag
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
        active ? "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.06)]" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
