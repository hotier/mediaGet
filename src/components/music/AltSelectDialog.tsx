"use client";

import { AlertTriangle, Play, X } from "lucide-react";
import type { SearchItem } from "@/lib/music-client";
import type { AltCandidate } from "./use-player-engine";
import { sourceMetaFor, type SearchChip } from "./source-meta";
import { PlatformIcon } from "./platform-icons";

export interface AltSelectDialogProps {
  /** 是否展示（父层由 failStage/autoTrying/alternatives 推导） */
  open: boolean;
  /** 当前（播放失败）曲目，用于面板标题文案；无则不展示占位信息 */
  picked: SearchItem | null;
  /** 同曲其他版本候选：来源 A=当前队列内近似；来源 B=跨源现搜的同名候选 */
  alternatives: readonly AltCandidate[];
  sourceChips: SearchChip[];
  artistText: (item: SearchItem) => string;
  /** 用户选中某一版本：父层负责换算索引并调用 playTrack */
  onPick: (item: SearchItem) => void;
  /** 关闭面板（保留当前曲目不动） */
  onClose: () => void;
}

/** 每个候选行的说明（仅提示作用，与自动换源的 auto 判定保持同源解释） */
function noteOf(c: AltCandidate): string | null {
  if (c.provenance === "multi-search") {
    // 来源 B：跨源现搜回来的同曲版本
    if (!c.auto) {
      return c.albumDiff
        ? "跨源现搜候选：专辑不同，可能为现场 / 翻唱等其他录音，未自动尝试"
        : "跨源现搜候选：同曲置信度不足，未自动尝试";
    }
    return null; // 高置信自动候选本不该出现在面板；万一进入（自动预算已尽）就无注角
  }
  if (!c.auto) {
    return "专辑不同，可能为现场 / 翻唱等其他录音版本";
  }
  return null;
}

/**
 * 播放失败且自动换源无可自动候选时的人工选版面板：
 * 列出同曲其他版本（来源 A：队列内近似；来源 B：跨音源现搜到的同名曲），
 * 由用户挑一版「就播这版」。非高置信候选带注释徽标，仅人工确认。
 */
export default function AltSelectDialog({
  open,
  picked,
  alternatives,
  sourceChips,
  artistText,
  onPick,
  onClose,
}: AltSelectDialogProps) {
  if (!open) return null;
  return (
    <div
      className="mp-alt-mask"
      role="presentation"
      onMouseDown={(e) => {
        // 点击遮罩空白处关闭（卡片自身冒泡被下面 stopPropagation 拦下）
        if (e.target === e.currentTarget) onClose();
      }}>
      <div
        className="mp-alt-card"
        role="dialog"
        aria-modal="true"
        aria-label="选择同曲其他版本"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="mp-alt-head">
          <div className="mp-alt-headtext">
            <div className="mp-alt-caption">
              <AlertTriangle />
              <span>换个版本试试</span>
            </div>
            <div className="mp-alt-reason">
              {picked ? `“${picked.name}”当前版本播放失败` : "当前版本播放失败"}
              ，以下是同曲的其他版本，可直接挑一版播放。
            </div>
          </div>
          <button
            type="button"
            className="mp-alt-close"
            onClick={onClose}
            aria-label="关闭选版面板"
            title="关闭（保留当前曲目）">
            <X />
          </button>
        </div>
        <ul className="mp-alt-list">
          {alternatives.map((c) => {
            const srcKey = c.item.source || "";
            const meta = sourceMetaFor(srcKey, sourceChips);
            const note = noteOf(c);
            return (
              <li key={`${srcKey}-${c.item.id}`}>
                <button
                  type="button"
                  className="mp-alt-item"
                  onClick={() => onPick(c.item)}
                  title={`播放 ${c.item.name}`}>
                  <span className="mp-alt-src">
                    <PlatformIcon source={srcKey} size={13} />
                    {meta.label}
                    {c.provenance === "multi-search" && (
                      <span className="mp-alt-tag">现搜</span>
                    )}
                  </span>
                  <span className="mp-alt-main">
                    <span className="t">{c.item.name}</span>
                    <span className="a">
                      {artistText(c.item)}
                      {c.item.album ? ` · ${c.item.album}` : ""}
                    </span>
                    {note && <span className="mp-alt-note">{note}</span>}
                  </span>
                  <span className="mp-alt-go" aria-hidden="true">
                    <Play fill="currentColor" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mp-alt-foot">
          自动尝试已结束；也可切换到其他歌曲继续。关闭后保留当前曲目。
        </div>
      </div>
    </div>
  );
}
