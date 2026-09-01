import { logger, getCorsHeaders } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * 主接口：ip9.com.cn
 * 返回 {ret, data:{ip, country, country_code, prov, city, isp}}
 */
async function fetchIp9() {
  const res = await fetch("https://ip9.com.cn/get", {
    signal: AbortSignal.timeout(4000),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`ip9.com.cn bad status ${res.status}`);
  const json = await res.json();
  const d = json?.data;
  if (!d?.ip) throw new Error("ip9.com.cn missing ip");
  return {
    ip: d.ip,
    country: d.country,
    country_code: d.country_code,
    prov: d.prov,
    city: d.city,
    isp: d.isp,
  };
}

/** 从 pconline 的 addr（如 "浙江省湖州市 电信"）中提取运营商 */
function extractIspFromAddr(addr, pro, city) {
  if (!addr) return undefined;
  let rest = addr;
  if (pro && rest.includes(pro)) rest = rest.split(pro).join("");
  if (city && rest.includes(city)) rest = rest.split(city).join("");
  const isp = rest.replace(/[\s，,、]+/g, "").trim();
  return isp || undefined;
}

/** pconline 运营商缩写 → 全称 */
const ISP_NORMALIZE = {
  电信: "中国电信",
  联通: "中国联通",
  移动: "中国移动",
  移通: "中国移动",
  铁通: "中国铁通",
};

function normalizeIsp(isp) {
  if (!isp) return undefined;
  return ISP_NORMALIZE[isp] ?? isp;
}

/**
 * 从纯 IP 接口获取用户公网 IP（服务端请求，无 CORS）
 * 用于 ip9 失败时携带 IP 查询 pconline，保证返回的是用户设备归属地而非服务器归属地。
 * 两个接口并发竞速，任一成功立即返回；均失败（3s 超时/非 200/缺 ip）抛错。
 */
async function fetchPublicIp() {
  const attempts = [
    "https://api.ipify.org?format=json",
    "https://jsonip.com",
  ].map((url) =>
    (async () => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(3000),
          headers: { "User-Agent": UA },
        });
        if (!res.ok) return null;
        const d = await res.json();
        return typeof d?.ip === "string" && d.ip ? d.ip : null;
      } catch {
        return null;
      }
    })(),
  );
  const ip = await firstNonNull(attempts);
  if (!ip) throw new Error("cannot get public ip");
  return ip;
}

/** 并发竞速：返回第一个 resolve 为非空值的结果，全部失败返回 undefined */
function firstNonNull(promises) {
  return new Promise((resolve) => {
    let left = promises.length;
    if (left === 0) {
      resolve(undefined);
      return;
    }
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => {
          if (v) resolve(v);
          else if (--left === 0) resolve(undefined);
        },
        () => {
          if (--left === 0) resolve(undefined);
        },
      );
    }
  });
}

/**
 * 降级接口：pconline（太平洋网络），携带用户 IP 查询
 * 返回 {ip, pro, city, addr}，编码为 GBK，需手动解码
 */
async function fetchPconline(ip) {
  const url = `https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(4000),
    headers: {
      "User-Agent": UA,
      Referer: "https://whois.pconline.com.cn/",
    },
  });
  if (!res.ok) throw new Error(`pconline bad status ${res.status}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const d = JSON.parse(text);
  if (!d?.ip) throw new Error("pconline missing ip");
  return {
    ip: d.ip,
    country: "中国",
    country_code: "cn",
    prov: d.pro,
    city: d.city,
    isp: normalizeIsp(extractIspFromAddr(d.addr, d.pro, d.city)),
  };
}

/**
 * 从代理平台透传的请求头中提取真实客户端 IP。
 * Vercel 设 x-forwarded-for / x-real-ip，Cloudflare 设 cf-connecting-ip；
 * 均取最靠前的地址（最接近客户端的 IP）。
 */
function getClientIp(request) {
  const headers = request?.headers;
  if (!headers) return null;
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const ip = forwarded.split(",")[0]?.trim();
    if (ip) return ip;
  }
  return null;
}

// 公网 IP 归属地查询代理（服务端转发，规避 CORS）
export async function GET(request) {
  const corsHeaders = getCorsHeaders(request?.headers?.get("origin") || "");

  // 优先从代理头取真实客户端 IP（Vercel / Cloudflare 等平台会在边缘设置）
  const clientIp = getClientIp(request);

  try {
    let data;
    if (clientIp) {
      // 拿到用户真实 IP，直接按 IP 查询归属地，避免查到服务器出口 IP（如 Vercel 美国节点）
      data = await fetchPconline(clientIp);
    } else {
      // 无代理头（如本地开发直连），服务端请求 ip9 返回的即用户出口 IP
      try {
        data = await fetchIp9();
      } catch (error) {
        logger.warn("ip9.com.cn failed, fallback to pconline:", error?.message || "unknown");
        // 先用纯 IP 接口拿到公网 IP，再带 IP 查询归属地
        const ip = await fetchPublicIp();
        data = await fetchPconline(ip);
      }
    }

    return Response.json(
      { ret: 200, data },
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (error) {
    // 降级链全部失败属预期路径（外网接口不可达时），用 warn 而非 error，避免刷屏
    logger.warn("IP proxy failed:", error?.message || "unknown error");

    return Response.json(
      { ret: 500, message: "ip query failed" },
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  }
}
