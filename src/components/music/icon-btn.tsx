import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface IconButtonProps {
  /** 鼠标悬停提示（title）；未传 ariaLabel 时其语义与原按钮一致 */
  title?: string;
  ariaLabel?: string;
  /** 按下 / 激活态 → .on（主题色点亮，如单曲循环、静音） */
  active?: boolean;
  /** aria-pressed（切换类按钮，如静音） */
  ariaPressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** 提供 href 时渲染为 <a>（下载 / 外链类图标按钮） */
  href?: string;
  /** 下载文件名（渲染为 <a> 时生效；纯布尔 true = 同名下载） */
  download?: string | boolean;
  /** 新标签页打开并加 rel=noreferrer（渲染为 <a> 时生效） */
  external?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * 圆形透明图标按钮（.mp-icon-btn）的统一封装。
 * 覆盖两个形态：普通 <button>（复制 / 信息 / 上下曲等）与
 * 带 href 的 <a>（下载直链 / 新标签打开源文件），样式与尺寸差异由外层
 * CSS 作用域处理，调用方只需关注语义属性。
 */
export default function IconButton({
  title,
  ariaLabel,
  active,
  ariaPressed,
  disabled,
  onClick,
  href,
  download,
  external,
  className,
  style,
  children,
}: IconButtonProps) {
  const cls = cn("mp-icon-btn", active && "on", className);

  if (href !== undefined) {
    return (
      <a
        className={cls}
        href={href}
        download={download || undefined}
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer" : undefined}
        aria-label={ariaLabel}
        title={title}
        style={style}>
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cls}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title}
      style={style}>
      {children}
    </button>
  );
}
