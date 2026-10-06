import { useEffect, useMemo, useRef, useState } from "react";
import type { Detected, Segment, SeriesData } from "../types";
import { stateColor } from "../theme";
import { Btn, SegToggle } from "./ui";
import { cn } from "../lib/cn";
import { useT, tr, dyn } from "../i18n";

// Manual calibration workbench: drag a boundary to nudge it, double-click inside a segment
// to split, click to select and then relabel or merge, scroll on a segment to cycle states.
// Low-confidence segments get an amber top bar so partial review is enough; segments edited
// by hand get a green bottom bar. Edits stay local until "apply", which writes them back and
// invalidates correlation and causality.

const LOW_CONF = 0.8; // 1 - entropy threshold

// Design tokens inlined for SVG, matching tailwind.config
const ACCENT = "oklch(0.55 0.13 265)";
const AMBER = "oklch(0.72 0.13 75)";
const GREEN = "oklch(0.62 0.13 155)";
const BOUND = "oklch(0.20 0.015 70 / 0.30)";
const WAVE_COLORS = ["#3b6fe0", "#2ca35a", "#e08a1e", "#9a52d6", "#2f9ec4"];

type EditSeg = { start: number; end: number; state: number; confidence: number | null; touched: boolean };

const fromDetected = (d: Detected): EditSeg[] =>
  d.segments.map((s) => ({ start: s.start, end: s.end, state: s.state, confidence: s.confidence ?? null, touched: false }));

const plain = (segs: EditSeg[]): Segment[] => segs.map((s) => ({ start: s.start, end: s.end, state: s.state }));

const sameSegs = (a: Segment[], b: Segment[]) =>
  a.length === b.length && a.every((s, i) => s.start === b[i].start && s.end === b[i].end && s.state === b[i].state);

