import type { Stage } from "../types";
import { cn } from "../lib/cn";
import { Btn, StatusDot, STATUS_KEY, type StepStatus } from "./ui";
import { useT } from "../i18n";

export interface StageNavItem {
  stage: Stage;
  label: string;
  status: StepStatus;
}

const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ"];

// Stage navigation: the six stages with status dots, session info and global actions.
export function Sidebar(props: {
  items: StageNavItem[];
  active: Stage;
  onSelect: (s: Stage) => void;
  sessionId?: string;
  busy: boolean;
  onNewSession: () => void;
  onRunAll: () => void;
  canRunAll: boolean;
  onOpenKnowledge: () => void;
}) {
  const t = useT();
  const doneCount = props.items.filter((it) => it.status === "done").length;
  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-r border-border bg-sidebar">
      {/* 40px shelf, left clear for the traffic lights */}
      <div className="h-10 shrink-0" />

      <div className="px-4 pb-3">
        <div className="text-sm font-semibold tracking-tight text-fg">StateScope</div>
        <div className="mt-0.5 text-[11px] leading-snug text-fg-faint">
          {t("sidebar.subtitle")}
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        {props.items.map((it, i) => {
          const active = props.active === it.stage;
          const locked = it.status === "locked";
          return (
            <button
              key={it.stage}
              onClick={() => props.onSelect(it.stage)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors",
                active ? "bg-app-bg text-fg" : "text-fg-muted hover:bg-fg/[0.03] hover:text-fg",
                locked && !active && "opacity-55",
              )}
            >
              <span
                className={cn(
                  "w-3 shrink-0 font-mono text-[10px] tabular-nums",
                  active ? "text-fg-muted" : "text-fg-faint",
                )}
              >
                {ROMAN[i] ?? i + 1}
              </span>
              <span className={cn("flex-1 text-sm", active && "font-medium")}>{it.label}</span>
              <StatusDot status={it.status} />
            </button>
          );
        })}
      </nav>

      <div className="mt-auto">
        {/* Global knowledge entry point and the per-stage progress bar */}
        <div className="flex flex-col gap-1.5 px-3 pb-2.5">
          <button
            onClick={props.onOpenKnowledge}
            title={t("sidebar.knowledgeHint")}
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-panel px-2 text-xs font-medium text-fg transition-colors hover:bg-app-bg"
          >
            <span>🧠</span>
            <span>{t("sidebar.knowledge")}</span>
            <span className="font-mono text-[10px] text-fg-faint">{doneCount}/{props.items.length}</span>
          </button>
          <div className="flex gap-1 rounded-full bg-fg/[0.06] p-px" aria-label={t("sidebar.progressLabel")}>
            {props.items.map((it) => (
              <div
                key={it.stage}
                title={`${it.label} · ${t(STATUS_KEY[it.status])}`}
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  it.status === "done" ? "bg-sig-done"
                    : it.status === "running" ? "bg-sig-run"
                      : "bg-fg/25", // incomplete: a visible grey track
                )}
              />
            ))}
          </div>
        </div>

        {/* Session info and global actions */}
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {props.sessionId && (
            <div className="truncate font-mono text-[10px] text-fg-faint" title={props.sessionId}>
              session · {props.sessionId.slice(0, 8)}
            </div>
          )}
          <div className="flex gap-2">
            <Btn variant="outline" className="h-8 flex-1 px-2 text-xs" onClick={props.onNewSession} disabled={props.busy}>
              {t("sidebar.newSession")}
            </Btn>
            <Btn className="h-8 flex-1 px-2 text-xs" onClick={props.onRunAll} disabled={!props.canRunAll || props.busy}>
              {props.busy ? t("common.running") : t("sidebar.runAll")}
            </Btn>
          </div>
        </div>
      </div>
    </aside>
  );
}
