import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        ink: {
          DEFAULT: "#0e0e10",
          soft: "#1a1a1f",
          muted: "#8b8b96",
        },
        paper: {
          DEFAULT: "#fafaf7",
          soft: "#f3f3ee",
        },
        accent: {
          DEFAULT: "#ff6a00",
        },
      },
    },
  },
  plugins: [],
};

export default config;
