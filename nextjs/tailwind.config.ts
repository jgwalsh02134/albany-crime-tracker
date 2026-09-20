import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ACT brand palette — mirrors the CSS custom properties in globals.css
        "act-bg": "var(--bg)",
        "act-surface": "var(--surface)",
        "act-border": "var(--border)",
        "act-text": "var(--text-1)",
        "act-text-2": "var(--text-2)",
        "act-text-3": "var(--text-3)",
        "act-accent": "var(--accent)",
        "act-red": "var(--red)",
        "act-orange": "var(--orange)",
        "act-green": "var(--green)",
      },
      fontFamily: {
        sans: ["Satoshi", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
