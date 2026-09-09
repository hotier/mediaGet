"use client";

import type { ReactNode } from "react";
import { Check, Copy, Download, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BR_GROUP_LABEL,
  BR_OPTIONS,
  formatSize,
  formatTime,
  type SearchSourceKey,
} from "@/components/music/types";
import {
  type DirectData,
  type SearchItem,
} from "@/lib/music-client";
import { PlatformIcon } from "@/components/music/platform-icons";
import { sourceMetaFor, type SearchChip } from "./source-meta";
import type { LyricLine } from "./lyric-utils";
import { useCopyFlash, writeClipboard } from "./use-copy-flash";

export interface InfoTrack {
  item: SearchItem;
  index: number;
}

export interface TrackInfoDialogProps {
  infoTrack: InfoTrack | null;
  /** 正在播放的曲目（用于判定“当前歌曲”态，未播放时字段走占位） */
  picked: SearchItem | null;
  currentIndex: number | null;
  source: SearchSourceKey;
  sourceChips: SearchChip[];
  direct: DirectData | null;
  duration: number;
  fetching: boolean;
  copied: boolean;
  lyricsLoading: boolean;
  lyricRaw: string | null;
  lyricError: string | null;
  lyricLines: LyricLine[] | null;
  lyricBlobUrl: string | null;
  coverLoading: boolean;
  coverUrl: string | null;
  coverFailed: boolean;
  artistText: (item: SearchItem) => string;
  copyUrl: () => void;
  showToast: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

/**
 * 歌曲详情弹窗：行内「详情」按钮触发，展示歌名 / 歌手 / 专辑 / 时长、
 * 音质 / 文件大小与歌词、封面、直链等运行时信息（播放当前歌曲前多为占位）。
 */
export default function TrackInfoDialog({
  infoTrack,
  picked,
  currentIndex,
  source,
  sourceChips,
  direct,
  duration,
  fetching,
  copied,
  lyricsLoading,
  lyricRaw,
  lyricError,
  lyricLines,
  lyricBlobUrl,
  coverLoading,
  coverUrl,
  coverFailed,
  artistText,
  copyUrl,
  showToast,
  onClose,
}: TrackInfoDialogProps) {
  // 「复制歌曲信息」成功态的 2s 临时高亮（弹窗卸载时自动清理定时器）
  const { copied: infoCopied, flash: flashInfoCopied } = useCopyFlash();

  if (!infoTrack) return null;
  const { item, index } = infoTrack;
  const isCurrent = currentIndex === index && picked?.id === item.id;
  const artist = artistText(item);

  /** 选择并播放后才能拿到的字段，统一占位提示 */
  const pending = (
    <span
      className="mp-info-pending"
      title="选中这首歌曲并播放后，即可获取对应数据">
      播放后获取
    </span>
  );

  /** 播放音质文案：与音质选择器/下载文件命名同源（标准=码率，无损=位深） */
  const qualityText = (br: number) => {
    const opt = BR_OPTIONS.find((o) => o.value === String(br));
    if (!opt) return `${br}kbps`;
    const { group, label } = opt;
    return group === "lossless"
      ? `${BR_GROUP_LABEL.lossless} · ${label.replace("无损 ", "")}`
      : `${BR_GROUP_LABEL.standard} · ${label}`;
  };

  const live = isCurrent && !!direct && !!direct.url;
  const durationText = isCurrent && duration > 0 ? formatTime(duration) : null;
  const sizeText = live && direct?.size ? formatSize(direct.size) : null;
  const brValue = live && direct ? direct.br : null;

  // —— 播放音质
  let qualityNode: ReactNode = pending;
  if (isCurrent) {
    if (fetching && !direct) {
      qualityNode = (
        <span className="mp-info-loading">
          <Loader2 className="mp-spin" />
          解析音质中…
        </span>
      );
    } else if (brValue) {
      qualityNode = <span className="mp-info-strong">{qualityText(brValue)}</span>;
    }
  }

  // —— 歌词链接：歌词抓取就绪后展示得到的 LRC 文件，整行超链接点击即可下载
  const lyricSongId = item.lyricId || (isCurrent ? item.id : "");
  const lyricUrl = lyricSongId
    ? (() => {
        switch (item.source || source) {
          case "netease":
            return `https://music.163.com/song?id=${lyricSongId}`;
          case "tencent":
            return `https://y.qq.com/n/ryqq/songDetail/${lyricSongId}`;
          case "kuwo":
            return `https://www.kuwo.cn/play_detail/${lyricSongId}`;
          case "kugou":
            return `https://www.kugou.com/song/#hash=${lyricSongId}`;
          case "joox":
            return `https://www.joox.com/single/${lyricSongId}`;
          default:
            return "";
        }
      })()
    : "";
  /** 用合法文件名形式拼出「歌手 - 歌名.lrc」 */
  const safeName = (s: string) =>
    s
      .replace(/[\\/:*?"<>|\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const lrcFileName = `${safeName(artist)} - ${safeName(item.name)}.lrc`;
  let lyricNode: ReactNode = pending;
  if (!lyricSongId) {
    lyricNode = <span className="mp-info-dim">无歌词资源</span>;
  } else if (isCurrent) {
    if (lyricsLoading) {
      lyricNode = (
        <span className="mp-info-loading">
          <Loader2 className="mp-spin" />
          解析歌词中…
        </span>
      );
    } else if (lyricRaw) {
      lyricNode = lyricBlobUrl ? (
        <a
          className="mp-info-link mp-info-lrc"
          href={lyricBlobUrl}
          download={lrcFileName}
          title={`点击下载歌词文件 ${lrcFileName}`}>
          <Download size={13} />
          {lrcFileName}
        </a>
      ) : (
        <span className="mp-info-strong">
          已就绪 · {lyricLines?.length ?? 0} 行歌词
        </span>
      );
    } else if (lyricError) {
      lyricNode = <span className="mp-info-dim">歌词获取失败</span>;
    } else {
      lyricNode = <span className="mp-info-dim">暂无歌词</span>;
    }
  }

  // —— 封面链接：当前歌曲封面就绪后可新标签打开大图
  let coverNode: ReactNode = pending;
  if (isCurrent) {
    if (coverLoading) {
      coverNode = (
        <span className="mp-info-loading">
          <Loader2 className="mp-spin" />
          封面加载中…
        </span>
      );
    } else if (coverUrl && !coverFailed) {
      coverNode = (
        <a
          className="mp-info-link"
          href={coverUrl}
          target="_blank"
          rel="noreferrer">
          查看封面图片
        </a>
      );
    } else {
      coverNode = (
        <span className="mp-info-dim">{coverFailed ? "封面加载失败" : "暂无封面"}</span>
      );
    }
  }

  // —— 歌曲链接：直链就绪后可复制 / 新标签打开
  let songNode: ReactNode = pending;
  if (live) {
    songNode = (
      <span className="mp-info-songrow">
        <a
          className="mp-info-url"
          href={direct.url}
          target="_blank"
          rel="noreferrer"
          title={direct.url}>
          {direct.url}
        </a>
        <button
          type="button"
          className="mp-info-copy"
          onClick={copyUrl}
          aria-label="复制歌曲直链"
          title="复制歌曲直链">
          {copied ? <Check /> : <Copy />}
        </button>
      </span>
    );
  }

  const fieldRows: { label: string; value: ReactNode }[] = [
    {
      label: "歌名",
      value: <span className="mp-info-strong">{item.name}</span>,
    },
    { label: "歌手", value: artist },
    { label: "专辑", value: item.album || "未知专辑" },
    { label: "时长", value: durationText ?? pending },
    {
      label: "来源",
      value: (
        <span className="mp-pill">
          <PlatformIcon source={item.source || source} size={13} />
          {sourceMetaFor(item.source || source, sourceChips).label}
        </span>
      ),
    },
    { label: "文件大小", value: sizeText ?? pending },
    { label: "歌曲 ID", value: <code>{item.id}</code> },
    { label: "播放音质", value: qualityNode },
    { label: "歌词链接", value: lyricNode },
    { label: "封面链接", value: coverNode },
    { label: "歌曲链接", value: songNode },
  ];

  // —— 底部「复制歌曲信息」输出的纯文本：占位语义与上方字段一致
  const txPending = "[播放后获取]";
  let lyricCopy = txPending;
  if (!lyricSongId) {
    lyricCopy = "无歌词资源";
  } else if (isCurrent && lyricRaw) {
    lyricCopy = lyricUrl || `已就绪 · ${lyricLines?.length ?? 0} 行歌词`;
  } else if (isCurrent && lyricError) {
    lyricCopy = "歌词获取失败";
  }
  let coverCopy = txPending;
  if (isCurrent) {
    if (coverUrl && !coverFailed) {
      coverCopy = coverUrl;
    } else if (coverFailed) {
      coverCopy = "封面加载失败";
    } else if (!item.picId) {
      coverCopy = "暂无封面";
    }
  }
  const infoTextLines = [
    `歌名：${item.name}`,
    `歌手：${artist}`,
    `专辑：${item.album || "未知专辑"}`,
    `时长：${durationText ?? txPending}`,
    `来源：${sourceMetaFor(item.source || source, sourceChips).label}`,
    `文件大小：${sizeText ?? txPending}`,
    `歌曲ID：${item.id}`,
    `播放音质：${brValue ? qualityText(brValue) : txPending}`,
    `歌词链接：${lyricCopy}`,
    `封面链接：${coverCopy}`,
    `歌曲链接：${live ? direct!.url : txPending}`,
  ].join("\n");

  const copyInfoText = async () => {
    if (await writeClipboard(infoTextLines)) {
      flashInfoCopied();
      showToast("ok", "歌曲信息已复制");
    } else {
      showToast("err", "复制失败，请重试");
    }
  };

  return (
    <div
      className="mp-info-mask"
      role="presentation"
      onMouseDown={(e) => {
        // 点击遮罩空白处关闭（卡片自身冒泡会被下面 stopPropagation 拦下）
        if (e.target === e.currentTarget) onClose();
      }}>
      <div
        className="mp-info-card"
        role="dialog"
        aria-modal="true"
        aria-label={`歌曲详情：${item.name}`}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="mp-info-head">
          <div className="mp-info-headtext">
            <span className="mp-info-caption">歌曲详情</span>
            <button
              type="button"
              className="mp-info-close"
              onClick={onClose}
              aria-label="关闭详情"
              title="关闭">
              <X />
            </button>
          </div>
        </div>

        <div className="mp-info-fields">
          {fieldRows.map((row) => (
            <div className="mp-info-row" key={row.label}>
              <span className="mp-info-k">{row.label}</span>
              <span className="mp-info-v">{row.value}</span>
            </div>
          ))}
        </div>

        <div className="mp-info-foot">
          <button
            type="button"
            className={cn("mp-info-copybtn", infoCopied && "ok")}
            onClick={copyInfoText}
            aria-label="复制歌曲信息"
            title="将歌曲信息复制到剪贴板">
            {infoCopied ? <Check /> : <Copy />}
            {infoCopied ? "已复制歌曲信息" : "复制歌曲信息"}
          </button>
        </div>
      </div>
    </div>
  );
}
