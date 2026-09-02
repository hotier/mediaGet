"use client";

import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * 主题切换按钮：在 <html> 上挂载 .dark / .light class，
 * 偏好持久化到 localStorage("theme")，无偏好时跟随系统。
 * 纯图标按钮，悬停提示统一走 Tooltip 气泡（替代原生 title）。
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    const cls = document.documentElement.classList;
    cls.remove("dark", "light");
    cls.add(next ? "dark" : "light");
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // 隐私模式等场景写入失败时静默降级
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggle}
            aria-label={dark ? "切换到浅色模式" : "切换到深色模式"}
            className="grid h-8 w-8 place-items-center rounded-lg text-secondary transition-all duration-200 hover:bg-glass-2 hover:text-primary">
            {dark ? (
              /* 太阳（当前深色，点击切浅色） */
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
            ) : (
              /* 月亮（当前浅色，点击切深色） */
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
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {dark ? "切换到浅色模式" : "切换到深色模式"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
