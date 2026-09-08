"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { BR_GROUP_LABEL, type BrOption } from "@/components/music/types";
import { cn } from "@/lib/utils";

export interface BrPickerProps {
  /** 音质档位（已按码率升序排列） */
  options: BrOption[];
  /** 当前选中档位 value */
  value: string;
  /** 正在重新获取直链时展示加载动画 */
  loading?: boolean;
  /** 无可播放曲目时禁用 */
  disabled?: boolean;
  onSelect: (value: string) => void;
}

/**
 * 音质切换器（自定义下拉弹层，替代原生 <select>）。
 * - 按标准 / 无损分组展示，推荐档带徽标，当前档打勾
 * - 点击外部 / Esc 收起
 */
export function BrPicker({
  options,
  value,
  loading = false,
  disabled = false,
  onSelect,
}: BrPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === String(value));

  // 点击外部 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (o: BrOption) => {
    setOpen(false);
    if (o.value === String(value)) return;
    onSelect(o.value);
  };

  // 保持 options 顺序，仅在分组切换处分组
  const groups: { group: BrOption["group"]; items: BrOption[] }[] = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last && last.group === o.group) last.items.push(o);
    else groups.push({ group: o.group, items: [o] });
  }

  return (
    <div
      ref={rootRef}
      className={cn("mp-brp", open && "is-open", disabled && "is-disabled")}>
      <button
        type="button"
        className="mp-brp-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          disabled
            ? "选择歌曲后可切换音质"
            : current
              ? `当前音质：${current.label}，点击切换`
              : "切换音质"
        }>
        <span className="mp-brp-label">{current ? current.label : "音质"}</span>
        {loading ? (
          <Loader2 className="mp-spin" aria-label="切换音质中" />
        ) : (
          <ChevronDown className="mp-brp-caret" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="mp-brp-pop" role="listbox" aria-label="切换音质">
          {groups.map((g) => (
            <div key={g.group} className="mp-brp-group">
              <div className="mp-brp-glabel">{BR_GROUP_LABEL[g.group]}</div>
              {g.items.map((o) => {
                const active = o.value === String(value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={cn("mp-brp-item", active && "is-active")}
                    onClick={() => pick(o)}>
                    <span className="mp-brp-item-main">
                      <span>{o.label}</span>
                      {o.recommended && <em className="mp-brp-rec">推荐</em>}
                    </span>
                    {active && (
                      <Check aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
