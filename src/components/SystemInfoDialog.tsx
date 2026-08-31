"use client";

import React, { useEffect, useState } from "react";
import { X } from "lucide-react";

interface InfoItem {
  label: string;
  value: string;
}

/* ---------------- 客户端设备信息检测 ---------------- */

function detectDeviceType(ua: string): string {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    return "平板";
  }
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "手机";
  return "桌面端";
}

function detectOS(ua: string): string {
  const p = ua.toLowerCase();
  if (p.includes("windows")) {
    if (p.includes("win64") || p.includes("wow64") || p.includes("x64")) {
      return "Windows (X64)";
    }
    if (p.includes("arm64")) return "Windows (ARM64)";
    if (p.includes("win32") || p.includes("x86")) return "Windows (X86)";
    return "Windows";
  }
  if (p.includes("mac os") || p.includes("macintosh")) return "macOS";
  if (p.includes("android")) return "Android";
  if (p.includes("iphone") || p.includes("ipad") || p.includes("ipod")) {
    return "iOS";
  }
  if (p.includes("linux")) return "Linux";
  return "未知";
}

interface UABrand {
  brand: string;
  version: string;
}

type HighEntropyValues = {
  uaFullVersion?: string;
  fullVersionList?: UABrand[];
};

interface UAData {
  brands?: UABrand[];
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyValues>;
}

function detectBrowser(ua: string, uaData?: UAData): string {
  const brands = uaData?.brands ?? [];
  const has = (kw: string) =>
    brands.some((b) => b.brand.toLowerCase().includes(kw));

  // 品牌用 Client Hints 判断（准确）；版本号从 UA 对应段取完整版号
  if (has("edge")) {
    const v =
      ua.match(/edg\/([\d.]+)/i)?.[1] ?? ua.match(/chrome\/([\d.]+)/i)?.[1] ?? "";
    return v ? `Edge ${v}` : "Edge";
  }
  if (has("opera")) {
    const v = ua.match(/opr\/([\d.]+)/i)?.[1] ?? "";
    return v ? `Opera ${v}` : "Opera";
  }
  if (has("chrome") || has("chromium")) {
    const v = ua.match(/chrome\/([\d.]+)/i)?.[1] ?? "";
    return v ? `Chrome ${v}` : "Chrome";
  }

  // 非 Chromium：UA 字符串解析（Firefox / Safari 等）
  const p = ua.toLowerCase();
  const ver = (re: RegExp) => ua.match(re)?.[1] ?? "";
  if (p.includes("edg/")) return `Edge ${ver(/edg\/([\d.]+)/i)}`.trim();
  if (p.includes("opr/")) return `Opera ${ver(/opr\/([\d.]+)/i)}`.trim();
  if (p.includes("opera")) return `Opera ${ver(/opera\/([\d.]+)/i)}`.trim();
  if (p.includes("firefox")) return `Firefox ${ver(/firefox\/([\d.]+)/i)}`.trim();
  if (p.includes("chrome")) return `Chrome ${ver(/chrome\/([\d.]+)/i)}`.trim();
  if (p.includes("safari")) return `Safari ${ver(/version\/([\d.]+)/i)}`.trim();
  return "未知";
}

/**
 * 异步获取浏览器品牌 + 完整版号。
 * UA 字符串可能不含真实完整版号（如 Chrome/152.0.0.0 占位、缺 Edg/ 段），
 * 需通过 High-Entropy Client Hints（getHighEntropyValues）获取完整版号（如 152.0.4191.53）。
 */
