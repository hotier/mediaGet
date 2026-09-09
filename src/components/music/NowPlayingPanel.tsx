"use client";

import {
  AlertCircle,
  Check,
  Copy,
  Disc3,
  Download,
  Info,
  Loader2,
  Maximize2,
} from "lucide-react";
import {
  BR_LABEL,
  formatSize,
  type SearchSourceKey,
} from "@/components/music/types";
import {
  trackDownloadSpec,
  type DirectData,
  type SearchItem,
} from "@/lib/music-client";
import { PlatformIcon } from "@/components/music/platform-icons";
import { sourceMetaFor, type SearchChip } from "./source-meta";
import IconButton from "./icon-btn";
import { EqBars } from "./eq-bars";

export interface NowPlayingPanelProps {
  picked: SearchItem | null;
  playing: boolean;
  coverLoading: boolean;
  coverUrl: string | null;
  coverFailed: boolean;
  direct: DirectData | null;
  br: string;
  source: SearchSourceKey;
  sourceChips: SearchChip[];
  playError: string;
  copied: boolean;
  currentIndex: number | null;
  artistText: (item: SearchItem) => string;
  /** 点击封面展开整页歌词 */
  onOpenLyric: () => void;
  onCoverError: () => void;
  copyUrl: () => void;
  onShowInfo: (item: SearchItem, index: number) => void;
}

/**
 * 右侧「正在播放」卡片：大封面（点击开整页歌词）+ 曲目信息 + 直链状态
 * + 复制 / 下载 / 详情按钮组。
 */
export default function NowPlayingPanel({
  picked,
  playing,
  coverLoading,
  coverUrl,
  coverFailed,
  direct,
  br,
  source,
  sourceChips,
  playError,
  copied,
  currentIndex,
  artistText,
  onOpenLyric,
  onCoverError,
  copyUrl,
  onShowInfo,
}: NowPlayingPanelProps) {
  /** 下载入口决策（源通道引擎统一入口，见 music-client trackDownloadSpec） */
  const download = direct
    ? trackDownloadSpec({ item: picked, source, direct, br })
    : null;

  const renderCover = () => (
    <div className="mp-artbox">
      <button
        type="button"
        className="mp-artframe mp-artbtn"
        onClick={picked ? onOpenLyric : undefined}
        disabled={!picked}
        aria-label={picked ? "打开整页歌词" : undefined}
        title={picked ? "打开整页歌词" : undefined}>
        {coverLoading ? (
          <div className="mp-art-load">
            <Loader2 />
          </div>
        ) : coverUrl && !coverFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt={picked ? picked.name : "专辑封面"}
            onError={onCoverError}
          />
        ) : (
          <div className="mp-artph">
            <Disc3 />
            <span>{coverFailed ? "封面加载失败" : picked ? "暂无封面" : ""}</span>
          </div>
        )}
        {picked && (
          <span className="mp-art-hint">
            <Maximize2 />
            查看歌词
          </span>
        )}
      </button>
    </div>
  );

  return (
    <aside className="mp-now">
      <div className="mp-now-flag">
        {picked ? (
          <>
            <EqBars playing={playing} style={{ height: 11 }} />
            {playing ? "正在播放" : "当前曲目"}
          </>
        ) : (
          "播放器"
        )}
      </div>
      {renderCover()}
      <div className="mp-track-meta">
        <div className="t">{picked ? picked.name : "未在播放"}</div>
        <div className="a">
          {picked
            ? `${artistText(picked)}${picked.album ? ` · ${picked.album}` : ""}`
            : "从左侧列表选择一首歌开始播放"}
        </div>
        {picked && direct && (
          <div className="mp-meta-line">
            <span className="mp-pill good">
              {BR_LABEL[String(direct.br)] ?? `${direct.br}kbps`}
            </span>
            {direct.size && <span className="mp-pill">{formatSize(direct.size)}</span>}
            <span className="mp-pill">
              <PlatformIcon source={picked.source || source} size={12} />
              {sourceMetaFor(picked.source || source, sourceChips).label}
            </span>
          </div>
        )}
      </div>
      {playError && (
        <div className="mp-play-err" role="alert">
          <AlertCircle />
          <span>{playError}</span>
        </div>
      )}
      <div className="mp-actrow">
        <IconButton title="复制直链" disabled={!direct} onClick={copyUrl}>
          {copied ? <Check /> : <Copy />}
        </IconButton>
        {download ? (
          download.kind === "bin" ? (
            // GD 源 + 同源代理可用：经同源 bin 字节代理下载（带音质标签文件名）
            <IconButton
              href={download.url}
              download
              title="下载歌曲"
              ariaLabel="下载歌曲">
              <Download />
            </IconButton>
          ) : (
            // 真实源地址即文件：lx 扩展源 / GD 直连模式 → 新标签打开源文件后另存
            <IconButton
              href={download.url}
              external
              title={
                download.fallbackDirect
                  ? "下载歌曲（直连：新标签页打开源文件后另存）"
                  : "下载歌曲（打开源文件后另存）"
              }
              ariaLabel="下载歌曲">
              <Download />
            </IconButton>
          )
        ) : (
          <IconButton disabled title="下载歌曲">
            <Download />
          </IconButton>
        )}
        {direct && picked && currentIndex != null && (
          <IconButton
            title="歌曲信息"
            ariaLabel="查看当前歌曲的详细信息"
            onClick={() => onShowInfo(picked, currentIndex)}>
            <Info />
          </IconButton>
        )}
      </div>
    </aside>
  );
}
