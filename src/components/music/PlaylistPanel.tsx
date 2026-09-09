"use client";

import type { RefObject } from "react";
import { AlertCircle, Disc3, Loader2, Play, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  musicLineMeta,
  type DirectData,
  type SearchItem,
} from "@/lib/music-client";
import type { SearchSourceKey } from "@/components/music/types";
import { PlatformIcon } from "@/components/music/platform-icons";
import { sourceMetaFor, type SearchChip } from "./source-meta";
import { EqBars } from "./eq-bars";

export interface PlaylistPanelProps {
  searching: boolean;
  searchedKw: string;
  list: SearchItem[] | null;
  currentIndex: number | null;
  /** 首次取直链的加载中状态（已有 direct 时切音质不清空，避免动效闪烁） */
  fetching: boolean;
  direct: DirectData | null;
  playing: boolean;
  paging: boolean;
  pageErr: string;
  hasMore: boolean;
  source: SearchSourceKey;
  sourceChips: SearchChip[];
  listTopRef: RefObject<HTMLDivElement | null>;
  artistText: (item: SearchItem) => string;
  playTrack: (item: SearchItem, index: number) => void;
  handleListScroll: () => void;
  /** 聚合搜索模式（展示态/空态文案差异化） */
  aggMode?: boolean;
  /** 空结果时的附加说明（聚合搜索失败源等），非空才展示 */
  emptyHint?: string;
}

/**
 * 播放列表结果：加载 / 空态 / 无结果三态提示 + 表头 + 可下拉触底翻页的行列表。
 * 行内展示序号、播放动效、歌手 / 专辑 / 平台 / 线路信息，点击或回车播放。
 */
export default function PlaylistPanel({
  searching,
  searchedKw,
  list,
  currentIndex,
  fetching,
  direct,
  playing,
  paging,
  pageErr,
  hasMore,
  source,
  sourceChips,
  listTopRef,
  artistText,
  playTrack,
  handleListScroll,
  aggMode = false,
  emptyHint = "",
}: PlaylistPanelProps) {
  if (searching) {
    return (
      <div className="mp-scroll">
        <div className="mp-state">
          <Loader2 className="mp-spin" />
          <p>
            {aggMode
              ? `正在聚合搜索多个音源「${searchedKw}」…`
              : `正在搜索「${searchedKw}」…`}
          </p>
        </div>
      </div>
    );
  }
  if (!list) {
    return (
      <div className="mp-scroll">
        <div className="mp-state">
          <Disc3 />
          <p>播放列表还是空的</p>
          <p style={{ fontSize: 12, opacity: 0.75 }}>
            点击左上角「发现歌曲」，搜索歌名 / 歌手，或粘贴歌曲分享链接解析后即可点播
          </p>
        </div>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div className="mp-scroll">
        <div className="mp-state">
          <Search />
          <p>没有找到与「{searchedKw}」相关的歌曲</p>
          <p style={{ fontSize: 12, opacity: 0.75 }}>
            {aggMode
              ? "已搜索全部可用音源均无匹配：换个关键词，或切到单源搜索细查"
              : "换个关键词，或切换音源再试试"}
          </p>
          {emptyHint && (
            <p style={{ marginTop: 8, fontSize: 12.5, color: "var(--error)" }}>
              {emptyHint}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="mp-list-head" aria-hidden="true">
        <div className="mp-colhead">
          <span className="mp-ch mp-ch-idx" />
          <span className="mp-ch mp-ch-title">歌名</span>
          <span className="mp-ch mp-ch-artist">作者</span>
          <span className="mp-ch mp-ch-album">专辑</span>
          <span className="mp-ch mp-ch-src">平台</span>
          <span className="mp-ch mp-ch-line">线路</span>
        </div>
      </div>
      <div
        className="mp-scroll mp-list-scroll"
        ref={listTopRef}
        onScroll={handleListScroll}>
        <div className="mp-list">
        {list.map((item, idx) => {
          const isCurrent = currentIndex === idx;
          // 首次取直链（尚无 direct）才展示行内加载动画；
          // 播放中切音质不清空旧直链，保留 eq 动效避免闪烁
          const loadingThis = fetching && isCurrent && !direct;
          const isPlaying = isCurrent && playing;
          const artist = artistText(item);
          const line = musicLineMeta(item.line);
          const sourceLabel = sourceMetaFor(item.source || source, sourceChips).label;
          return (
            <div
              key={`${item.source}-${item.id}`}
              className={cn("mp-row", isCurrent && "is-active")}
              role="button"
              tabIndex={0}
              aria-label={`播放 ${item.name}`}
              onClick={() => playTrack(item, idx)}
              onKeyDown={(e) => {
                // 仅响应行本体按键，避免行内子控件聚焦时回车误触播放
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  playTrack(item, idx);
                }
              }}>
              <span className="mp-idx">{idx + 1}</span>
              <span className="mp-cell mp-cell-title" title={item.name}>
                <span className="mp-tt">{item.name}</span>
                {isCurrent ? (
                  loadingThis ? (
                    <span className="mp-idx-load">
                      <Loader2 className="mp-spin" />
                    </span>
                  ) : (
                    <EqBars playing={isPlaying} />
                  )
                ) : (
                  <span className="mp-hover-play">
                    <Play />
                  </span>
                )}
              </span>
              <span className="mp-cell mp-cell-artist" title={artist}>
                {artist}
              </span>
              <span className="mp-cell mp-cell-album" title={item.album || ""}>
                {item.album || "—"}
              </span>
              <span
                className="mp-cell mp-cell-src"
                title={sourceLabel}>
                <PlatformIcon source={item.source || source} size={13} />
                {sourceLabel}
              </span>
              <span
                className={cn("mp-cell", "mp-cell-line", line?.direct && "is-direct")}
                title={line?.title}>
                {line ? (
                  <>
                    <i className="mp-line-dot" aria-hidden="true" />
                    <span className="mp-line-text">{line.text}</span>
                  </>
                ) : (
                  <span className="mp-line-none">—</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {(paging || pageErr || !hasMore) && (
        <div className="mp-loadmore" aria-live="polite">
          {paging ? (
            <>
              <Loader2 className="mp-spin" />
              正在加载更多…
            </>
          ) : pageErr ? (
            <span className="mp-load-err">
              <AlertCircle />
              {pageErr}
            </span>
          ) : (
            <span>已显示全部结果</span>
          )}
        </div>
      )}
      </div>
    </>
  );
}
