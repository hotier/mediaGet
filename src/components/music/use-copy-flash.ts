import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 写入剪贴板并返回是否成功。
 * MusicExplorer 复制直链 / 详情弹窗复制歌曲信息共用同一实现。
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyFlash {
  /** 是否处于“已复制”临时高亮（copy 成功后置 true，resetMs 后复位） */
  copied: boolean;
  /** 手动触发一次高亮；重复调用会重置倒计时 */
  flash: () => void;
  /** 外部主动复位（如切歌时清除旧的复制态） */
  setCopied: (v: boolean) => void;
}

/**
 * 复制反馈的“闪一下然后自动复位”状态机：
 * copy 成功后置 copied=true，经过 resetMs 自动回到 false，
 * 期间重复复制会重置计时；组件卸载时清理定时器。
 * 原先在 MusicExplorer / TrackInfoDialog 各自手写 setState + ref 计时器，
 * 收敛到这里保证两处行为一致。
 */
export function useCopyFlash(resetMs = 2000): CopyFlash {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const flash = useCallback(() => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), resetMs);
  }, [resetMs]);

  return { copied, flash, setCopied };
}
