"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * 截断文字 + 溢出预览 —— 站点统一入口。
 * 渲染一个带截断样式（truncate / line-clamp-N）的文本元素，运行时检测
 * 内容是否真的溢出；只有溢出时才用 Tooltip 包裹，悬浮/聚焦即展示完整
 * 原文气泡（未截断则原样输出，避免多余提示）。
 *
 * 交互：
 * - 悬停/聚焦触发气泡预览，移开即消失；
 * - 气泡打开期间，直接在文字行上滚动滚轮即可阅读气泡内全文（滚轮改道给
 *   气泡滚动容器，指针移入气泡内则由原生滚动接管）；
 * - 文本行可点击（除链接形态）：单击将气泡“固定”，移开鼠标也不消失，
 *   可继续在文字行或气泡内滚动阅读简介等超长文本，再次单击同一行关闭。
 *
 * 说明：
 * - 检测依据 scrollWidth/scrollHeight 与 client 尺寸差，配合 ResizeObserver，
 *   窄屏截断 / 宽屏不截断时会自动切换。
 * - 支持渲染 span / p / div / h2 / h3 及链接 a（Tooltip 通过 asChild 合并
 *   进原元素，不额外包 DOM，不影响原截断与布局）。
 * - 链接形态保持原生点击（跳转），不做固定；固定开关由本组件统一维护，
 *   并拦截 Radix Trigger 的按下/点击即关闭。
 */
type TruncatedTextElement = "span" | "p" | "div" | "h2" | "h3" | "dd" | "a";

interface TruncatedTextProps {
  /** 完整文本（预览气泡展示的也是这段原文） */
  text: string;
  /** 截断样式：单行用 truncate；多行用 line-clamp-N（布局类如 min-w-0 需一并传入） */
  className?: string;
  /** 渲染标签，默认 span */
  as?: TruncatedTextElement;
  /** as="a" 时的跳转地址 */
  href?: string;
  target?: string;
  rel?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** 气泡方向，默认 top（上方空间不足时 Radix 会自动翻转避让） */
  side?: "top" | "bottom" | "left" | "right";
  /** 气泡出现延迟 ms，默认 200（避免快速划过误弹） */
  delay?: number;
}

