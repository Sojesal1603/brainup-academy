import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        border: "var(--border)",
        surface: "var(--surface)",
        "surface-hover": "var(--surface-hover)",
        brand: {
          50: "#ecfdf5",
          100: "#d1fae5",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
        },
        // Acentos de la capa visual: azul eléctrico, púrpura de IA y esmeralda.
        electric: "#3b82f6",
        ai: "#8b5cf6",
        emeraldAccent: "#10b981",
        // Superficies del modo oscuro espacial.
        ink: {
          900: "#0a0d14",
          800: "#131825",
          700: "#1a2032",
        },
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
        shimmerSweep: {
          from: { transform: "translateX(-150%)" },
          to: { transform: "translateX(450%)" },
        },
      },
      animation: {
        "fade-up": "fadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both",
        shimmer: "shimmerSweep 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