async function detectBrowserFull(): Promise<string> {
  const ua = navigator.userAgent;
  const uaData = (navigator as Navigator & { userAgentData?: UAData })
    .userAgentData;
  const brands = uaData?.brands ?? [];
  const has = (kw: string) =>
    brands.some((b) => b.brand.toLowerCase().includes(kw));

  let brand: "Edge" | "Opera" | "Chrome" | null = null;
  if (has("edge")) brand = "Edge";
  else if (has("opera")) brand = "Opera";
  else if (has("chrome") || has("chromium")) brand = "Chrome";

  if (brand && uaData?.getHighEntropyValues) {
    try {
      const h = await uaData.getHighEntropyValues([
        "uaFullVersion",
        "fullVersionList",
      ]);
      const list = h.fullVersionList ?? [];
      const version =
        (brand === "Edge" &&
          list.find((b) => b.brand.toLowerCase().includes("edge"))?.version) ||
        (brand === "Opera" &&
          list.find((b) => /opera|opr/i.test(b.brand))?.version) ||
        (brand === "Chrome" &&
          list.find((b) => /google chrome|chromium/i.test(b.brand))?.version) ||
        h.uaFullVersion ||
        "";
      if (version) return `${brand} ${version}`;
    } catch {
      // 权限被拒或非安全上下文，回退到同步解析
    }
  }

  return detectBrowser(ua, uaData);
}

function collectDeviceInfo(): InfoItem[] {
  const ua = navigator.userAgent;
  const uaData = (
    navigator as Navigator & { userAgentData?: UAData }
  ).userAgentData;
  const isOnline = navigator.onLine;

  return [
    { label: "设备类型", value: detectDeviceType(ua) },
    { label: "操作系统", value: detectOS(ua) },
    { label: "浏览器", value: detectBrowser(ua, uaData) },
    { label: "网络状态", value: isOnline ? "在线" : "离线" },
  ];
}

/* ---------------- 公网 IP 解析器（多接口按质量择优） ---------------- */

interface IpInfo {
  ip: string;
  /** 运营商，如 "中国移动" */
  isp?: string;
  /** 归属地，如 "中国[CN] 湖北省 武汉市" */
  location?: string;
}

/** 国家代码 → 中文名（英文接口用） */
const COUNTRY_NAMES: Record<string, string> = {
  CN: "中国",
  US: "美国",
  JP: "日本",
  KR: "韩国",
  GB: "英国",
  DE: "德国",
  FR: "法国",
  CA: "加拿大",
  AU: "澳大利亚",
  SG: "新加坡",
  RU: "俄罗斯",
  IN: "印度",
  BR: "巴西",
  HK: "中国香港",
  MO: "中国澳门",
  TW: "中国台湾",
};

/** 中文国家名 → 国家代码 */
const COUNTRY_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_NAMES).map(([code, name]) => [name, code]),
);

/** 英文国家名 → 中文（英文接口兜底） */
const COUNTRY_EN_ZH: Record<string, string> = {
  China: "中国",
  "United States": "美国",
  USA: "美国",
  Japan: "日本",
  "South Korea": "韩国",
  Korea: "韩国",
  "United Kingdom": "英国",
  Germany: "德国",
  France: "法国",
  Canada: "加拿大",
  Australia: "澳大利亚",
  Singapore: "新加坡",
  Russia: "俄罗斯",
  India: "印度",
  Brazil: "巴西",
  "Hong Kong": "中国香港",
  Macau: "中国澳门",
  Macao: "中国澳门",
  Taiwan: "中国台湾",
};

/** 中国省级行政区英文/拼音 → 中文 */
const PROVINCE_EN_ZH: Record<string, string> = {
  Beijing: "北京",
  Shanghai: "上海",
  Tianjin: "天津",
  Chongqing: "重庆",
  Hebei: "河北",
  Shanxi: "山西",
  Liaoning: "辽宁",
  Jilin: "吉林",
  Heilongjiang: "黑龙江",
  Jiangsu: "江苏",
  Zhejiang: "浙江",
  Anhui: "安徽",
  Fujian: "福建",
  Jiangxi: "江西",
  Shandong: "山东",
  Henan: "河南",
  Hubei: "湖北",
  Hunan: "湖南",
  Guangdong: "广东",
  Hainan: "海南",
  Sichuan: "四川",
  Guizhou: "贵州",
  Yunnan: "云南",
  Shaanxi: "陕西",
  Gansu: "甘肃",
  Qinghai: "青海",
  Taiwan: "中国台湾",
  "Inner Mongolia": "内蒙古",
  Guangxi: "广西",
  Tibet: "西藏",
  Xizang: "西藏",
  Ningxia: "宁夏",
  Xinjiang: "新疆",
  "Hong Kong": "中国香港",
  Macau: "中国澳门",
};