export default function TruncatedText({
  text,
  className,
  as = "span",
  href,
  target,
  rel,
  onClick,
  side = "top",
  delay = 200,
}: TruncatedTextProps) {
  const elRef = useRef<HTMLElement | null>(null);
  // 气泡内可滚动文本容器（只在该容器被指针命中时，其原生滚动才是目标）
  const scrollRef = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 气泡是否被点击固定：固定后气泡不随鼠标移开而消失，便于阅读/滚动超长文本；
  // 再次点击同一行关闭。pinnedRef 同步镜像，供 Radix 回调同步读取最新值。
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  // 由 Radix 悬停自动开合驱动（onOpenChange(true/false) 镜像到此处）
  const [hovering, setHovering] = useState(false);
  const hoveringRef = useRef(false);

  const setRef = useCallback((node: HTMLElement | null) => {
    elRef.current = node;
  }, []);

  // 文本或尺寸变化后重新测量：truncate 横向溢出、line-clamp 纵向溢出，
  // 任一溢出即视为截断（+1px 容差避免取整误差误报）。
  // 注意：
  // - 用 useEffect 而非 useLayoutEffect：挂载初期（StrictMode 双挂载 / 字体布局未稳定）
  //   直接读取可能拿到无尺寸的旧节点，改为首帧后再测。
  // - measure 内始终读取 elRef.current，避免闭包引用已卸载节点导致永远测到 0。
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const el = elRef.current;
      if (!el) return;
      setTruncated(
        el.scrollWidth > el.clientWidth + 1 ||
          el.scrollHeight > el.clientHeight + 1
      );
    };
    const raf = requestAnimationFrame(() => {
      const el = elRef.current;
      if (!el) return;
      ro = new ResizeObserver(measure);
      ro.observe(el);
      measure();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [text]);

  // 不再截断（内容变短/容器变宽）时清掉固定与悬停态，避免下次再截断时旧状态残留、
  // 气泡莫名自动弹出
  useEffect(() => {
    if (!truncated) {
      pinnedRef.current = false;
      hoveringRef.current = false;
      setPinned(false);
      setHovering(false);
    }
  }, [truncated, as]);

  // 气泡被固定时，若所在滚动容器发生滚动（行文本即将移出视口），自动解除固定，
  // 防止气泡“脱锚”悬浮在界面上；气泡内部的滚动（如简介内容过长时滚动其滚动条）
  // 不会命中 trigger，不受影响
  useEffect(() => {
    if (!pinned) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && elRef.current && t.contains(elRef.current)) {
        pinnedRef.current = false;
        hoveringRef.current = false;
        setPinned(false);
        setHovering(false);
      }
    };
    window.addEventListener("scroll", onScroll, { capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [pinned]);

  // 把“在触发文字上滚动滚轮”改道给气泡：阅读超长文本时，用户通常停在文字行上
  // 直接滚动（悬停或点击固定后都一样），此时滚轮默认滚动的是页面/列表，气泡内文本
  // 纹丝不动，看起来就像“滑不到底部”。
  // 实现要点：监听器只在触发元素挂载且确实截断时挂一次（依赖 truncated），不再依赖
  // 气泡是否已挂载 —— 打开瞬间气泡内容往往还没渲染（hasSc=false），若此刻才挂监听
  // 器会永久错过；事件到来时再动态读 pinnedRef/hoveringRef/scrollRef 判断是否接管：
  // 未打开/指针已在气泡内（target 在气泡内）/ 气泡在该方向已滚到头 时自然放行
  // （页面滚动、气泡随之自动收起的原逻辑不受影响）。
  useEffect(() => {
    if (!truncated) return;
    const el = elRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const sc = scrollRef.current;
      if (!sc) return; // 气泡尚未挂载：本次让原生行为处理
      if (!(pinnedRef.current || hoveringRef.current)) return; // 气泡未打开
      const t = e.target;
      if (!(t instanceof Node) || sc.contains(t)) return; // 气泡内部由原生滚动处理
      const max = sc.scrollHeight - sc.clientHeight;
      if (max <= 1) return; // 气泡内无需滚动
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 16; // lines -> px
      else if (e.deltaMode === 2) delta *= window.innerHeight; // pages -> px
      if (delta === 0) return;
      if ((delta > 0 && sc.scrollTop >= max) || (delta < 0 && sc.scrollTop <= 0)) {
        return; // 已到头/到尾，交还页面滚动
      }
      e.preventDefault();
      e.stopPropagation();
      sc.scrollTop = Math.max(0, Math.min(max, sc.scrollTop + delta));
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [truncated]);

  const cls = cn(className);
  let base: React.ReactNode;
  if (as === "a") {
    base = (
      <a ref={setRef} className={cls} href={href} target={target} rel={rel} onClick={onClick}>
        {text}
      </a>
    );
  } else if (as === "p") {
    base = (
      <p ref={setRef} className={cls} onClick={onClick}>
        {text}
      </p>
    );
  } else if (as === "h2") {
    base = (
      <h2 ref={setRef} className={cls} onClick={onClick}>
        {text}
      </h2>
    );
  } else if (as === "h3") {
    base = (
      <h3 ref={setRef} className={cls} onClick={onClick}>
        {text}
      </h3>
    );
  } else if (as === "div") {
    base = (
      <div ref={setRef} className={cls} onClick={onClick}>
        {text}
      </div>
    );
  } else if (as === "dd") {
    base = (
      <dd ref={setRef} className={cls} onClick={onClick}>
        {text}
      </dd>
    );
  } else {
    base = (
      <span ref={setRef} className={cls} onClick={onClick}>
        {text}
      </span>
    );
  }

  // 未截断（或暂无法测量）时无需提示
  if (!truncated) return base;

  // 链接（as="a"）保留原生行为：点击仍照常跳转，不接管为“固定”。
  // 其余形态支持“单击固定气泡”：点击后气泡不随鼠标移开消失，可在气泡内滚动
  // 阅读频道简介等超长文本；再次点击同一行关闭。实现上拦截 Radix Trigger 的
  // “按下即关闭/点击即关闭”（preventDefault 使其跳过后续 handler），开关交给
  // 下方统一维护的 pinned 状态。
  const baseEl = base as React.ReactElement<{
    onClick?: React.MouseEventHandler<HTMLElement>;
    onPointerDown?: React.PointerEventHandler<HTMLElement>;
  }>;
  const trigger = as !== "a" ? (
    React.cloneElement(baseEl, {
      // 仅拦截鼠标主键：阻止 Radix 在 pointerdown 即关闭，避免“悬停中点击固定”
      // 的瞬间气泡闪断；触摸交由 click 处理（防止吞掉 tap），右键保留原生菜单。
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse" && e.button === 0) e.preventDefault();
      },
      onClick: (e: React.MouseEvent<HTMLElement>) => {
        baseEl.props.onClick?.(e); // 保留调用方原有点击行为
        if (e.defaultPrevented) return; // 调用方已接管本次点击
        e.preventDefault(); // 阻止 Radix Trigger 在 click 时自动关闭
        const next = !pinnedRef.current;
        pinnedRef.current = next;
        setPinned(next);
        if (!next) {
          // 取消固定时连当前悬停态一并收起
          hoveringRef.current = false;
          setHovering(false);
        }
      },
    })
  ) : (
    base
  );

  return (
    <TooltipProvider delayDuration={delay}>
      <Tooltip
        open={pinned || hovering}
        onOpenChange={(next) => {
          if (next) {
            hoveringRef.current = true;
            setHovering(true);
          } else if (!pinnedRef.current) {
            // pinned 期间忽略 Radix 的关闭请求：气泡保持固定，直到再次点击该行
            hoveringRef.current = false;
            setHovering(false);
          }
        }}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side}>
          {/* 高度上限：min(45vh, 当前方向可用高度)。
              写死 45vh 时，若触发器贴近视口上/下缘，Radix 翻转后气泡仍可能超出可用空间，
              被挤出视口的那段内容（尤其底部）永远滚不到；改用 Radix 暴露的可用高度变量后，
              气泡保证完整落在视口内，能一路滚到底。overscroll-contain 防止在滚动区两端
              继续滚动时联动滚动背后的页面（也会连带触发 Radix 的关闭）。 */}
          <span
            ref={scrollRef}
            className="block max-w-full overflow-y-auto whitespace-pre-wrap break-words overscroll-contain"
            style={{
              maxHeight: "min(45vh, calc(var(--radix-tooltip-content-available-height, 100vh) - 16px))",
            }}>
            {text}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
