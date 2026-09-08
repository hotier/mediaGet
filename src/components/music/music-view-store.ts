"use client";

/**
 * 音乐页「发现歌曲 / 播放列表」视图状态（跨全局顶栏与 /music 主体共享）。
 *
 * 播放列表 / 发现歌曲选择器被移入全局顶部导航栏后，顶栏按钮与页面主体
 * 必须读写同一份状态：本模块用最简外部 store + useSyncExternalStore 实现，
 * 不引入 Context / 状态库，供 SiteHeader 与 MusicExplorer 两端订阅。
 */
import { useSyncExternalStore } from "react";

export type MusicView = "search" | "playlist";

export interface MusicViewOption {
  key: MusicView;
  label: string;
}

/** 顺序即顶栏分段按钮的展示顺序：发现歌曲（落地页）在前，播放列表在后 */
export const MUSIC_VIEWS: MusicViewOption[] = [
  { key: "search", label: "发现歌曲" },
  { key: "playlist", label: "播放列表" },
];

const DEFAULT_VIEW: MusicView = "search";

let current: MusicView = DEFAULT_VIEW;
const listeners = new Set<() => void>();

export function getMusicView(): MusicView {
  return current;
}

export function setMusicView(view: MusicView): void {
  if (view === current) return;
  current = view;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读取当前音乐页视图并订阅后续变化（SSR 时返回默认值，避免水合不一致） */
export function useMusicView(): MusicView {
  return useSyncExternalStore(subscribe, getMusicView, getMusicView);
}
