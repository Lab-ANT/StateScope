import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { SettingsDock } from "../SettingsDock";

// Window shell without its own title bar: a dot-grid desktop wall behind a rounded, floating
// window with decorative traffic lights. Any column touching the top of the window should
// leave a 40px shelf so the lights stay clear.
export function MacWindow({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-h-screen w-full items-center justify-center",
        "bg-desktop-bg bg-dot-grid p-5",
      )}
    >
      <div
        className={cn(
          "relative flex h-[min(900px,94vh)] w-[min(1600px,96vw)] flex-col overflow-hidden",
          "rounded-xl bg-win-bg ring-1 ring-black/10",
          "shadow-[0_24px_60px_-18px_rgba(0,0,0,0.25)]",
        )}
      >
        <TrafficLights />
        {children}
      </div>
      {/* Environment settings: a viewport-level capsule that can be dragged outside */}
      <SettingsDock />
    </div>
  );
}

const DOT = "h-3 w-3 rounded-full border border-black/10";

function TrafficLights() {
  return (
    <div className="pointer-events-none absolute left-4 top-[14px] z-50 flex items-center gap-2">
      <span className={cn(DOT, "bg-[#ff5f57]")} />
      <span className={cn(DOT, "bg-[#febc2e]")} />
      <span className={cn(DOT, "bg-[#28c840]")} />
    </div>
  );
}
