import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        surface: "var(--color-surface)",
        raised: "var(--color-surface-raised)",
        text: "var(--color-text)",
        muted: "var(--color-text-muted)",
        border: "var(--color-border)",
        action: "var(--color-action)",
        focus: "var(--color-focus)",
        positive: "var(--color-positive)",
        negative: "var(--color-negative)",
        warning: "var(--color-warning)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        control: "var(--shadow-control)",
      },
    },
  },
  plugins: [],
};

export default config;
