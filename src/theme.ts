// One colour per global state id, used by every ribbon and graph. This is what makes
// alignment visible. Saturation is held back so the colours stay distinguishable on white.
export const STATE_COLORS = [
  "#3b6fe0", // blue
  "#2ca35a", // green
  "#e08a1e", // orange
  "#d6453c", // red
  "#9a52d6", // purple
  "#2f9ec4", // cyan
  "#c9a513", // yellow
  "#9c7b54", // brown
  "#7a818c", // gray
  "#d65a86", // pink
];

export function stateColor(state: number): string {
  return STATE_COLORS[state % STATE_COLORS.length];
}

// Heatmap ramp: white (0) to the accent indigo (1), sharing the design token hue so every
// correlation matrix speaks the same colour language.
// accent ≈ oklch(0.55 0.13 265) ≈ rgb(83,99,201)。
export function heatColor(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  const r = Math.round(255 - t * (255 - 83));
  const g = Math.round(255 - t * (255 - 99));
  const b = Math.round(255 - t * (255 - 201));
  return `rgb(${r},${g},${b})`;
}

// Threshold at which heatmap text flips to white.
export function heatText(v: number): string {
  return v > 0.5 ? "#ffffff" : "#2a2f3a";
}
