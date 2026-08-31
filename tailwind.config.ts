import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // class 策略：由 ThemeToggle / 初始化脚本在 <html> 上挂载 .dark / .light
  // 所有主题色通过 CSS 变量切换（见 globals.css），dark: 变体按需可用
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        accent: {
          DEFAULT: "var(--accent)",
          douyin: "var(--accent-douyin)",
          bilibili: "var(--accent-bilibili)",
          kuaishou: "var(--accent-kuaishou)",
          weibo: "var(--accent-weibo)",
          xhs: "var(--accent-xhs)",
        },
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        muted: "var(--text-muted)",
        glass: {
          1: "var(--glass-1)",
          2: "var(--glass-2)",
          3: "var(--glass-3)",
        },
        border: {
          subtle: "var(--border-subtle)",
          medium: "var(--border-medium)",
          strong: "var(--border-strong)",
        },
        /* shadcn/ui 语义色：映射到现有设计令牌，避免引入第二套配色 */
        input: "var(--border-medium)",
        ring: "var(--accent)",
        success: "var(--success)",
        error: "var(--error)",
        destructive: {
          DEFAULT: "var(--error)",
          foreground: "#ffffff",
        },
      },
      boxShadow: {
        card: "var(--shadow-card)",
        glow: "var(--shadow-glow)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      animation: {
        "spin-slow": "spin 3s linear infinite",
        "float": "float 4s ease-in-out infinite",
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      transitionTimingFunctions: {
        "bounce-out": "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "ease-out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic": "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
};

export default config;