export function CalibrationModal(props: {
  detected: Detected[];
  series: SeriesData[];
  busy: boolean;
  onApply: (edits: { name: string; segments: Segment[] }[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { detected, series, busy, onApply, onClose } = props;
  const names = detected.map((d) => d.name);

  const [cur, setCur] = useState(names[0]);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cur]);
  const [edits, setEdits] = useState<Record<string, EditSeg[]>>(
    () => Object.fromEntries(detected.map((d) => [d.name, fromDetected(d)])));
  const [history, setHistory] = useState<Record<string, EditSeg[][]>>({});
  const [future, setFuture] = useState<Record<string, EditSeg[][]>>({});
  const [selSeg, setSelSeg] = useState<number | null>(null);
  const [hoverB, setHoverB] = useState<number | null>(null);
  const [dragB, setDragB] = useState<number | null>(null);
  const [waveMode, setWaveMode] = useState<"overlay" | "per-channel">("per-channel");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const segs = edits[cur];
  const T = segs[segs.length - 1].end;
  const orig = useMemo(() => detected.find((d) => d.name === cur)!, [detected, cur]);
  const dirtyNames = names.filter((n) => {
    const od = detected.find((d) => d.name === n)!;
    return !sameSegs(plain(edits[n]), od.segments);
  });
  const lowConfCount = segs.filter((s) => !s.touched && s.confidence !== null && s.confidence < LOW_CONF).length;
  const paletteStates = useMemo(
    () => [...new Set(segs.map((s) => s.state))].sort((a, b) => a - b), [segs]);

  // ── Edit operations; all go through commit, so all are undoable ──
  function commit(next: EditSeg[], base?: EditSeg[]) {
    setHistory((h) => ({ ...h, [cur]: [...(h[cur] ?? []), base ?? segs] }));
    setFuture((f) => ({ ...f, [cur]: [] }));
    setEdits((e) => ({ ...e, [cur]: next }));
  }
  const undo = () => {
    const h = history[cur] ?? [];
    if (!h.length) return;
    setFuture((f) => ({ ...f, [cur]: [segs, ...(f[cur] ?? [])] }));
    setHistory((x) => ({ ...x, [cur]: h.slice(0, -1) }));
    setEdits((e) => ({ ...e, [cur]: h[h.length - 1] }));
    setSelSeg(null);
  };
  const redo = () => {
    const f = future[cur] ?? [];
    if (!f.length) return;
    setHistory((h) => ({ ...h, [cur]: [...(h[cur] ?? []), segs] }));
    setFuture((x) => ({ ...x, [cur]: f.slice(1) }));
    setEdits((e) => ({ ...e, [cur]: f[0] }));
    setSelSeg(null);
  };
  const reset = () => { commit(fromDetected(orig)); setSelSeg(null); };

  function splitAt(t: number) {
    const i = segs.findIndex((s) => s.start < t && t < s.end);
    if (i < 0) return;
    const s = segs[i];
    commit([
      ...segs.slice(0, i),
      { ...s, end: t, touched: true },
      { ...s, start: t, touched: true },
      ...segs.slice(i + 1),
    ]);
    setSelSeg(i + 1);
  }
  function mergeAt(k: number) { // merge segments k and k+1, keeping the longer side's state
    if (k < 0 || k >= segs.length - 1) return;
    const a = segs[k], b = segs[k + 1];
    const state = a.end - a.start >= b.end - b.start ? a.state : b.state;
    commit([...segs.slice(0, k), { start: a.start, end: b.end, state, confidence: null, touched: true }, ...segs.slice(k + 2)]);
    setSelSeg(k);
  }
  function setStateOf(i: number, state: number) {
    if (segs[i].state === state) return;
    commit(segs.map((s, j) => (j === i ? { ...s, state, touched: true } : s)));
  }
  function cycleState(i: number, dir: 1 | -1) {
    const order = paletteStates;
    const at = order.indexOf(segs[i].state);
    setStateOf(i, order[(at + dir + order.length) % order.length]);
  }

  // ── Boundary dragging; one history entry per drag ──
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ k: number; pre: EditSeg[] } | null>(null);

  const xToT = (clientX: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return Math.round(((clientX - r.left) / r.width) * T);
  };
  function startDrag(k: number, e: React.PointerEvent) {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { k, pre: segs };
    setDragB(k);
  }
  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const minLen = Math.max(1, Math.round(T * 0.004));
    const lo = d.pre[d.k].start + minLen, hi = d.pre[d.k + 1].end - minLen;
    const t = Math.min(hi, Math.max(lo, xToT(e.clientX)));
    setEdits((ed) => {
      const cs = ed[cur];
      if (cs[d.k].end === t) return ed;
      const next = cs.map((s, j) =>
        j === d.k ? { ...s, end: t, touched: true } : j === d.k + 1 ? { ...s, start: t, touched: true } : s);
      return { ...ed, [cur]: next };
    });
  }
  function endDrag() {
    const d = dragRef.current;
    dragRef.current = null;
    setDragB(null);
    if (d && segs[d.k].end !== d.pre[d.k].end) {
      // The drag wrote edits directly; record history now, based on the pre-drag snapshot.
      setHistory((h) => ({ ...h, [cur]: [...(h[cur] ?? []), d.pre] }));
      setFuture((f) => ({ ...f, [cur]: [] }));
    }
  }

  // Scroll cycles a segment's state; a native listener lets us preventDefault.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const attr = (e.target as Element)?.getAttribute?.("data-seg");
      if (attr == null) return;
      e.preventDefault();
      cycleState(+attr, e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // ── Canvas geometry ──
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((en) => setW(en[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Reference waveforms: the selected channels if any, otherwise the first six.
  const waveChannels = useMemo(() => {
    const s = series.find((x) => x.name === cur);
    if (!s) return [];
    const sel = s.channels.filter((c) => c.selected);
    return (sel.length ? sel : s.channels).slice(0, 6);
  }, [series, cur]);

  const PAD_T = 10, RIB_H = 46, GAP = 10, OVERLAY_H = 148, ROW_H = 44;
  const perCh = waveMode === "per-channel";
  const waveY = PAD_T + RIB_H + GAP;
  const waveAreaH = perCh ? Math.max(ROW_H, waveChannels.length * ROW_H) : OVERLAY_H;
  const waveBottom = waveY + waveAreaH;
  const H = waveBottom + 6;
  const xOf = (t: number) => (t / T) * W;

  // Draw one channel into the band [top, top+height), normalised on its own range.
  const wavePathBand = (vals: number[], top: number, height: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    const n = vals.length;
    return vals.map((v, i) => {
      const x = (i / (n - 1)) * W;
      const y = top + 6 + (1 - (v - lo) / span) * (height - 12);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  };

  const sel = selSeg !== null && selSeg < segs.length ? segs[selSeg] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-xl border border-border bg-win-bg shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border-soft px-6 py-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-faint">STAGE 3 · CALIBRATE</div>
            <h2 className="mt-1 text-lg font-semibold text-fg">{t("calib.title")}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">{tr("calib.hint")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Btn variant="ghost" className="h-8 px-2.5 text-xs" onClick={undo} disabled={!(history[cur] ?? []).length}>{t("calib.undo")}</Btn>
            <Btn variant="ghost" className="h-8 px-2.5 text-xs" onClick={redo} disabled={!(future[cur] ?? []).length}>{t("calib.redo")}</Btn>
            <Btn variant="ghost" className="h-8 px-2.5 text-xs" onClick={reset}>{t("calib.reset")}</Btn>
            <button onClick={onClose} className="ml-2 text-xs text-fg-muted hover:text-fg">{t("common.close")}</button>
          </div>
        </div>

        {/* Series switch: one scrollable row */}
        <div ref={tabsRef} className="mx-6 mt-3 overflow-x-auto pb-1">
          <SegToggle value={cur} onChange={(v) => { setCur(v); setSelSeg(null); }}
            options={names.map((n) => ({ value: n, label: dirtyNames.includes(n) ? `${dyn(n)} •` : dyn(n) }))} />
        </div>
        {/* Waveform mode, legend */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[11px] text-fg-faint">{t("calib.reference")}</span>
            <SegToggle value={waveMode} onChange={setWaveMode}
              options={[{ value: "overlay", label: t("calib.overlay") }, { value: "per-channel", label: t("calib.perChannel") }]} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
            {paletteStates.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-[3px]" style={{ background: stateColor(s) }} />state {s}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-fg-faint">
              <span className="h-1 w-3 rounded-full" style={{ background: AMBER }} />{t("calib.lowConf", { n: lowConfCount })}
            </span>
            <span className="inline-flex items-center gap-1.5 text-fg-faint">
              <span className="h-1 w-3 rounded-full" style={{ background: GREEN }} />{t("calib.manual")}
            </span>
          </div>
        </div>

        {/* Editing canvas */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          <div ref={boxRef} className="rounded-lg border border-border-soft bg-panel p-3">
            <svg ref={svgRef} width={W} height={H} className="block select-none touch-none"
              onPointerMove={onDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
              {/* Editable state ribbon */}
              {segs.map((s, i) => (
                <g key={`seg${i}`}>
                  <rect data-seg={i} x={xOf(s.start)} y={PAD_T} width={Math.max(1, xOf(s.end) - xOf(s.start))} height={RIB_H}
                    fill={stateColor(s.state)} className="cursor-pointer"
                    onClick={() => setSelSeg(i)}
                    onDoubleClick={(e) => splitAt(Math.min(s.end - 1, Math.max(s.start + 1, xToT(e.clientX))))}>
                    <title>
                      {t("calib.segTip", {
                        start: s.start, end: s.end, state: s.state,
                        conf: s.confidence !== null ? t("calib.confSuffix", { v: s.confidence }) : "",
                        manual: s.touched ? t("calib.manualSuffix") : "",
                      })}
                    </title>
                  </rect>
                  {!s.touched && s.confidence !== null && s.confidence < LOW_CONF && (
                    <rect x={xOf(s.start)} y={PAD_T} width={Math.max(1, xOf(s.end) - xOf(s.start))} height={3} fill={AMBER} pointerEvents="none" />
                  )}
                  {s.touched && (
                    <rect x={xOf(s.start)} y={PAD_T + RIB_H - 3} width={Math.max(1, xOf(s.end) - xOf(s.start))} height={3} fill={GREEN} pointerEvents="none" />
                  )}
                </g>
              ))}
              {selSeg !== null && sel && (
                <rect x={xOf(sel.start)} y={PAD_T} width={Math.max(1, xOf(sel.end) - xOf(sel.start))} height={RIB_H}
                  fill="none" stroke={ACCENT} strokeWidth={2} pointerEvents="none" />
              )}

              {/* Reference waveforms, tinted by the current segmentation */}
              {segs.map((s, i) => (
                <rect key={`tint${i}`} x={xOf(s.start)} y={waveY} width={Math.max(1, xOf(s.end) - xOf(s.start))} height={waveAreaH}
                  fill={stateColor(s.state)} opacity={0.07} pointerEvents="none" />
              ))}
              <rect x={0} y={waveY} width={W} height={waveAreaH} fill="none" stroke="oklch(0.93 0.005 80)" />
              {perCh ? (
                // Per channel: one row each, own y-axis, name outlined in white
                waveChannels.map((c, i) => {
                  const top = waveY + i * ROW_H;
                  return (
                    <g key={c.name}>
                      {i > 0 && <line x1={0} y1={top} x2={W} y2={top} stroke="oklch(0.94 0.004 80)" strokeWidth={1} />}
                      <path d={wavePathBand(c.values, top, ROW_H)} fill="none"
                        stroke={WAVE_COLORS[i % WAVE_COLORS.length]} strokeWidth={1.1} opacity={0.85} />
                      <text x={5} y={top + 12} fontSize={10} fontWeight={600} fill={WAVE_COLORS[i % WAVE_COLORS.length]}
                        style={{ paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 3 }} pointerEvents="none">
                        {dyn(c.name)}
                      </text>
                    </g>
                  );
                })
              ) : (
                // Overlay: every channel on one shared y-axis
                waveChannels.map((c, i) => (
                  <path key={c.name} d={wavePathBand(c.values, waveY, waveAreaH)} fill="none"
                    stroke={WAVE_COLORS[i % WAVE_COLORS.length]} strokeWidth={1} opacity={0.75} />
                ))
              )}

              {/* Boundary lines and drag handles, spanning ribbon and waveforms */}
              {segs.slice(0, -1).map((s, k) => {
                const x = xOf(s.end);
                const active = dragB === k || hoverB === k;
                return (
                  <g key={`b${k}`}>
                    <line x1={x} y1={PAD_T - 4} x2={x} y2={waveBottom} pointerEvents="none"
                      stroke={active ? ACCENT : BOUND} strokeWidth={active ? 2 : 1.2} />
                    <path d={`M ${x - 4.5} ${PAD_T - 9} L ${x + 4.5} ${PAD_T - 9} L ${x} ${PAD_T - 1} Z`}
                      fill={active ? ACCENT : "oklch(0.60 0.010 70)"} pointerEvents="none" />
                    <rect x={x - 5} y={PAD_T - 10} width={10} height={waveBottom - PAD_T + 10}
                      fill="transparent" className="cursor-col-resize"
                      onPointerEnter={() => setHoverB(k)} onPointerLeave={() => setHoverB((h) => (h === k ? null : h))}
                      onPointerDown={(e) => startDrag(k, e)}>
                      <title>{t("calib.boundaryTip", { t: s.end })}</title>
                    </rect>
                  </g>
                );
              })}
            </svg>

            {/* Toolbar for the selected segment */}
            <div className="mt-2 flex min-h-[38px] flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-app-bg px-3 py-2">
              {sel ? (
                <>
                  <span className="font-mono text-xs tabular-nums text-fg-muted">
                    {t("calib.selected", {
                      i: selSeg! + 1, start: sel.start, end: sel.end, len: sel.end - sel.start,
                    })}
                    {sel.confidence !== null && !sel.touched && t("calib.confSuffix", { v: sel.confidence })}
                    {sel.touched && t("calib.manualSuffix")}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-xs text-fg-faint">{t("calib.changeTo")}</span>
                    {paletteStates.map((s) => (
                      <button key={s} onClick={() => setStateOf(selSeg!, s)}
                        className={cn("h-5 w-5 rounded-[4px] ring-offset-1 transition-shadow",
                          sel.state === s ? "ring-2 ring-accent" : "hover:ring-2 hover:ring-fg/25")}
                        style={{ background: stateColor(s) }} title={`state ${s}`} />
                    ))}
                    <button onClick={() => setStateOf(selSeg!, Math.max(...paletteStates) + 1)}
                      className="h-5 rounded-[4px] border border-dashed border-border px-1.5 text-[10px] text-fg-muted hover:text-fg"
                      title={t("calib.newStateTip")}>{t("calib.newState")}</button>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    {([[t("calib.mergeLeft"), selSeg === 0, () => mergeAt(selSeg! - 1)],
                       [t("calib.mergeRight"), selSeg === segs.length - 1, () => mergeAt(selSeg!)]] as const
                    ).map(([label, off, fn]) => (
                      <button key={label} disabled={off} onClick={fn}
                        className="rounded-md border border-border bg-panel px-2 py-0.5 text-[11px] text-fg transition-colors hover:bg-app-bg disabled:cursor-default disabled:opacity-45">
                        {label}
                      </button>
                    ))}
                  </span>
                  <button className="ml-auto text-[11px] text-fg-faint hover:text-fg" onClick={() => setSelSeg(null)}>{t("calib.deselect")}</button>
                </>
              ) : (
                <span className="text-xs text-fg-faint">{t("calib.emptyHint")}</span>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 border-t border-border-soft px-6 py-3">
          <span className="text-xs text-fg-faint">
            {t("calib.footer", { dirty: dirtyNames.length, total: names.length })}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Btn variant="outline" onClick={onClose}>{t("common.cancel")}</Btn>
            <Btn onClick={() => onApply(dirtyNames.map((n) => ({ name: n, segments: plain(edits[n]) })))}
              disabled={busy || dirtyNames.length === 0}>
              {busy ? t("calib.applying") : t("calib.apply", { n: dirtyNames.length })}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
