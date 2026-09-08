"use client";

import {
  MUSIC_VIEWS,
  setMusicView,
  useMusicView,
} from "@/components/music/music-view-store";
import { cn } from "@/lib/utils";

/**
 * 音乐页视图切换器（发现歌曲 / 播放列表）。
 * 渲染在 /music 内容区顶部功能区左上角，与 MusicExplorer 共享外部 store 状态：
 * 用户提交搜索后视图会自动切到「播放列表」，按钮高亮随之联动。
 */
export default function MusicViewSeg() {
  const view = useMusicView();
  return (
    <div
      role="group"
      aria-label="音乐页视图"
      className="flex flex-none items-center gap-0.5 rounded-[10px] bg-black/5 p-[3px] dark:bg-white/10">
      {MUSIC_VIEWS.map((option) => {
        const active = view === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            title={active ? `当前页面：${option.label}` : `切换到${option.label}`}
            onClick={() => setMusicView(option.key)}
            className={cn(
              "whitespace-nowrap rounded-lg px-1.5 py-1 text-[11px] font-medium transition-colors sm:px-2.5 sm:text-xs",
              active
                ? "bg-white text-primary shadow-sm dark:bg-white/20 dark:shadow-none"
                : "text-secondary hover:text-primary"
            )}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
