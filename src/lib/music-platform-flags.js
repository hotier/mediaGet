/**
 * 平台引擎开关 —— 可配置项（同构纯 JS：服务端读 env，浏览器 import 时回退默认，无副作用）。
 *
 * 每个「面向用户的搜索平台」都有两个独立开关：
 *   - search：平台搜索引擎（决定该平台能否被关键词搜索 / 是否出现在搜索源 chips）；
 *   - play：  平台播放引擎（决定内置直链引擎是否允许为该平台取播放 URL / resolve 是否宣称 playable）。
 *
 * 平台全集 MUSIC_FLAG_PLATFORM_KEYS 覆盖前端可选的搜索平台（GD 通道命名）：
 * netease / kuwo / joox 走 GD 搜索引擎与 GD 直链；tencent / kugou / migu 走自研直连
 * 搜索（self-search，tencent 模块仍在注册表内）；kugou 已内置官方试听直链（getSongInfo，
 * 免费档 128k mp3，见 src/lib/self-search/kugou.js），migu 仍无内置直链引擎。
 *
 * 默认值（2026-09，与「腾讯暂时不可用」事实一致，但均可用 env 覆盖）：
 *   - search：除 tencent 外全开（QQ 可播直链暂无稳定来源，先不给搜索入口）；
 *   - play：  开放实测可用的 netease / kuwo / kugou / joox——kugou 为官方免费 128k
 *             试听直链（VIP/付费曲取链会失败，见 failType=vip-only）；tencent（GD 上游
 *             不开放）与 migu（无内置直链）默认关——migu 的播放可由已配置的 lx 音源脚本
 *             兜底（urlFallbacks，见 lx-provider.js，不受本开关约束）。
 *
 * 配置方式（环境变量）：
 *   1) 正向覆盖（JSON 对象，仅列出需要覆盖的平台即可；或 "all" 全开）：
 *        MUSIC_PLATFORM_SEARCH='{"tencent":true}'      # 打开 QQ 音乐搜索
 *        MUSIC_PLATFORM_PLAY='{"netease":false}'        # 关闭网易云取链
 *        MUSIC_PLATFORM_PLAY='all'                      # 全部平台开放播放引擎
 *   2) 禁用黑名单（逗号分隔平台键；留空 / "default" 回退内置默认）：
 *        MUSIC_PLATFORM_SEARCH_DISABLED=tencent
 *        MUSIC_PLATFORM_PLAY_DISABLED=tencent,kugou,migu
 *      黑名单 = 最终闸门：列出的平台在本维度强制关闭，即使被正向覆盖 / "all" 打开；
 *      未列出的平台保持默认 / 正向覆盖结果。非法 JSON / 非法平台键会被忽略并告警日志。
 *   3) 整体下线便捷变量（逗号分隔平台键；最终闸门）：
 *        MUSIC_PLATFORM_OFF=tencent,kugou,migu
 *      等价于把列出的平台同时写进 search / play 两个禁用黑名单（两个维度一并强制关闭），
 *      供「整体下线某平台」时只配一个变量；只需单独停某一维度时仍用 2) 的两个黑名单。
 *
 * 消费方：/api/music（search/url 校验）、/api/music/self（自研搜索校验与列表）、
 * resolve/route.js（playable 判定）、/api/music/caps（能力矩阵下发，前端据此过滤 chips
 * 与跨源现搜候选）。前端侧 music-caps.ts 通过 caps 端点拉取部署期真实开关，失败时回退本文件默认。
 */

/** 参与引擎开关的搜索平台全集（顺序即展示/候选顺序） */
export const MUSIC_FLAG_PLATFORM_KEYS = [
  "netease",
  "tencent",
  "kugou",
  "kuwo",
  "migu",
  "joox",
];

/** 各平台默认开关（与上表顺序对应） */
export const MUSIC_PLATFORM_DEFAULT_FLAGS = {
  search: {
    netease: true,
    tencent: false, // QQ 可播直链暂无稳定来源 → 默认不给搜索入口
    kugou: true,
    kuwo: true,
    migu: true,
    joox: true,
  },
  play: {
    netease: true,
    tencent: false, // GD 上游不开放 tencent 取链（2026-09 实测 400）
    kugou: true, // 内置酷狗官方免费试听直链（getSongInfo，免费档 128k mp3）
    kuwo: true,
    migu: false, // 无内置直链引擎；lx 脚本兜底不依赖本开关
    joox: true,
  },
};

const ENV_NAMES = {
  search: "MUSIC_PLATFORM_SEARCH",
  play: "MUSIC_PLATFORM_PLAY",
};

/** 禁用黑名单 env（逗号分隔平台键；优先级最高，最终闸门） */
const DISABLED_ENV_NAMES = {
  search: "MUSIC_PLATFORM_SEARCH_DISABLED",
  play: "MUSIC_PLATFORM_PLAY_DISABLED",
};

