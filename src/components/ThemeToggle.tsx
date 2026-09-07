"use client";

import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** 主题模式：浅色 / 深色 / 跟随设备 */
type ThemeMode = "light" | "dark" | "system";

const MODE_LABEL: Record<ThemeMode, string> = {
  light: "浅色主题",
  dark: "深色主题",
  system: "跟随设备",
};

/** 点击循环顺序：跟随设备 → 深色 → 浅色 → 跟随设备（默认档位通常点一次即切深色） */
const NEXT: Record<ThemeMode, ThemeMode> = {
  system: "dark",
  dark: "light",
  light: "system",
};

const isDarkBySystem = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** 应用指定模式：切换 <html> class 并持久化到 localStorage */
function applyMode(mode: ThemeMode) {
  const dark = mode === "dark" || (mode === "system" && isDarkBySystem());
  const el = document.documentElement;
  el.classList.remove("dark", "light");
  el.classList.add(dark ? "dark" : "light");
  try {
    localStorage.setItem("theme", mode);
  } catch {
    // 隐私模式等场景写入失败时静默降级
  }
}

/** 读取当前存储的模式；无存储或非法值时默认跟随设备 */
function readStoredMode(): ThemeMode {
  try {
    const t = localStorage.getItem("theme");
    if (t === "light" || t === "dark" || t === "system") return t;
  } catch {
    // 忽略
  }
  return "system";
}

function ModeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") {
    /* 太阳：浅色 */
    return (
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.8}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
        />
      </svg>
    );
  }
  if (mode === "dark") {
    /* 月亮：深色 */
    return (
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.8}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
        />
      </svg>
    );
  }
  /* 显示器：跟随设备 */
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={1.8}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8m-4-4v4" />
    </svg>
  );
}

/**
 * 主题切换按钮（点击在三种模式间循环）：
 * 浅色 → 深色 → 跟随设备（默认）。
 * 在 <html> 上挂载 .dark / .light class，偏好持久化到
 * localStorage("theme")，取值 light | dark | system。
 * 图标即当前模式，悬停提示统一走 Tooltip。
 */
export default function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");

  useEffect(() => {
    setMode(readStoredMode());
  }, []);

  const toggle = () => {
    const next = NEXT[mode];
    setMode(next);
    applyMode(next);
  };

  const nextLabel = MODE_LABEL[NEXT[mode]];

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggle}
            aria-label={`切换为${nextLabel}`}
            className="grid h-8 w-8 place-items-center rounded-lg text-secondary transition-all duration-200 hover:bg-glass-2 hover:text-primary">
            <ModeIcon mode={mode} />
          </button>
        </TooltipTrigger>
        <TooltipContent>切换为{nextLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
