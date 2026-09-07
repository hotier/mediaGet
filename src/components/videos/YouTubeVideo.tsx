"use client";
import React, { useEffect, useRef, useState } from "react";
import Image, { type ImageProps } from "next/image";
import { Download, ExternalLink, Music, Pause, Play, X } from "lucide-react";
import { ApiResponse, ParseData } from "@/types/api";
import { sanitizeFilename } from "@/utils/filename";
import { buildVideoProxyUrl } from "@/utils/videoProxy";
import PlatformIcon from "@/components/PlatformIcon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TruncatedText from "@/components/ui/truncated-text";
import ParseInfoPanel from "./ParseInfoPanel";
import CaptionBox from "./CaptionBox";
import VideoPosterCard from "./VideoPosterCard";
import DownloadRow from "./DownloadRow";

/**
 * YouTube 结果渲染 —— 页面模式与 B站（BilibiliVideo）一致：
 *   频道信息卡 → 播放器（封面 + 主操作按钮） → 简介 → 信息面板 → 下载选项卡
 *
 * 播放形态为「官方嵌入主路径」：后端 /api/youtube 成功后返回 data.videoId /
 * data.embedUrl（youtube-nocookie.com/embed/{id}，无 API Key、不依赖第三方解析
 * 实例存活）。封面 /「在线播放」展开播放器，主按钮经三层控制链路实现播放/暂停：
 * 官方 IFrame API → 裸 postMessage 命令（API 脚本被拦时降级）→ 纯 iframe（旧数据）。
 * data.url（Piped/Invidious 直链）作为可选增强进入「下载选项」卡（与 B站同款：
 * 走 /api/video-proxy&download=1 强制保存文件、自定义命名），解析源不可用时
 * 该卡整体隐藏，页面以官方在线播放兜底（data.embedOnly=true 时给出提示）。
 *
 * 国内网络可达性（2026-09）：官方 iframe 依赖用户网络可达 YouTube（无法代理）；
 * 其余资源均经服务端转发 —— 头像/封面经 /api/image（代理失败回退直链），
 * 「直链播放」兜底与下载经 /api/video-proxy（googlevideo / pipedproxy 域由
 * utils/videoProxy 统一判定包装），被墙网络下播放与展示均可正常工作。
 *
 * 兼容性：旧缓存/旧结果可能只有 data.url（无 videoId/embedUrl），此时回退通用
 * 直链卡片（VideoPosterCard）渲染，保证老数据仍可播放与下载。
 */

/** YouTube 品牌红渐变 */
const YT_GRADIENT = "from-[#FF0000] to-[#ff4d4d]";

/* === 图床代理（头像 / 封面） ===
 * YouTube 头像与封面均为 Google 图床（yt3.ggpht.com / i.ytimg.com 等），国内网络
 * 直连常被阻断 —— 一律先经 /api/image 服务端转发加载（Vercel 等海外部署可达上游，
 * 路由自带 6h LRU 缓存与防盗链 Referer 逻辑）；代理加载失败时回退直链，自建部署
 * 在可直连 Google 的网络下仍能正常显示。包装幂等：已代理路径原样返回。 */
function proxifyImageUrl(url?: string): string {
  if (!url || !/^https?:\/\//i.test(url)) return url || "";
  if (url.startsWith("/api/image")) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
}

/** 经图片代理加载的 <Image>：代理地址失败（onError）自动回退原直链 */
function YtImage(
  props: Omit<ImageProps, "src" | "unoptimized" | "onError"> & { src: string }
) {
  const { src, alt, ...rest } = props;
  const [current, setCurrent] = useState(() => proxifyImageUrl(src));
  useEffect(() => {
    setCurrent(proxifyImageUrl(src));
  }, [src]);
  return (
    <Image
      {...rest}
      src={current}
      alt={alt}
      unoptimized
      onError={() => {
        if (current !== src) setCurrent(src);
      }}
    />
  );
}

/* === 官方 IFrame Player API（用于主按钮控制内嵌播放器的 播放/暂停） === */

/** 播放器句柄（仅声明用到的能力） */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

/** onStateChange / onReady 事件负载：data 为播放器状态码（1=播放中） */
interface YTPlayerEvent {
  data: number;
  target: YTPlayer;
}

interface YTPlayerOptions {
  videoId?: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: YTPlayerEvent) => void;
    onStateChange?: (e: YTPlayerEvent) => void;
  };
}

