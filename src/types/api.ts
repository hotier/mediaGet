import type { VideoPlatformKey } from "@/config/video-platforms";

/** 单个清晰度直链（bilibili） */
export interface ParsedVideoQuality {
  /** 清晰度档位 id（64=480P、80=720P、112=1080P、127=1080P+ 等） */
  quality: number;
  /** 清晰度展示标签，如 "高清 1080P" */
  label: string;
  /** 该清晰度视频直链 */
  url: string;
}

/** 多分P / 多清晰度视频项（bilibili 等） */
export interface ParsedVideoItem {
  title?: string;
  url: string;
  /** 时长（秒） */
  duration?: number;
  /** 格式化时长，如 "00:02:59" */
  durationFormat?: string;
  /** 清晰度标签，如 "高清 1080P+" */
  accept?: string[];
  /** 可选清晰度直链列表（bilibili 按档位请求，可下载） */
  qualities?: ParsedVideoQuality[];
  /** 分P封面（B站 pages[].pic，可能为空，前端可回退到整体封面） */
  cover?: string;
}

/**
 * 统一媒体解析数据结构 —— 所有平台解析成功后 data 的契约。
 *
 * 由服务端 `normalize-result` 归一化产出；前端只消费本结构，
 * 平台特有字段（音乐/统计）作为可选扩展保留在同一对象内。
 */
export interface ParseData {
  // —— 内容信息 ——
  title?: string;
  desc?: string;
  /** 内容类型：video / image / music / text（text 表示仅文字、无媒体可下载） */
  type?: "video" | "image" | "music" | "text";
  /** 视频时长（毫秒，抖音等平台） */
  duration?: number;

  // —— 作者信息 ——
  author?: string;
  authorId?: string;
  /** 博主主页链接（抖音等平台，前端可点击跳转） */
  authorUrl?: string;
  avatar?: string;
  /** UP主签名 / 个人简介 */
  sign?: string;
  /** 视频分区（bilibili tname） */
  tname?: string;
  /** 版权标识（bilibili：1=自制 2=转载；汽水音乐等平台为字符串文案） */
  copyright?: number | string;
  /** 互动统计（bilibili 播放/弹幕/评论/收藏/投币/分享/点赞） */
  stat?: {
    view?: number;
    danmaku?: number;
    reply?: number;
    favorite?: number;
    coin?: number;
    share?: number;
    like?: number;
  };

  // —— 媒体 ——
  /** 封面图 */
  cover?: string;
  /** 主媒体直链（视频 / 音乐 / 单图） */
  url?: string;
  /** 音频直链（背景音乐 / 原声），前端据此提供「下载音频」 */
  audioUrl?: string;
  /** 图集 */
  images?: string[];
  /** 多分P / 多清晰度列表（bilibili） */
  videos?: ParsedVideoItem[];

  // —— 音乐扩展（汽水音乐等） ——
  name?: string;
  lyrics?: string;
  core?: string;

  // —— 平台特有统计（保留，抖音等） ——
  like?: number;
  time?: number | string;
  uid?: string;
  /** 视频 ID（抖音 aweme_id 等） */
  awemeId?: string;
  /** 粉丝数（抖音博主主页公开信息） */
  followerCount?: number;
  /** 关注数（抖音博主主页公开信息） */
  followingCount?: number;
  /** 获赞数（抖音博主主页公开信息） */
  totalFavorited?: number;
  music?: { author: string; title?: string; avatar: string };
}

export interface ApiResponse {
  code: number;
  msg: string;
  platform?: VideoPlatformKey;
  data?: ParseData;
}
