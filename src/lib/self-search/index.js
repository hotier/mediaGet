/**
 * 自研音乐搜索 —— 统一入口。
 *
 * 平台搜索直连（移植自 lx-music-desktop musicSdk，Apache-2.0），source 键沿用
 * GD 通道命名（wy→netease、tx→tencent、kg→kugou、kw→kuwo、mg→migu），搜索结果
 * 归一为本服务统一 SearchItem 契约（含可内嵌的 picUrlDirect，封面不强求、不做二次换取）。
 *
 * 应用价值：netease/kuwo 的搜索以本通道（服务器直连）为主，GD 搜索引擎仅作兜底；
 * tencent/kugou/migu 是 GD 未开放搜索的全新搜索源（tencent/kuwo/netease 产物可复用
 * 既有 GD 直链/歌词/封面通道；kugou 已内置官方免费试听直链，见 src/lib/self-search/kugou.js，
 * migu 仍无内置直链引擎）。
 *
 * 平台搜索引擎的启用/停用是可配置项（见 src/lib/music-platform-flags.js）：
 * tencent（QQ音乐）默认为停用状态（QQ 可播直链暂无稳定来源，搜出也无法播放），但注册表
 * 仍保留其实现——部署侧配 MUSIC_PLATFORM_SEARCH='{"tencent":true}' 即可随时恢复，无需改代码。
 */
import { SelfSearchError, SELF_SEARCH_FAILURE } from "./errors";
import { isPlatformSearchEnabled } from "../music-platform-flags";
import { searchNetease } from "./netease";
import { searchTencent } from "./tencent";
import { searchKugou } from "./kugou";
import { searchKuwo } from "./kuwo";
import { searchMigu } from "./migu";

/** 自研搜索完整注册的 source → 展示名（引擎开关默认值见 music-platform-flags.js） */
export const SELF_SEARCH_SOURCE_LABELS = {
  netease: "网易云音乐",
  tencent: "QQ音乐",
  kugou: "酷狗音乐",
  kuwo: "酷我音乐",
  migu: "咪咕音乐",
};

/** 自研搜索完整注册的 source 列表（GD 通道命名；启用集由平台引擎开关决定） */
export const SELF_SEARCH_SOURCE_LIST = Object.keys(SELF_SEARCH_SOURCE_LABELS);

/** 翻页安全上限：平台基本无更深的分页价值，防御极端 total 带来的空转翻页 */
export const SELF_SEARCH_PAGE_MAX = 50;

const SEARCHERS = {
  netease: searchNetease,
  tencent: searchTencent,
  kugou: searchKugou,
  kuwo: searchKuwo,
  migu: searchMigu,
};

/** provider 候选 → 统一 SearchItem（source 回填、pic 空值不输出 picUrlDirect 字段） */
function toSearchItem(candidate, source) {
  return {
    id: String(candidate.id ?? ""),
    urlId: String(candidate.urlId ?? ""),
    lyricId: String(candidate.lyricId ?? ""),
    name: String(candidate.name ?? ""),
    artist: Array.isArray(candidate.artist) ? candidate.artist.map(String) : [],
    album: String(candidate.album ?? ""),
    source,
    ...(candidate.pic ? { picUrlDirect: candidate.pic } : {}),
  };
}

/**
 * 自研搜索统一入口。
 * @returns {Promise<{ source: string, items: object[], total: number }>}
 *   items 为空数组表示「正常搜到空结果」（不是错误）。
 */
export async function selfSearch(source, keyword, page, limit) {
  const searcher = SEARCHERS[source];
  if (!searcher) {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCE_UNAVAILABLE,
      `自研搜索暂未支持该 source：${source}`
    );
  }
  if (!isPlatformSearchEnabled(source)) {
    throw new SelfSearchError(
      SELF_SEARCH_FAILURE.SOURCE_UNAVAILABLE,
      `该平台搜索引擎已停用：${source}（部署侧配置 MUSIC_PLATFORM_SEARCH 可开启）`
    );
  }
  const { items = [], total = 0 } = await searcher(keyword, page, limit);
  return {
    source,
    items: items.map((candidate) => toSearchItem(candidate, source)),
    total: Number(total) || 0,
  };
}

/**
 * 判断某源搜索结果是否还有下一页。
 * 平台带 total（网易/酷我/腾讯等）时按 total 精确算；缺失时按“回满整页且未到上限”兜底。
 */
export function hasSelfSearchNextPage({ page, limit, read, total, pageMax = SELF_SEARCH_PAGE_MAX }) {
  if (Number(total) > 0) return page * limit < Number(total);
  return read > 0 && read >= limit && page < pageMax;
}
