import type { Aligned, LeadLagPair, Segment } from "../types";
import { StateRibbon } from "./StateRibbon";
import { Card, Note } from "./ui";
import { useT, tr, dyn } from "../i18n";

// Correlation shift view: take the strongest lagged pair and draw both state ribbons, plus
// the follower shifted left by lag, which should then almost coincide with the leader.

function shiftSegments(segs: Segment[], delta: number, T: number): Segment[] {
  return segs
    .map((s) => ({ ...s, start: Math.max(0, s.start + delta), end: Math.min(T, s.end + delta) }))
    .filter((s) => s.end > s.start);
}

function Row(props: { label: string; segs: Segment[]; T: number; dim?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-1.5" style={props.dim ? { opacity: 0.92 } : undefined}>
      <span className="w-24 shrink-0 truncate text-xs text-fg-muted">{props.label}</span>
      <div className="flex-1"><StateRibbon segments={props.segs} T={props.T} /></div>
    </div>
  );
}

export function LeadLagRibbons(props: { aligned: Aligned; pairs: LeadLagPair[]; T: number }) {
  const t = useT();
  const { aligned, pairs, T } = props;
  const sorted = [...pairs].sort((a, b) => b.nmi - a.nmi);
  const pair = sorted.find((p) => p.lag > 0) ?? sorted[0];
  if (!pair) return null;
  const seqOf = (name: string) => aligned.sequences.find((s) => s.name === name);
  const leader = seqOf(pair.leader);
  const follower = seqOf(pair.follower);
  if (!leader || !follower) return null;
  const shifted = shiftSegments(follower.segments, -pair.lag, T);

  return (
    <Card title={t("leadlag.title")}>
      <Note>
        {tr("leadlag.note", {
          leader: dyn(pair.leader), follower: dyn(pair.follower),
          lag: pair.lag, nmi: pair.nmi.toFixed(3),
        })}
      </Note>
      <div className="mt-2">
        <Row label={dyn(pair.leader)} segs={leader.segments} T={T} />
        <Row label={dyn(pair.follower)} segs={follower.segments} T={T} />
        {pair.lag > 0 && <Row label={`${dyn(pair.follower)} −${pair.lag}`} segs={shifted} T={T} dim />}
      </div>
    </Card>
  );
}
