"use client";

/**
 * AMLL Core BackgroundRender 动态背景实现。
 *
 * 承接原整页歌词「静态 CSS 封面模糊」背景：用 core 导出的
 * BackgroundRender + PixiRenderer 在画布上把同一张封面摆成多份、
 * 各自旋转位移并叠加多级 Blur/色彩/扭曲滤镜，形成 Apple Music 式
 * 「封面流动模糊」动态背景。
 *
 * 关键点：
 * - BackgroundRender.new(PixiRenderer) 会自建 <canvas>（库内部给画布
 *   设了 pointer-events:none / z-index:-1），只需把它放进铺满整页的
 *   宿主即可；分辨率 / 视口尺寸由 BaseRenderer 内置的 ResizeObserver
 *   按 devicePixelRatio × renderScale 自动维护。
 * - 封面走库内 crossOrigin 加载流程，resolve 后才让宿主淡入到目标
 *   不透明度（与底下调色渐变 / 主题底色合成），失败 / 弱动效偏好 /
 *   无封面时宿主保持透明，由静态 CSS 背景兜底。
 * - 画布只做一次创建与销毁；换歌时仅再次 setAlbum，库内部自带旧图
 *   淡出 + 新图淡入，可无缝过渡。
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BackgroundRender, PixiRenderer } from "@applemusic-like-lyrics/core";

export interface AmllBackgroundProps {
  /** 已确认可展示的封面链接（仅在封面可用时挂载本组件） */
  coverUrl: string;
  /** 封面加载完成后画布淡入到位的不透明度（0~1），与背景渐变合成 */
  opacity?: number;
  /** 背景动画目标帧率（移动端可降低以省电） */
  fps?: number;
  /** 渲染分辨率比例：越小越省 GPU，0.5 左右无明显瑕疵 */
  renderScale?: number;
  /** 背景流动速度倍率（越大越快） */
  flowSpeed?: number;
  /** 宿主容器额外类名 */
  className?: string;
}

/** 宿主容器上传递自定义属性的样式类型 */
type BgCssVars = CSSProperties & Record<"--amll-bg-opacity", string>;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export default function AmllBackgroundImpl({
  coverUrl,
  opacity = 0.62,
  fps = 30,
  renderScale = 0.5,
  flowSpeed = 1,
  className,
}: AmllBackgroundProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<BackgroundRender<PixiRenderer> | null>(null);
  /** 封面已在画布内渲染完成后置真，驱动宿主淡入 */
  const [active, setActive] = useState(false);

  // 创建 / 销毁 BackgroundRender：只发生一次。组件是纯客户端模块
  // （经 next/dynamic ssr:false 挂载），此处才可安全访问 DOM。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 用户偏好减弱动态效果时退回静态 CSS 背景，不再开 WebGL 循环
    if (window.matchMedia?.(REDUCED_MOTION_QUERY).matches) return;

    const bg = BackgroundRender.new(PixiRenderer);
    bg.setFPS(fps);
    bg.setRenderScale(renderScale);
    bg.setFlowSpeed(flowSpeed);

    const canvas = bg.getElement();
    // 画布自身尺寸交给 CSS 铺满宿主；库已设 pointer-events:none，
    // 这里仅兜底布局（BackgroundRender 只设置了 z-index/contain）。
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.right = "0";
    canvas.style.bottom = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);
    bgRef.current = bg;

    return () => {
      bg.dispose();
      bgRef.current = null;
      setActive(false);
    };
  }, [fps, renderScale, flowSpeed]);

  // 换歌 / 首次载入：交给库内部淡入淡出过渡，成功后再点亮宿主
  useEffect(() => {
    const bg = bgRef.current;
    if (!bg) return;
    let cancelled = false;
    void bg
      .setAlbum(coverUrl)
      .then(() => {
        if (!cancelled) setActive(true);
      })
      .catch(() => {
        // 封面解码 / CORS 失败：维持透明，静态 CSS 背景继续兜底
      });
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      className={`amll-bg-host${active ? " is-on" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--amll-bg-opacity": String(opacity) } as BgCssVars}>
      {/* 可读性纱幕：盖在画布之上、歌词/控件之下。歌词文字与按钮图标都直接
          叠在动态画布上，而流动画面明暗不定；纱幕由 LyricPage 按调色板的
          「浅字深底 / 深字浅底」分支在宿主上切换成深色或浅色，把画面亮度
          收敛到文字所需的对比区间（见 music.css .mplp-dyn-night/.mplp-dyn-day）。 */}
      <div className="amll-bg-scrim" />
    </div>
  );
}