/** 常用城市英文/拼音 → 中文（未匹配保留原文） */
const CITY_EN_ZH: Record<string, string> = {
  Beijing: "北京",
  Shanghai: "上海",
  Guangzhou: "广州",
  Shenzhen: "深圳",
  Chongqing: "重庆",
  Tianjin: "天津",
  Chengdu: "成都",
  Hangzhou: "杭州",
  Wuhan: "武汉",
  Nanjing: "南京",
  "Xi'an": "西安",
  Xian: "西安",
  Suzhou: "苏州",
  Qingdao: "青岛",
  Dalian: "大连",
  Xiamen: "厦门",
  Zhengzhou: "郑州",
  Changsha: "长沙",
  Shenyang: "沈阳",
  Harbin: "哈尔滨",
  Jinan: "济南",
  Hefei: "合肥",
  Fuzhou: "福州",
  Nanchang: "南昌",
  Changchun: "长春",
  Kunming: "昆明",
  Nanning: "南宁",
  Guiyang: "贵阳",
  Hohhot: "呼和浩特",
  Lanzhou: "兰州",
  Yinchuan: "银川",
  Xining: "西宁",
  Urumqi: "乌鲁木齐",
  Lhasa: "拉萨",
  Haikou: "海口",
  Taiyuan: "太原",
  Shijiazhuang: "石家庄",
  Dongguan: "东莞",
  Foshan: "佛山",
  Wuxi: "无锡",
  Ningbo: "宁波",
  Wenzhou: "温州",
  Changzhou: "常州",
  Kunshan: "昆山",
};

/** 常见运营商英文 → 中文 */
const ISP_EN_ZH: Record<string, string> = {
  "China Mobile": "中国移动",
  "China Telecom": "中国电信",
  "China Unicom": "中国联通",
};

/** 运营商中文化：已是中文原样返回，英文尝试映射 */
function normalizeIsp(isp?: string): string | undefined {
  if (!isp) return undefined;
  return ISP_EN_ZH[isp] ?? isp;
}