interface YTNamespace {
  Player: new (element: HTMLElement, options: YTPlayerOptions) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** YT.PlayerState.PLAYING */
const YT_STATE_PLAYING = 1;

/** 播放器控制层：api=官方 IFrame API / postmessage=裸 postMessage 命令 /
 *  local=直链原生 <video>（官方 iframe 完全连不上时的兜底）/ plain=不可控制 */
type PlayerMode = "api" | "postmessage" | "local" | "plain";

/** 加载失败判定窗口：展开后该时间内无任何播放器就绪/状态信号则判定失败 */
const EMBED_FAIL_TIMEOUT = 8000;

/** postMessage 命令的目标源（iframe 实际 origin） */
const YT_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** IFrame API 单例加载：全局只注入一次脚本；8s 超时/加载失败时拒绝，
 *  调用方据此回退到纯 iframe 嵌入（无 JS 控制能力但不影响观看） */
let ytApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("ssr"));
  }
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      ytApiPromise = null;
      reject(new Error("YouTube IFrame API 加载超时"));
    }, 8000);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      prev?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      ytApiPromise = null;
      reject(new Error("YouTube IFrame API 加载失败"));
    };
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

/** 毫秒时长 → "mm:ss" / "h:mm:ss"（下载行副信息用） */
function fmtDuration(ms?: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const totalSec = Math.round(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 订阅数缩写：>1万 → x.x万 / xx万，其余千分位（与 B站 UP 卡统计一致） */
function fmtCount(n: number): string {
  if (n >= 10000) {
    return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`;
  }
  return n.toLocaleString("zh-CN");
}

/** 从官方嵌入地址中提取 videoId（兜底：部分数据可能只有 embedUrl 而无 videoId） */
function idFromEmbedUrl(embedUrl?: string): string {
  if (!embedUrl) return "";
  const m = String(embedUrl).match(/(?:embed|v=)\/?([\w-]{6,})/);
  return m ? m[1] : "";
}

/** 从直链推断文件扩展名：优先 mime 参数，其次路径后缀，都取不到用 fallback */
function extFromUrl(url: string, fallback: string): string {
  const mime = /[?&]mime=([^&]+)/i.exec(url);
  if (mime) {
    const type = /^[^/]+\/([a-z0-9.+-]+)/i.exec(decodeURIComponent(mime[1]));
    if (type) {
      const ext = type[1].toLowerCase().replace("mp4a", "m4a");
      if (/^(mp4|webm|m4a|mp3|aac|ogg)$/.test(ext)) return ext;
    }
  }
  const path = /\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(url.split("?")[0]);
  return path ? path[1].toLowerCase() : fallback;
}

export default function YouTubeVideo({ data }: { data: ApiResponse }) {
  const d = data.data as ParseData | undefined;
  // 播放器是否展开（展开 = 挂载播放器）；收起即销毁回到封面
  const [expanded, setExpanded] = useState(false);
  /**
   * 播放器控制层（三层兜底）：
   * - api：官方 IFrame Player API（优先，状态同步最可靠）
   * - postmessage：API 脚本被墙/拦截时降级 —— iframe 带 enablejsapi=1，
   *   直接 postMessage 发 playVideo/pauseVideo 命令（同一底层协议，零依赖），
   *   并用 listening 握手尽力同步播放状态
   * - plain：无 videoId 的旧数据（仅 embedUrl），无法 JS 控制，主按钮=收起
   */
  const [mode, setMode] = useState<PlayerMode>("plain");
  const [playing, setPlaying] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  // 官方 iframe 无法加载（网络连不上 YouTube）时的失败提示与重试计数
  const [embedFailed, setEmbedFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // 是否收到过播放器就绪/状态信号（iframe 被网络重置时不会有任何信号）
  const gotSignalRef = useRef(false);

  const videoId = d ? d.videoId || idFromEmbedUrl(d.embedUrl) : "";
  // 主按钮能否直接控制播放器（有 videoId 且未跌落到 plain 层）
  const canControl = Boolean(videoId) && mode !== "plain";

  // 展开/收起/重试时重置控制层：有 videoId 先走官方 API，失败自动降级 postmessage
  useEffect(() => {
    if (!expanded) {
      setMode("plain");
      return;
    }
    setMode(videoId ? "api" : "plain");
    setPlayerReady(false);
    setPlaying(false);
    setEmbedFailed(false);
  }, [expanded, videoId, retryKey]);

  // api 层：挂载官方 IFrame API 播放器并自动播放，onStateChange 同步 playing；
  // 收起/卸载时 destroy。挂载点用命令式创建 —— YT.Player 会把目标元素替换为
  // iframe，直接挂 React 管理的节点会在卸载时引发 DOM 冲突
  useEffect(() => {
    if (!expanded || mode !== "api" || !videoId) return;
    let cancelled = false;
    let player: YTPlayer | null = null;
    loadYouTubeApi()
      .then(() => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        const mount = document.createElement("div");
        host.appendChild(mount);
        player = new window.YT!.Player(mount, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              gotSignalRef.current = true;
              setPlayerReady(true);
              e.target.playVideo();
            },
            onStateChange: (e) => {
              if (!cancelled) setPlaying(e.data === YT_STATE_PLAYING);
            },
          },
        });
        playerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) setMode("postmessage");
      });
    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        // 播放器尚未创建时忽略
      }
      playerRef.current = null;
      setPlayerReady(false);
      setPlaying(false);
    };
  }, [expanded, mode, videoId, retryKey]);

  // postmessage 层：监听播放器推送的 onStateChange（listening 握手，尽力而为；
  // 即使握手失败，命令控制依然可用 —— 状态以点击操作乐观更新为准）
  useEffect(() => {
    if (!expanded || mode !== "postmessage") return;
    setPlayerReady(true);
    // autoplay=1 几乎总会开播（展开动作本身是用户手势）；被浏览器拦截时
    // 若握手成功，onStateChange 会把状态校正回来
    setPlaying(true);
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handshake = () => {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: "mediaGet", channel: "widget" }),
        "https://www.youtube-nocookie.com"
      );
    };
    handshake();
    iframe.addEventListener("load", handshake);
    const onMessage = (e: MessageEvent) => {
      if (!/^https:\/\/([\w-]+\.)*youtube(-nocookie)?\.com$/.test(e.origin)) {
        return;
      }
      try {
        const msg = JSON.parse(String(e.data)) as {
          event?: string;
          info?: number;
        };
        if (msg.event === "onStateChange" && typeof msg.info === "number") {
          gotSignalRef.current = true;
          setPlaying(msg.info === YT_STATE_PLAYING);
        }
      } catch {
        // 忽略非 JSON 消息
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      iframe.removeEventListener("load", handshake);
      window.removeEventListener("message", onMessage);
    };
  }, [expanded, mode]);

  // local 层：直链原生 <video> 播放（不经过 YouTube 服务器），挂载即可控。
  // 直链为 googlevideo / pipedproxy 域，经 buildVideoProxyUrl 统一包装走
  // /api/video-proxy 服务端转发 —— 被墙网络下浏览器连不上上游也能播放
  useEffect(() => {
    if (!expanded || mode !== "local") return;
    gotSignalRef.current = true;
    setPlayerReady(true);
    return () => {
      setPlayerReady(false);
      setPlaying(false);
    };
  }, [expanded, mode]);

  // 加载失败检测：任何控制层在判定窗口内没有收到任何就绪/状态信号
  // （典型场景：当前网络连不上 YouTube，iframe 连接被重置），展示失败提示，
  // 并在有直链时提供「直链播放」原生 <video> 兜底
  useEffect(() => {
    if (!expanded || !videoId) return;
    gotSignalRef.current = false;
    setEmbedFailed(false);
    const timer = window.setTimeout(() => {
      if (!gotSignalRef.current) setEmbedFailed(true);
    }, EMBED_FAIL_TIMEOUT);
    return () => window.clearTimeout(timer);
  }, [expanded, mode, videoId, retryKey]);

  if (!d) return null;
  const embedSrc = videoId
    ? `https://www.youtube-nocookie.com/embed/${videoId}`
    : d.embedUrl && /^https?:\/\//.test(d.embedUrl)
      ? d.embedUrl
      : "";
  const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
  const videoUrl = d.url || "";
  const audioUrl = d.audioUrl || "";
  const cover = d.cover || "";
  const hasEmbed = Boolean(embedSrc);
  const hasDirect = Boolean(videoUrl);
  // 富信息：频道真实头像 / 订阅数 / 频道主页链接（直链源成功时下发）；
  // 官方 v3 配置时再补：@频道号（authorId）/ 频道简介（sign）/ 投稿数 / 频道累计播放
  const subCount = Number(d.subscriberCount) || 0;
  const videoCount = Number(d.videoCount) || 0;
  const channelViews = Number(d.channelViews) || 0;
  // 频道号：authorId 为 v3 customUrl（后端已去 @ 前缀）；若为频道 ID（UC…）等则不展示
  const handle =
    d.authorId && !/^UC[\w-]{20,}$/.test(d.authorId)
      ? `@${d.authorId.replace(/^@/, "")}`
      : "";
  const channelSign = d.sign || "";
  const channelHref =
    d.authorUrl && /^https?:\/\//.test(d.authorUrl) ? d.authorUrl : "";

  // 极端兜底：既无官方嵌入也无直链 —— 不应出现
  if (!hasEmbed && !hasDirect) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-muted leading-relaxed">
          未获取到该视频的播放信息，请稍后重试
        </p>
      </Card>
    );
  }

  // 旧数据兜底：无 videoId/embedUrl 但有直链 → 沿用通用直链卡片
  if (!hasEmbed && hasDirect) {
    return (
      <div className="space-y-5" style={{ touchAction: "pan-y" }}>
        <Card className="p-5">
          <TruncatedText
            as="h2"
            text={d.title || "YouTube 视频"}
            className="text-lg font-semibold text-primary line-clamp-3 mb-1"
          />
          {d.author && (
            <TruncatedText
              as="p"
              text={d.author}
              className="text-sm text-muted truncate"
            />
          )}
        </Card>
        <VideoPosterCard
          url={videoUrl}
          cover={cover}
          alt={d.title || "视频封面"}
          accent="red"
          audioUrl={audioUrl}
        />
        <ParseInfoPanel data={d} platform="youtube" title="视频信息" />
      </div>
    );
  }

  /** 下载文件名：youtube-频道-标题[-清晰度].mp4 / [-audio].m4a；
   *  多档位下拉时按所选档位标签与直链推断清晰度/扩展名 */
  const buildFileName = (
    kind: "video" | "audio",
    quality?: string,
    sourceUrl?: string
  ): string => {
    const base = `youtube-${sanitizeFilename(d.author || "channel", 20)}-${sanitizeFilename(
      d.title || "video",
      40
    )}`;
    if (kind === "video") {
      const label = quality ?? d.qualityLabel;
      const qual = label ? `-${label.replace(/\s+/g, "")}` : "";
      return `${base}${qual}.${extFromUrl(sourceUrl || videoUrl, "mp4")}`;
    }
    return `${base}-audio.${extFromUrl(audioUrl, "m4a")}`;
  };

  /** 「下载视频」主按钮：滚动定位到下方下载选项卡（与 B站行为一致） */
  const scrollToDownload = () => {
    const target =
      document.getElementById("youtube-download-0") ||
      document.getElementById("youtube-download");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /** 主按钮：未展开 → 展开并自动播放；可控制时切换 播放/暂停；
   *  不可控制（plain 层，仅 embedUrl 旧数据）时回退为收起播放器 */
  const onMainAction = () => {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    if (!canControl) {
      setExpanded(false);
      return;
    }
    const next = !playing;
    if (mode === "api") {
      const p = playerRef.current;
      if (!p) return;
      if (next) p.playVideo();
      else p.pauseVideo();
    } else if (mode === "local") {
      const v = videoRef.current;
      if (!v) return;
      if (next) v.play().catch(() => {});
      else v.pause();
    } else {
      // postmessage 层：命令直发（播放器未就绪时会被忽略，无副作用）
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({
          event: "command",
          func: next ? "playVideo" : "pauseVideo",
          args: [],
        }),
        YT_EMBED_ORIGIN
      );
    }
    // 乐观更新：api 层随后的 onStateChange / postmessage 层的状态推送会校准
    setPlaying(next);
  };

  /** 失败兜底：切换到直链原生 <video> 播放（Piped/Invidious 渐进式 mp4，
   *  不经过 YouTube 服务器；经 /api/video-proxy 服务端转发，被墙网络下仍可播放） */
  const playLocal = () => {
    setEmbedFailed(false);
    setMode("local");
  };
  /** 重试：重置控制层，从头走 api → postmessage 链路 */
  const retry = () => setRetryKey((k) => k + 1);

  const durationText = fmtDuration(d.duration);
  const hasDesc = Boolean(d.desc);

  // 主按钮文案/图标：可控制时 = 加载中/播放/暂停；否则维持原 展开/收起 语义
  const controlling = expanded && canControl;
  // postmessage 层 iframe 追加参数：enablejsapi=1 + origin（postMessage 控制必需）
  const postMessageParams =
    mode === "postmessage" && typeof window !== "undefined"
      ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
      : "";
  const mainLabel = controlling
    ? playerReady
      ? playing
        ? "暂停"
        : "播放"
      : "加载中…"
    : expanded
      ? "收起播放器"
      : "在线播放";
  const MainIcon = controlling
    ? playerReady && playing
      ? Pause
      : Play
    : expanded
      ? X
      : Play;

  return (
    <div className="space-y-5" style={{ touchAction: "pan-y" }}>
      {/* 频道信息卡（布局与 B站 UP 卡统一）：真实头像（直链源/官方 v3 下发；oEmbed 降级/旧
          缓存缺失时用 YouTube 品牌红圆徽占位）+ 频道名行（「频道」小标签 + 可点主页名称）+
          @频道号行（用户名：@xxx）+ 频道简介行（简介：xxx）+ 统计徽标（订阅/投稿/累计播放，
          官方 v3 配置时下发，无值自动隐藏）；视频ID 归入下方「视频信息」面板；右侧 Logo 点击
          打开原站视频 */}
      {d.author && (
        <Card className="p-5">
          <div className="flex items-center gap-4">
            <div className="relative flex-shrink-0">
              <div
                className={`absolute inset-0 rounded-full bg-gradient-to-br ${YT_GRADIENT} blur-sm opacity-50`}
              />
              {d.avatar ? (
                <YtImage
                  src={d.avatar}
                  alt={d.author || "频道头像"}
                  width={56}
                  height={56}
                  className="relative h-14 w-14 rounded-full border-2 border-glass-3 object-cover"
                />
              ) : (
                <div
                  className={`relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br ${YT_GRADIENT} shadow-lg`}>
                  <Play
                    className="h-6 w-6 translate-x-[1px] text-white"
                    fill="currentColor"
                  />
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              {d.author && (
                <div className="flex items-center gap-2">
                  <span className="flex-shrink-0 text-[13px] text-secondary">频道</span>
                  {channelHref ? (
                    <TruncatedText
                      as="a"
                      text={d.author}
                      href={channelHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] font-medium text-accent truncate hover:underline hover:text-accent/80 transition-colors"
                    />
                  ) : (
                    <TruncatedText
                      text={d.author}
                      className="text-[13px] font-medium text-accent truncate"
                    />
                  )}
                </div>
              )}
              {/* @频道号（官方 v3 下发，如 @MrBeast）——与 B站 UP 卡 UID 行同款：前缀拼进文本行 */}
              {handle && (
                <TruncatedText
                  as="p"
                  text={`用户名：${handle}`}
                  className="mt-0.5 text-[13px] text-muted truncate"
                />
              )}
              {/* 频道简介（官方 v3 下发）——与 B站 UP 卡简介行同款：左侧固定「简介：」标签，值单行省略 */}
              {channelSign && (
                <p className="mt-0.5 flex items-start gap-1 text-[13px] text-muted">
                  <span className="flex-shrink-0">简介：</span>
                  <TruncatedText text={channelSign} className="min-w-0 truncate" />
                </p>
              )}
              {/* 频道统计徽标（订阅 / 投稿数 / 累计播放，与 B 站 UP 卡「关注/粉丝」同款纯文本
                  行；无值自动隐藏） */}
              {(subCount > 0 || videoCount > 0 || channelViews > 0) && (
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                  {subCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-muted">订阅</span>
                      <span className="font-semibold text-primary">
                        {fmtCount(subCount)}
                      </span>
                    </span>
                  )}
                  {videoCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-muted">投稿</span>
                      <span className="font-semibold text-primary">
                        {fmtCount(videoCount)}
                      </span>
                    </span>
                  )}
                  {channelViews > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-muted">累计播放</span>
                      <span className="font-semibold text-primary">
                        {fmtCount(channelViews)}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* YouTube Logo：可点击跳到原站视频 */}
            {watchUrl ? (
              <a
                href={watchUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="在 YouTube 打开"
                className="flex-shrink-0 transition-opacity hover:opacity-80">
                <PlatformIcon
                  platform="youtube"
                  size={40}
                  rounded="rounded-xl"
                />
              </a>
            ) : (
              <div className="flex-shrink-0">
                <PlatformIcon platform="youtube" size={40} rounded="rounded-xl" />
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 播放器：封面（未展开，点击展开并自动播放）→ 官方 API 播放器（主按钮可
          播放/暂停）。按钮行：在线播放/播放/暂停 + 下载视频（滚动到下载卡）+
          收起（仅可控制时显示）；无直链时以「在 YouTube 打开」替代下载 */}
      <div className="space-y-3">
        {!expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="在线播放视频"
            className="group relative block w-full overflow-hidden rounded-2xl bg-black cursor-pointer text-left">
            <div className="relative aspect-video w-full">
              {cover ? (
                <YtImage
                  src={cover}
                  alt={d.title || "视频封面"}
                  fill
                  className="object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center px-6">
                  <TruncatedText
                    as="span"
                    text={d.title || "YouTube 视频"}
                    className="text-center text-sm text-white/70"
                  />
                </div>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-300 group-hover:bg-black/15">
                <span className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white/90 group-hover:bg-white text-black flex items-center justify-center shadow-lg transition-transform duration-300 group-hover:scale-110">
                  <Play
                    className="w-7 h-7 sm:w-9 sm:h-9 ml-1"
                    fill="currentColor"
                  />
                </span>
              </span>
            </div>
          </button>
        )}

        {/* 官方播放器：api 层挂载 IFrame API 播放器（host 内命令式挂载点）；
            postmessage 层为带 enablejsapi 的裸 iframe；local 层为直链原生
            <video>；plain 层（仅 embedUrl 旧数据）为纯 iframe，不可 JS 控制。
            embedFailed 时浮层提示并提供 直链播放 / 重试 */}
        {expanded && (
          <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black">
            {mode === "api" ? (
              <div
                ref={hostRef}
                className="absolute inset-0 [&_iframe]:block [&_iframe]:h-full [&_iframe]:w-full"
              />
            ) : mode === "local" ? (
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full"
                src={buildVideoProxyUrl(videoUrl)}
                controls
                autoPlay
                playsInline
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onPlaying={() => {
                  gotSignalRef.current = true;
                }}
              />
            ) : (
              <iframe
                ref={mode === "postmessage" ? iframeRef : null}
                className="absolute inset-0 h-full w-full"
                src={`${embedSrc}?autoplay=1&rel=0${postMessageParams}`}
                title={`${d.title || "YouTube 视频"} 在线播放`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            )}

            {/* 加载失败浮层：当前网络连不上 YouTube 时给出可用退路 */}
            {embedFailed && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center backdrop-blur-sm">
                <p className="max-w-md text-sm leading-relaxed text-white/90">
                  官方播放器无法加载：当前网络连接不上
                  YouTube（连接被重置或超时）
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {hasDirect && mode !== "local" && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={playLocal}
                      className={`bg-gradient-to-r ${YT_GRADIENT} hover:opacity-90`}>
                      <Play className="h-4 w-4" />
                      直链播放
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={retry}
                    className="border-white/30 text-white hover:bg-white/10 hover:text-white">
                    重试
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 操作按钮：移动端两行 —— 主按钮独占第一行，下载/打开 + 收起在第二行 5:5 平分（无第三按钮时占满）；
            桌面端 sm:contents 并回单行。主按钮 flex-1 仅限 sm+：移动端纵向 flex 里
            flex-1 的 basis 0% 作用在高度主轴上，会把 size 档的固定高度压扁成内容行高 */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            type="button"
            variant="default"
            size="lg"
            onClick={onMainAction}
            disabled={controlling && !playerReady}
            className={`sm:flex-1 bg-gradient-to-r ${YT_GRADIENT} hover:opacity-90`}>
            <MainIcon className="h-5 w-5" />
            {mainLabel}
          </Button>
          {/* 第二行：下载视频 / 在 YouTube 打开 + 收起，移动端 5:5 平分（无第二个时占满整行） */}
          <div className="flex gap-3 sm:contents">
          {hasDirect ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={scrollToDownload}>
              <Download className="h-5 w-5" />
              下载视频
            </Button>
          ) : (
            watchUrl && (
              <Button asChild variant="outline" size="lg" className="flex-1">
                <a href={watchUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-5 w-5" />
                  在 YouTube 打开
                </a>
              </Button>
            )
          )}
          {/* 收起播放器：销毁内嵌播放器回到封面（仅主按钮已变为播放/暂停控制时显示） */}
          {expanded && canControl && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => setExpanded(false)}
              aria-label="收起播放器"
              className="flex-1 sm:flex-none">
              <X className="h-5 w-5" />
              收起
            </Button>
          )}
          </div>
        </div>
      </div>

      {/* 视频简介 */}
      {hasDesc && <CaptionBox text={d.desc || ""} title="视频简介" />}

      {/* 信息面板：视频信息 */}
      <ParseInfoPanel data={d} platform="youtube" title="视频信息" />

      {/* 下载选项：与 B站同款布局 —— 视频（可选：清晰度徽标/时长）与分离音频各一行，
          点「下载」走视频代理 + Content-Disposition 强制保存文件 */}
      {hasDirect ? (
        <Card id="youtube-download" className="p-5 scroll-mt-24">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">
              <svg
                className="w-4 h-4 text-accent"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              下载选项 ({audioUrl ? 2 : 1})
            </h3>
          </div>

          <div className="space-y-3">
            {/* 视频行：单一直链 + 清晰度徽标（B站同款行布局，多档位时共享组件自动换成行内下拉） */}
            <DownloadRow
              id="youtube-download-0"
              cover={cover}
              coverAlt={d.title || "视频封面"}
              title={`视频：${d.title || "YouTube 视频"}`}
              durationText={durationText}
              badge={d.qualityLabel || undefined}
              href={videoUrl}
              qualities={d.qualities}
              buildHref={(url, label) =>
                `/api/video-proxy?url=${encodeURIComponent(
                  url
                )}&download=1&filename=${encodeURIComponent(
                  buildFileName("video", label, url)
                )}`}
              gradient={YT_GRADIENT}
            />

            {/* 分离音频行（仅无声视频分离流场景存在）：与 B站下载卡同款行布局 */}
            {audioUrl && (
              <DownloadRow
                id="youtube-download-1"
                iconPlaceholder={<Music className="h-6 w-6 text-accent/70" />}
                title={`音频：${d.title || "YouTube 视频"}`}
                badge="原声音频"
                href={audioUrl}
                buildHref={(url) =>
                  `/api/video-proxy?url=${encodeURIComponent(
                    url
                  )}&download=1&filename=${encodeURIComponent(buildFileName("audio"))}`}
                gradient={YT_GRADIENT}
              />
            )}
          </div>
        </Card>
      ) : (
        d.embedOnly && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-500 dark:text-amber-400">
            <span>
              直链解析源暂不可用，已自动切换到官方在线播放；稍后重试即可恢复下载。
            </span>
          </div>
        )
      )}
    </div>
  );
}
