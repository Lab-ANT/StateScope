import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { useT, type Key } from "../i18n";

// Stage state machine; mirrors App.tsx::statusOf.
export type StepStatus = "locked" | "ready" | "running" | "done" | "stale";

export const STATUS_KEY: Record<StepStatus, Key> = {
  locked: "status.locked",
  ready: "status.ready",
  running: "status.running",
  done: "status.done",
  stale: "status.stale",
};

export function StatusDot({ status, className }: { status: StepStatus; className?: string }) {
  const color =
    status === "done"
      ? "bg-sig-done"
      : status === "running"
        ? "bg-sig-run"
        : status === "ready"
          ? "bg-accent"
          : status === "stale"
            ? "bg-sig-run"
            : "bg-fg-faint/35";
  return (
    <span className={cn("relative inline-flex h-2 w-2 shrink-0", className)}>
      {status === "running" && (
        <span className={cn("stage-pulse-ring absolute inset-0 rounded-full", color)} />
      )}
      <span
        className={cn(
          "relative h-2 w-2 rounded-full",
          color,
          status === "stale" && "ring-2 ring-sig-run/30",
        )}
      />
    </span>
  );
}

export function StatusChip({ status }: { status: StepStatus }) {
  const t = useT();
  const tone =
    status === "done"
      ? "text-sig-done"
      : status === "running"
        ? "text-sig-run"
        : status === "ready"
          ? "text-accent"
          : status === "stale"
            ? "text-sig-run"
            : "text-fg-faint";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      {status === "running" ? (
        <span className="spin h-3 w-3 rounded-full border-2 border-sig-run border-t-transparent" />
      ) : (
        <StatusDot status={status} />
      )}
      <span className={tone}>{t(STATUS_KEY[status])}</span>
    </span>
  );
}

// The accent is reserved for current/selected state, never a button fill.
export function Btn(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "outline" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const v = props.variant ?? "primary";
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium",
        "transition-colors disabled:opacity-45 disabled:cursor-default",
        v === "primary" && "bg-fg text-win-bg hover:bg-fg/90",
        v === "outline" && "border border-border bg-panel text-fg hover:bg-app-bg",
        v === "ghost" && "text-fg-muted hover:bg-fg/[0.05] hover:text-fg px-3",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

export function SegToggle<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-app-bg p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          data-active={props.value === o.value || undefined}
          onClick={() => props.onChange(o.value)}
          className={cn(
            "shrink-0 whitespace-nowrap rounded-[5px] px-3.5 py-1 text-xs font-medium transition-colors",
            props.value === o.value
              ? "bg-panel text-fg shadow-[0_1px_2px_rgb(0_0_0/0.05)]"
              : "text-fg-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field(props: {
  label: string;
  value: number | string;
  onChange: (v: string) => void;
  type?: "number" | "select";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const base =
    "h-8 rounded-sm border border-border bg-win-bg px-2 text-sm text-fg outline-none " +
    "transition-shadow focus-visible:ring-2 focus-visible:ring-fg/20 disabled:opacity-45";
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg-faint">{props.label}</span>
      {props.type === "select" ? (
        <select
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          className={cn(base, "w-[150px]")}
        >
          {props.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          className={cn(base, "w-[90px] font-mono tabular-nums")}
        />
      )}
    </label>
  );
}

export function Card({
  children,
  className,
  title,
  flash,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  flash?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border-soft bg-panel p-4",
        flash && "fill-flash",
        className,
      )}
    >
      {title && (
        <h3 className="mb-2.5 text-sm font-medium text-fg">{title}</h3>
      )}
      {children}
    </div>
  );
}

export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("mt-2 text-xs leading-relaxed text-fg-faint", className)}>{children}</p>
  );
}

export function StagePanel(props: {
  title: string;
  tag: string;
  status: StepStatus;
  desc: ReactNode;
  controls?: ReactNode;
  runLabel?: string;
  onRun?: () => void;
  onNext?: () => void;       // "next stage" link, shown once done
  nextLabel?: string;
  actions?: ReactNode;       // shown next to "Next" when done
  live?: boolean;            // show results while running (progressive display)
  children?: ReactNode;
}) {
  const t = useT();
  const disabled = props.status === "locked" || props.status === "running";
  const showBody = props.status === "done" || props.status === "stale" || (props.status === "running" && !!props.live);
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-faint">
            {props.tag}
          </div>
          <h1 className="mt-1 text-xl font-semibold leading-tight text-fg">{props.title}</h1>
          <p className="mt-1.5 max-w-[880px] text-sm leading-relaxed text-fg-muted">
            {props.desc}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-between self-stretch">
          <StatusChip status={props.status} />
          {props.status === "done" && (props.actions || props.onNext) && (
            <div className="flex items-center gap-2">
              {props.actions}
              {props.onNext && (
                <Btn variant="outline" className="h-8 px-3 text-xs" onClick={props.onNext}>
                  {t("common.next", { label: props.nextLabel ?? "" })}
                </Btn>
              )}
            </div>
          )}
        </div>
      </div>

      {(props.controls || props.onRun) && (
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-soft pt-4">
          {props.controls}
          {props.onRun && (
            <Btn className="ml-auto" onClick={props.onRun} disabled={disabled}>
              {props.status === "running" ? t("common.running") : props.runLabel || t("common.run")}
            </Btn>
          )}
        </div>
      )}

      {showBody && props.children && <div className="mt-5">{props.children}</div>}
    </div>
  );
}