/** 归一化归属地：国家 省份 城市（英文接口结果自动转中文） */
function formatLocation(
  country?: string,
  code?: string,
  province?: string,
  city?: string,
): string | undefined {
  const parts: string[] = [];
  if (country) {
    parts.push(
      COUNTRY_EN_ZH[country] ?? COUNTRY_NAMES[code?.toUpperCase() ?? ""] ?? country,
    );
  }
  const prov = province ? (PROVINCE_EN_ZH[province] ?? province) : undefined;
  if (prov) parts.push(prov);
  if (city && city !== province) {
    const cit = CITY_EN_ZH[city] ?? city;
    if (cit !== prov) parts.push(cit);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

interface IpParser {
  /** 名称 */
  name: string;
  /** 是否为中文归属地接口（质量排序优先） */
  zh?: boolean;
  /** 请求地址 */
  url: string;
  /** 响应编码，默认 utf-8（pconline 为 gbk） */
  encoding?: "utf-8" | "gbk";
  /** 解析响应文本为 IpInfo，解析失败需抛错 */
  parse: (text: string) => IpInfo;
}

/** 请求并解码响应文本 */
async function fetchText(
  url: string,
  encoding: "utf-8" | "gbk" = "utf-8",
  ms = 4000,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`bad status ${res.status}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder(encoding).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

/** IP 解析器注册表：中文接口在前，英文居中，纯 IP 兜底在后 */
const IP_PARSERS: IpParser[] = [
  {
    name: "ip9.com.cn",
    zh: true,
    url: "/api/ip",
    parse: (text) => {
      const d = JSON.parse(text) as {
        ret?: number;
        data?: {
          ip?: unknown;
          country?: string;
          country_code?: string;
          prov?: string;
          city?: string;
          isp?: string;
        };
      };
      const data = d?.data;
      if (d?.ret !== 200 || typeof data?.ip !== "string" || !data.ip) {
        throw new Error("bad response");
      }
      return {
        ip: data.ip,
        isp: normalizeIsp(data.isp),
        location: formatLocation(
          data.country,
          data.country_code?.toUpperCase(),
          data.prov,
          data.city,
        ),
      };
    },
  },
  {
    name: "vore.top",
    zh: true,
    url: "https://api.vore.top/api/IPdata",
    parse: (text) => {
      const d = JSON.parse(text) as {
        data?: {
          ip?: unknown;
          info1?: { country?: string; province?: string; city?: string };
          info2?: { isp?: string };
          info3?: { country_code?: string };
        };
      };
      const data = d?.data;
      if (typeof data?.ip !== "string" || !data.ip) throw new Error("missing ip");
      return {
        ip: data.ip,
        isp: normalizeIsp(data.info2?.isp),
        location: formatLocation(
          data.info1?.country,
          data.info3?.country_code,
          data.info1?.province,
          data.info1?.city,
        ),
      };
    },
  },
  {
    name: "ip.useragentinfo.com",
    zh: true,
    url: "https://ip.useragentinfo.com/json",
    parse: (text) => {
      const d = JSON.parse(text) as {
        ip?: unknown;
        country?: string;
        province?: string;
        city?: string;
        isp?: string;
      };
      if (typeof d.ip !== "string" || !d.ip) throw new Error("missing ip");
      const code = d.country ? COUNTRY_CODES[d.country] : undefined;
      const isp = d.isp
        ? normalizeIsp(/^中国/.test(d.isp) ? d.isp : `中国${d.isp}`)
        : undefined;
      return {
        ip: d.ip,
        isp,
        location: formatLocation(d.country, code, d.province, d.city),
      };
    },
  },
  {
    name: "ip.sb",
    zh: true,
    url: "https://api.ip.sb/geoip?lang=zh-CN",
    parse: (text) => {
      const d = JSON.parse(text) as {
        ip?: unknown;
        country?: string;
        country_code?: string;
        region?: string;
        city?: string;
        isp?: string;
      };
      if (typeof d.ip !== "string" || !d.ip) throw new Error("missing ip");
      return {
        ip: d.ip,
        isp: normalizeIsp(d.isp),
        location: formatLocation(d.country, d.country_code, d.region, d.city),
      };
    },
  },
  {
    name: "ipinfo.io",
    url: "https://ipinfo.io/json",
    parse: (text) => {
      const d = JSON.parse(text) as {
        ip?: unknown;
        country?: string;
        region?: string;
        city?: string;
      };
      if (typeof d.ip !== "string" || !d.ip) throw new Error("missing ip");
      const name = d.country ? COUNTRY_NAMES[d.country.toUpperCase()] : undefined;
      return {
        ip: d.ip,
        location: formatLocation(name, d.country, d.region, d.city),
      };
    },
  },
  {
    name: "ipapi.co",
    url: "https://ipapi.co/json/",
    parse: (text) => {
      const d = JSON.parse(text) as {
        ip?: unknown;
        country_code?: string;
        country_name?: string;
        region?: string;
        city?: string;
      };
      if (typeof d.ip !== "string" || !d.ip) throw new Error("missing ip");
      const code = d.country_code?.toUpperCase();
      const name = code ? COUNTRY_NAMES[code] ?? d.country_name : d.country_name;
      return {
        ip: d.ip,
        location: formatLocation(name, code, d.region, d.city),
      };
    },
  },
  {
    name: "ipify",
    url: "https://api.ipify.org?format=json",
    parse: (text) => {
      const d = JSON.parse(text) as { ip?: unknown };
      if (typeof d.ip !== "string" || !d.ip) throw new Error("missing ip");
      return { ip: d.ip };
    },
  },
  {
    name: "jsonip",
    url: "https://jsonip.com",
    parse: (text) => {
      const d = JSON.parse(text) as { ip?: unknown };
      if (typeof d.ip !== "string" || !d.ip) throw new Error("missing ip");
      return { ip: d.ip };
    },
  },
];

async function fetchIpInfo(): Promise<IpInfo | null> {
  // 竞速返回：拿到中文归属地结果立即返回，不再等慢接口；
  // 首个普通结果给 1 秒窗口等更好的；全部失败返回 null
  return new Promise<IpInfo | null>((resolve) => {
    const candidates: { info: IpInfo; parserIndex: number }[] = [];
    let remaining = IP_PARSERS.length;
    let done = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const rank = ({
      info,
      parserIndex,
    }: {
      info: IpInfo;
      parserIndex: number;
    }): number => {
      if (info.location && IP_PARSERS[parserIndex].zh) return 0;
      if (info.location) return 1;
      return 2;
    };

    const finish = (candidate?: { info: IpInfo; parserIndex: number }) => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      resolve(candidate?.info ?? null);
    };

    IP_PARSERS.forEach((p, i) => {
      (async () => {
        try {
          const text = await fetchText(p.url, p.encoding);
          const info = p.parse(text);
          const candidate = { info, parserIndex: i };
          candidates.push(candidate);
          // 中文归属地是最优结果，立即返回
          if (rank(candidate) === 0) return finish(candidate);
          // 首个普通结果：留 1 秒窗口等待更好的中文归属地
          settleTimer ??= setTimeout(() => {
            candidates.sort((a, b) => rank(a) - rank(b));
            finish(candidates[0]);
          }, 1000);
        } catch {
          // 单个接口失败，继续等其他接口
        } finally {
          remaining -= 1;
          if (!done && remaining === 0) {
            if (candidates.length > 0) {
              candidates.sort((a, b) => rank(a) - rank(b));
              finish(candidates[0]);
            } else {
              finish();
            }
          }
        }
      })();
    });
  });
}

/* ---------------- 组件 ---------------- */

export default function SystemInfoDialog() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InfoItem[]>([]);
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipFetchedAt, setIpFetchedAt] = useState(0);

  // 客户端挂载后收集设备信息，避免服务端渲染时访问 navigator 导致水合不一致
  useEffect(() => {
    setItems(collectDeviceInfo());
    // 异步获取浏览器完整版号（High-Entropy Client Hints 才包含真实完整版号）
    detectBrowserFull().then((browser) => {
      setItems((prev) =>
        prev.map((it) =>
          it.label === "浏览器" ? { ...it, value: browser } : it,
        ),
      );
    });
  }, []);

  // 弹窗打开时异步获取公网 IP 与归属地（30 秒内缓存复用，避免频繁开关反复请求）
  useEffect(() => {
    if (!open) return;
    if (ipInfo && Date.now() - ipFetchedAt < 30_000) return;
    let cancelled = false;
    setIpLoading(true);
    fetchIpInfo()
      .then((info) => {
        if (cancelled) return;
        setIpInfo(info);
        setIpFetchedAt(Date.now());
        setIpLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setIpInfo(null);
        setIpFetchedAt(Date.now());
        setIpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, ipInfo, ipFetchedAt]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hover:text-primary transition-colors duration-200">
        本机信息
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="system-info-title">
          {/* 遮罩 */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* 弹窗卡片 */}
          <div className="relative w-full max-w-sm rounded-2xl border border-border-subtle bg-glass-2 p-5 shadow-card">
            <div className="flex items-center justify-between">
              <h3
                id="system-info-title"
                className="text-sm font-semibold text-primary">
                本机信息
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="rounded-lg p-1 text-muted transition-colors hover:bg-glass-3 hover:text-primary">
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="mt-4 space-y-2.5">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <dt className="shrink-0 text-[13px] text-muted">IP 地址</dt>
                <dd
                  className="truncate text-[13px] text-primary"
                  title={ipInfo ? `${ipInfo.ip}${ipInfo.isp ? ` ${ipInfo.isp}` : ""}` : undefined}>
                  {ipLoading
                    ? "获取中…"
                    : ipInfo
                      ? `${ipInfo.ip}${ipInfo.isp ? ` ${ipInfo.isp}` : ""}`
                      : "获取失败"}
                </dd>
              </div>
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <dt className="shrink-0 text-[13px] text-muted">归属地</dt>
                <dd className="truncate text-[13px] text-primary">
                  {ipLoading
                    ? "获取中…"
                    : ipInfo?.location ?? "未知"}
                </dd>
              </div>
              {items.map((item) => (
                <div
                  key={item.label}
                  className="flex min-w-0 items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-[13px] text-muted">{item.label}</dt>
                  <dd
                    className="truncate text-[13px] text-primary"
                    title={item.value}>
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
