import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui 风格 class 合并工具。
 * 用 tailwind-merge 解决 Tailwind 类冲突（后写的覆盖先写的）。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
