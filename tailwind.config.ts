import type { Config } from "tailwindcss";

// StateScope design tokens: a warm-grey light system. Most pixels are neutral warm grey,
// with a single indigo accent; hierarchy comes from background steps and hairlines rather
// than shadows. Every "black" is a warm grey-black (hue ~70), never pure black.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral backgrounds, five steps from dark to light
        "desktop-bg": "oklch(0.88 0.008 80)", // desktop wall behind the window
        "app-bg": "oklch(0.94 0.005 80)", // page background / selected tab
        sidebar: "oklch(0.965 0.006 80)", // sidebar
        "win-bg": "oklch(0.985 0.004 80)", // main content
        panel: "oklch(1 0 0)", // cards: pure white, so they lift off the page

        // Text, same hue at three lightness steps
        fg: "oklch(0.20 0.015 70)", // primary text, also the primary button fill
        "fg-muted": "oklch(0.42 0.012 70)", // labels and descriptions
        "fg-faint": "oklch(0.60 0.010 70)", // paths, timestamps, metadata
        placeholder: "oklch(0.70 0.008 70)",

        // Borders
        border: "oklch(0.90 0.006 80)",
        "border-soft": "oklch(0.93 0.005 80)", // grouping hairline inside cards

        // Accent: a single restrained indigo
        accent: "oklch(0.55 0.13 265)",
        "accent-soft": "oklch(0.95 0.03 265)",
        "accent-fg": "oklch(0.99 0.005 80)",

        // Semantic signal colours
        "sig-done": "oklch(0.62 0.13 155)", // done
        "sig-run": "oklch(0.72 0.13 75)", // running / needs rerun
        "sig-bad": "oklch(0.62 0.16 25)", // error
      },
      borderRadius: {
        lg: "0.75rem",
        md: "0.375rem",
        sm: "0.25rem",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "Helvetica Neue",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          '"SF Mono"',
          '"JetBrains Mono"',
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
