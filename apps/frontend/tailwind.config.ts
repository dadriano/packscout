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
        canvas: "var(--canvas)",
        ink: "var(--ink)",
        pine: "var(--pine)",
        moss: "var(--moss)",
        trail: "var(--trail)",
        paper: "var(--paper)",
        line: "var(--line)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        field: "0 22px 70px rgba(31, 48, 39, 0.14)",
      },
    },
  },
  plugins: [],
};

export default config;
