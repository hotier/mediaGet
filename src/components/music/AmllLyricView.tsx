"use client";

/**
 * 整页歌词的 AMLL 渲染适配层。
 *
 * 承接原 LyricScroller 的职责：把「秒」单位的 LRC 歌词行与播放状态
 * 转换成 AMLL 需要的「毫秒」LyricLine[]，并维护 加载中 / 无歌词 / 出错
 * 三种空态展示。LyricPlayer 本体经 next/dynamic ssr:false 懒加载，
 * 使歌词渲染不参与服务端预渲染（AMLL 需真实容器尺寸与浏览器动画）。
 *
 * 歌词行转换交由 lyric-amll.ts 的纯函数完成：补全每行真实起止时间、
 * 按字/词切分生成逐字扫亮所需的时间戳（见 buildLrcAmll）。
 */
import dynamic from "next/dynamic";
import { memo, useCallback, useMemo } from "react";
import { Disc3, Loader2 } from "lucide-react";
import { EMPTY_LRC_LINES, buildLrcAmll } from "./lyric-amll";
import type { LyricLine } from "./lyric-utils";
import type { AmllRichResult } from "./ttml-amll";

const AmllPlayer = dynamic(() => import("./amll-player"), { ssr: false });

interface AmllLyricViewProps {
  /** 原始歌词行（time 单位为秒，time < 0 为无时间轴行，会被过滤） */
  lines?: LyricLine[];
  /**
   * AMLL 词库逐字结果：命中时直接渲染词库的毫秒级 words（真逐字扫亮）
   * 与逐句翻译，跳过 LRC 的「整行时长按词均分」估算；未命中时为 null。
   */
  amllRich?: AmllRichResult | null;
  loading: boolean;
  error: string | null;
  /** 是否已拉到原始歌词文本（决定「暂无歌词」还是「拉取中」的措辞） */
  hasRaw: boolean;
  /** 当前播放进度（秒） */
  currentTime: number;
  /** 是否播放中 */
  playing: boolean;
  /** 歌曲总时长（秒，可选）：让最后一行歌词的保持时间贴合歌曲结尾 */
  duration?: number;
  /** 点击歌词行跳转（桌面端可用；移动端不传以禁用行点击） */
  onSeek?: (time: number) => void;
}

export default memo(function AmllLyricView({
  lines = EMPTY_LRC_LINES,
  amllRich = null,
  loading,
  error,
  hasRaw,
  currentTime,
  playing,
  duration,
  onSeek,
}: AmllLyricViewProps) {
  const { timed, amll } = useMemo(() => {
    if (amllRich && amllRich.amll.length > 0) {
      // 词库命中：直接使用毫秒级逐字行（含翻译），timed 同源于句级 begin
      return { timed: amllRich.timed, amll: amllRich.amll };
    }
    const durationMs =
      duration && Number.isFinite(duration) && duration > 0
        ? Math.round(duration * 1000)
        : undefined;
    return buildLrcAmll(lines, { durationMs });
  }, [amllRich, lines, duration]);

  // 点击行 → 还原为秒单位的原始行时间 → 外层 seek
  const handleSeekLine = useCallback(
    (index: number) => {
      const t = timed[index]?.time;
      if (typeof t === "number" && t >= 0) onSeek?.(t);
    },
    [timed, onSeek]
  );

  return (
    <div className="mp-amll-host">
      {loading ? (
        <div className="mp-lyric-empty">
          <Loader2 className="mp-spin" />
          <span>正在加载歌词…</span>
        </div>
      ) : error || (hasRaw && timed.length === 0) ? (
        <div className="mp-lyric-empty">
          <Disc3 />
          <span>暂无歌词</span>
          {error && <span className="err">{error}</span>}
        </div>
      ) : timed.length === 0 ? (
        <div className="mp-lyric-empty">
          <Disc3 />
          <span>暂无歌词</span>
          <span style={{ fontSize: 11, opacity: 0.7 }}>
            播放后自动尝试拉取滚动歌词
          </span>
        </div>
      ) : (
        <AmllPlayer
          lines={amll}
          currentTimeMs={Math.round(currentTime * 1000)}
          playing={playing}
          onSeekLine={onSeek ? handleSeekLine : undefined}
        />
      )}
    </div>
  );
});