/**
 * 整体下线 env（逗号分隔平台键；最终闸门）——便捷写法，等价于把列出的平台同时
 * 写入 search / play 两个禁用黑名单，两个维度一并强制关闭。
 */
const OFF_ENV_NAME = "MUSIC_PLATFORM_OFF";

const KEY_SET = new Set(MUSIC_FLAG_PLATFORM_KEYS);

/** 读 env（浏览器 / edge 无 process 时返回空串） */
function readEnv(name) {
  if (typeof process === "undefined" || !process.env) return "";
  const v = String(process.env[name] || "").trim();
  return v;
}

/**
 * 解析某维度 env 覆盖：
 * - 空串 / "default" → null（不覆盖）；
 * - "all" → 该维度全 true；
 * - JSON 对象 → 逐平台覆盖（true/false），非法键忽略。
 */
function parseOverride(kind, raw) {
  if (!raw || raw === "default") return null;
  // "all" = 该维度全部平台开启（区别于默认矩阵里 tencent/kugou/migu 的关闭值）
  if (raw === "all") {
    return Object.fromEntries(
      MUSIC_FLAG_PLATFORM_KEYS.map((key) => [key, true])
    );
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("not a flat object");
    }
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!KEY_SET.has(key)) {
        console.warn(`[music-flags] 忽略未知平台键 ${key}（${ENV_NAMES[kind]}）`);
        continue;
      }
      if (typeof value !== "boolean") {
        console.warn(`[music-flags] 忽略非布尔值 ${key}=${value}（${ENV_NAMES[kind]}）`);
        continue;
      }
      out[key] = value;
    }
    return out;
  } catch {
    console.warn(
      `[music-flags] ${ENV_NAMES[kind]} 不是合法 JSON 对象或 "all"，已忽略：${raw}`
    );
    return null;
  }
}

/**
 * 解析逗号分隔平台键 env 为数组（envName 仅用于告警文案）：
 * - 空串 / "default" → []（不覆盖，回退内置默认）；
 * - 其余按逗号拆分并 trim，非法平台键忽略并告警。
 */
function parseKeyList(raw, envName) {
  if (!raw || raw === "default") return [];
  const list = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key) continue;
    if (!KEY_SET.has(key)) {
      console.warn(`[music-flags] 忽略未知平台键 ${key}（${envName}）`);
      continue;
    }
    list.push(key);
  }
  return list;
}

/** 解析某维度禁用黑名单 env（逗号分隔平台键） */
function parseDisabledList(kind, raw) {
  return parseKeyList(raw, DISABLED_ENV_NAMES[kind]);
}

/** 解析整体下线 env（MUSIC_PLATFORM_OFF，逗号分隔平台键） */
function parseOffList(raw) {
  return parseKeyList(raw, OFF_ENV_NAME);
}

/**
 * 解析某维度（"search" | "play"）生效的开关表：
 * 默认矩阵 → 正向 env 覆盖（JSON / "all"）→ 禁用黑名单（最终闸门，强制关）。
 * 每次调用动态读 env（对齐 gdmusic.getUpstreamBases），便于部署后 env 生效与单测注入。
 */
export function resolveMusicPlatformFlags(kind) {
  const defaults = MUSIC_PLATFORM_DEFAULT_FLAGS[kind] || {};
  const override = parseOverride(kind, readEnv(ENV_NAMES[kind]));
  const table = override ? { ...defaults, ...override } : { ...defaults };
  // 最终闸门：整体下线变量（MUSIC_PLATFORM_OFF，search/play 一并关闭）与本维度禁用
  // 黑名单取并集——列出的平台本维度一律强制 false（可压过 "all" / JSON 打开）
  for (const key of parseOffList(readEnv(OFF_ENV_NAME))) {
    table[key] = false;
  }
  for (const key of parseDisabledList(kind, readEnv(DISABLED_ENV_NAMES[kind]))) {
    table[key] = false;
  }
  return table;
}

/** 某平台是否开启某维度开关 */
export function isMusicPlatformEnabled(kind, source) {
  const table = resolveMusicPlatformFlags(kind);
  return table[source] === true;
}

/** 简写：搜索开关 */
export function isPlatformSearchEnabled(source) {
  return isMusicPlatformEnabled("search", source);
}

/** 简写：播放引擎开关 */
export function isPlatformPlayEnabled(source) {
  return isMusicPlatformEnabled("play", source);
}

/** 某维度开启的平台列表（按 MUSIC_FLAG_PLATFORM_KEYS 顺序） */
export function enabledPlatformList(kind) {
  const table = resolveMusicPlatformFlags(kind);
  return MUSIC_FLAG_PLATFORM_KEYS.filter((key) => table[key] === true);
}
