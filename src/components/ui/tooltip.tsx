"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

/**
 * Tooltip（基于 Radix UI）—— 悬浮/聚焦触发器时展示的气泡提示。
 * 统一视觉：黑色填充 + 白色文字 + 指向触发器的尖角箭头。
 * 用法：
 *   <Tooltip>
 *     <TooltipTrigger asChild><span>悬停对象</span></TooltipTrigger>
 *     <TooltipContent>提示内容</TooltipContent>
 *   </Tooltip>
 * asChild 时内容通过 Slot 合并进触发器，不额外包 DOM，不会破坏
 * 原元素的截断/布局；可悬停的截断文字预览见 TruncatedText。
 */
const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, side = "top", sideOffset = 6, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-[min(340px,calc(100vw-2rem))] rounded-lg border border-white/10 bg-black px-3 py-2 text-xs leading-relaxed text-white shadow-card",
        className
      )}
      {...props}>
      {children}
      <TooltipPrimitive.Arrow className="fill-black" />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
