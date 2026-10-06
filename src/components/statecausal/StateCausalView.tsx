import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Field, Note } from "../ui";
import { cn } from "../../lib/cn";
import { dyn, tr, useT } from "../../i18n";
import { PaperMatrix } from "./PaperMatrix";
import { RelationTraces, RELATION_TRACES_MAX_ARROWS } from "./RelationTraces";
import { downloadSvg, mechKey, paperStateColor, type SCEdge, type SCSeries } from "./model";
import type { StateEdge } from "../../lib/stateCausal";

// Defaults to the top-2 cross-entity mechanisms by gain.

interface Mech {
  key: string;
  gain: number;
  kind: string;
  edges: StateEdge[];
  crossEntity: boolean;
}

function defaultPick(mechs: Mech[]): string[] {
  const cross = mechs.filter((m) => m.crossEntity);
  return (cross.length ? cross : mechs).slice(0, 2).map((m) => m.key);
}

export function StateCausalView(props: { dataset: string; results: SCSeries[]; edges: StateEdge[]; resultId: string }) {
  const t = useT();
  const { results, edges } = props;
  const T = Math.max(1, ...results.map((r) => r.T));

  const mechs: Mech[] = useMemo(() => {
    const m = new Map<string, Mech>();
    for (const e of edges) {
      const key = mechKey(e.mech);
      const cur = m.get(key) ?? { key, gain: e.gain, kind: e.mech.kind, edges: [], crossEntity: false };
      cur.edges.push(e);
      cur.crossEntity ||= e.cause.entity !== e.effect.entity;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.gain - a.gain);
  }, [edges]);

  // Reset selection whenever the result changes
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const keysSig = mechs.map((m) => m.key).join("\n");
  useEffect(() => { setSelected(new Set(defaultPick(mechs))); }, [props.resultId, keysSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const [range, setRange] = useState<[number, number]>([0, T]);
  useEffect(() => { setRange([0, T]); }, [T, props.resultId]);

  const matrixRef = useRef<SVGSVGElement>(null);
  const tracesRef = useRef<SVGSVGElement>(null);
  const selEdges: SCEdge[] = edges.filter((e) => selected.has(mechKey(e.mech)));
  const nArrows = selEdges.reduce((n, e) => n + (e.role === "trigger" ? e.mech.matches.length : 0), 0);

  if (mechs.length === 0) {
    return <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-fg-faint">{t("mc.noPairs")}</div>;
  }

  const exportBtn = (onClick: () => void) => (
    <button onClick={onClick} className="rounded border border-border-soft px-2 py-0.5 font-mono text-[10px] uppercase text-fg-muted hover:border-accent hover:text-accent">
      {t("scf.exportSvg")}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <Card>
          <div className="mb-2 flex items-baseline gap-3">
            <h3 className="text-sm font-medium text-fg">{t("scf.matrix")}</h3>
            <div className="ml-auto">{exportBtn(() => downloadSvg(matrixRef.current, `${props.dataset}_state_causal_matrix.svg`))}</div>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-fg-muted">{tr("scf.matrixHint")}</p>
          <PaperMatrix ref={matrixRef} series={results} edges={edges} selected={selected} onToggle={toggle} />
        </Card>

        <Card>
          <div className="mb-2 flex items-baseline gap-3">
            <h3 className="text-sm font-medium text-fg">{t("scf.mechs", { n: mechs.length })}</h3>
            <button className="ml-auto text-[11px] text-accent hover:underline" onClick={() => setSelected(new Set(defaultPick(mechs)))}>
              {t("scf.resetPick")}
            </button>
            <button className="text-[11px] text-fg-muted hover:text-fg" onClick={() => setSelected(new Set())}>{t("ms.none")}</button>
          </div>
          <p className="mb-2 text-xs leading-relaxed text-fg-muted">{t("scf.mechsHint")}</p>
          <div className="max-h-[560px] overflow-auto">
            {mechs.map((m) => (
              <label key={m.key} className={cn("flex cursor-pointer items-start gap-2 border-t border-border-soft px-1 py-1.5 text-xs",
                selected.has(m.key) && "bg-accent-soft/60")}>
                <input type="checkbox" className="mt-0.5 accent-accent" checked={selected.has(m.key)} onChange={() => toggle(m.key)} />
                <span className="flex-1 leading-relaxed">{mechLabel(m, t)}</span>
                {m.edges[0].mech.params.corroborated && (
                  <span title={t("scf.corroboratedTip")} className="whitespace-nowrap rounded bg-sig-done/10 px-1 text-[10px] text-sig-done">{t("scf.corroborated")}</span>
                )}
                <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-fg-muted">{m.gain.toFixed(1)}</span>
              </label>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <div className="mb-2 flex flex-wrap items-end gap-3">
          <h3 className="mr-2 text-sm font-medium text-fg">{t("scf.traces")}</h3>
          <Field label={t("scf.from")} value={range[0]} min={0} max={T - 1} step={100}
            onChange={(v) => setRange([Math.min(Math.max(0, Math.round(Number(v) || 0)), range[1] - 1), range[1]])} />
          <Field label={t("scf.to")} value={range[1]} min={1} max={T} step={100}
            onChange={(v) => setRange([range[0], Math.max(range[0] + 1, Math.min(T, Math.round(Number(v) || T)))])} />
          <button className="mb-1.5 text-[11px] text-fg-muted hover:text-fg" onClick={() => setRange([0, T])}>{t("scf.fullRange")}</button>
          <div className="mb-1.5 ml-auto">{exportBtn(() => downloadSvg(tracesRef.current, `${props.dataset}_relation_traces.svg`))}</div>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-fg-muted">{tr("scf.tracesHint")}</p>
        {selEdges.length === 0 ? (
          <Note>{t("scf.pickSome")}</Note>
        ) : (
          <RelationTraces ref={tracesRef} series={results} edges={selEdges} range={range} />
        )}
        {nArrows > RELATION_TRACES_MAX_ARROWS && <Note>{t("mc.arrowsCapped", { n: RELATION_TRACES_MAX_ARROWS, total: nArrows })}</Note>}
      </Card>
    </div>
  );
}

function StateTag({ e }: { e: StateEdge["cause"] }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-fg-faint">{dyn(e.entity)}</span>
      {e.metric && <span className="font-medium text-fg">{dyn(e.metric)}</span>}
      <span className="rounded px-1 font-mono text-[10px] font-semibold text-[#262626]" style={{ background: paperStateColor(e.state) }}>{e.state}</span>
    </span>
  );
}

// trigger [∧ condition] → effect
function mechLabel(m: Mech, t: ReturnType<typeof useT>) {
  const effect = m.edges[0].effect;
  const trig = m.edges.filter((e) => e.role === "trigger");
  const cond = m.edges.filter((e) => e.role !== "trigger");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {trig.map((e, i) => (
        <span key={`t${i}`} className="inline-flex items-center gap-1">
          <StateTag e={e.cause} />
          <span className="text-[10px] text-fg-faint">{t(e.atEnd ? "mc.edgeTriggerEnd" : "mc.edgeTrigger", { lag: e.lag === null ? "—" : Math.round(e.lag) })}</span>
        </span>
      ))}
      {cond.map((e, i) => (
        <span key={`c${i}`} className="inline-flex items-center gap-1">
          {(trig.length > 0 || i > 0) && <span className="text-fg-faint">∧</span>}
          <span className="text-[10px] text-fg-faint">{e.role === "cond_neg" ? "¬on" : "on"}(</span>
          <StateTag e={e.cause} />
          <span className="text-[10px] text-fg-faint">)</span>
        </span>
      ))}
      <span className="text-fg-faint">→</span>
      <StateTag e={effect} />
    </span>
  );
}
