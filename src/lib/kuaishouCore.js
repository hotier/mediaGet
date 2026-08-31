// 共享的快手解析核心逻辑（供 Next 路由与 Cloudflare Workers 复用）

// Edge/Workers 环境不启用 DOM 解析，直接使用字符串/正则方案
async function initDOMParser() {
  return null;
}

export function formatResponse(code = 200, msg = "解析成功", data = []) {
  return {
    code,
    msg,
    data,
    platform: "kuaishou",
  };
}

class KuaishouParser {
  constructor() {
    this.headers = {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    };

    this.urlPatterns = [
      {
        // 快手短链/分享页重定向到 chenzhongtech H5 页，直接抓该页面（含作者简介与粉丝数据）
        name: "chenzhongtech-photo",
        regex: /chenzhongtech\.com\/fw\/photo\/[^?]+/,
        template: (_videoId, redirectUrl) => redirectUrl,
      },
      {
        name: "short-video",
        regex: /short-video\/([^?]+)/,
        template: (videoId) =>
          `https://www.kuaishou.com/short-video/${videoId}`,
      },
      {
        name: "photo",
        regex: /photo\/([^?]+)/,
        template: (videoId) =>
          `https://www.kuaishou.com/short-video/${videoId}`,
      },
      {
        name: "f-format",
        regex: /\/f\/([^?]+)/,
        template: (videoId, redirectUrl) => redirectUrl,
      },
      {
        name: "profile",
        regex: /profile\/([^?]+)/,
        template: (videoId, redirectUrl) => redirectUrl,
      },
      {
        name: "video",
        regex: /video\/([^?]+)/,
        template: (videoId, redirectUrl) => redirectUrl,
      },
    ];
  }

  async parse(url) {
    try {
      const redirectedUrl = await this.getRedirectedUrl(url);
      const { requestUrl } = this.parseUrl(url, redirectedUrl);
      const htmlContent = await this.fetchPageContent(requestUrl, url);
      if (!htmlContent) return null;

      const videoInfo = await this.parseVideoInfo(htmlContent);
      return videoInfo;
    } catch {
      return null;
    }
  }

  parseUrl(originalUrl, redirectedUrl) {
    let videoId = "";
    let requestUrl = redirectedUrl;
    for (const pattern of this.urlPatterns) {
      const match =
        originalUrl.match(pattern.regex) || redirectedUrl.match(pattern.regex);
      if (match) {
        videoId = match[1];
        requestUrl = pattern.template(videoId, redirectedUrl);
        break;
      }
    }
    return { requestUrl };
  }

  async getRedirectedUrl(url) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": this.headers["User-Agent"] },
        signal: AbortSignal.timeout(10000),
      });
      return response.url || url;
    } catch {
      return url;
    }
  }

  async fetchPageContent(primaryUrl, fallbackUrl) {
    let content = await this.makeRequest(primaryUrl);
    if (!content && fallbackUrl !== primaryUrl) {
      content = await this.makeRequest(fallbackUrl);
    }
    return content;
  }

  async makeRequest(url) {
    try {
      const response = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text;
    } catch {
      return null;
    }
  }

  async parseVideoInfo(htmlContent) {
    try {
      const domParser = await initDOMParser();
      if (domParser) {
        const result = await this.parseWithDOM(htmlContent, domParser);
        if (result) return result;
      }
      // 快手 H5 分享页当前把数据放在 window.INIT_STATE（键名混淆，值为明文 Apollo 缓存），
      // 直接解析该 JSON 可拿到作者/头像/统计/时长/发布时间等完整信息，优先使用。
      let result = this.parseInitState(htmlContent);
      if (result) return result;
      result = this.parseApolloStateRegex(htmlContent);
      if (result) return result;
      result = this.parseInlineJsonData(htmlContent);
      if (result) return result;
      result = this.parseWithRegexFallback(htmlContent);
      if (result) return result;
      result = this.parseWithBroadSearch(htmlContent);
      if (result) return result;
      return null;
    } catch {
      return null;
    }
  }

  parseWithDOM(htmlContent, DOMParserClass) {
    try {
      const parser = new DOMParserClass();
      const document = parser.parseFromString(htmlContent, "text/html");
      let result = this.parseApolloState(document);
      if (result) return result;
      result = this.parseScriptData(document);
      if (result) return result;
      result = this.parseMetaTags(document);
      if (result) return result;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 解析 window.INIT_STATE（快手 H5 分享页主数据源，键名被混淆、值为明文 Apollo 缓存）。
   * 可提取：视频直链 / 封面 / 文案 / 作者名 / 头像 / 点赞 / 播放 / 评论 / 分享 / 时长 / 发布时间。
   */
  parseInitState(htmlContent) {
    try {
      const marker = "window.INIT_STATE = ";
      const startIdx = htmlContent.indexOf(marker);
      if (startIdx === -1) return null;
      const braceIdx = htmlContent.indexOf("{", startIdx);
      if (braceIdx === -1) return null;
      const jsonStr = this.extractBalancedJson(htmlContent, braceIdx);
      if (!jsonStr) return null;
      let state;
      try {
        state = JSON.parse(jsonStr);
      } catch {
        try {
          state = JSON.parse(this.cleanJsonString(jsonStr));
        } catch {
          return null;
        }
      }
      const found = this.findPhotoDeep(state);
      if (!found) return null;
      const photo = found.photo;
      const videoData = this.extractVideoFromPhoto(photo);
      if (!videoData.photoUrl) return null;
      // 作者关注/粉丝/作品数：photo 缓存项顶层的 counts 与作者 ownerCount 一致
      if (found.counts && typeof found.counts === "object") {
        if (found.counts.fanCount !== undefined) {
          videoData.followerCount = found.counts.fanCount;
        }
        if (found.counts.followCount !== undefined) {
          videoData.followingCount = found.counts.followCount;
        }
        if (found.counts.photoCount !== undefined) {
          videoData.worksCount = found.counts.photoCount;
        }
      }
      // 补充作者简介：INIT_STATE 里的 userProfile 缓存含 user_text，按作者名匹配取出
      if (photo.userName) {
        const sign = this.findAuthorSign(state, photo.userName);
        if (sign) videoData.authorSign = sign;
      }
      return formatResponse(200, "解析成功", videoData);
    } catch {
      return null;
    }
  }

  /** 从起始左花括号开始，括号平衡提取完整 JSON 字符串（跳过字符串内的括号） */
  extractBalancedJson(str, startBraceIdx) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = startBraceIdx; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return str.slice(startBraceIdx, i + 1);
      }
    }
    return null;
  }

  /** 深度遍历，找「主视频 photo 对象」并携带其顶层 counts（作者关注/粉丝/作品数） */
  findPhotoDeep(obj, parent = null, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== "object") return null;
    if (
      (typeof obj.caption === "string" || typeof obj.userName === "string") &&
      obj.photoId !== undefined &&
      (obj.coverUrls || obj.mainMvUrls || obj.manifest)
    ) {
      return { photo: obj, counts: parent && parent.counts };
    }
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const result = this.findPhotoDeep(obj[key], obj, depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  /** 按作者名在 INIT_STATE 中查找 userProfile 缓存的简介（user_text），返回首个非空值 */
  findAuthorSign(state, authorName) {
    let sign = null;
    const walk = (obj, depth) => {
      if (depth > 8 || sign || !obj || typeof obj !== "object") return;
      if (
        typeof obj.user_name === "string" &&
        obj.user_name === authorName &&
        typeof obj.user_text === "string" &&
        obj.user_text.trim()
      ) {
        sign = obj.user_text.trim();
        return;
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          walk(obj[key], depth + 1);
        }
      }
    };
    walk(state, 0);
    return sign;
  }

  /** 从 photo 对象提取统一字段（返回数据里保留 photoId 供展示/调试） */
  extractVideoFromPhoto(photo) {
    const videoData = {
      source: "init-state",
      photoId: photo.photoId,
    };
    // 视频直链：mainMvUrls 优先（[{cdn,url}] 或 [url]），其次 manifest 清晰度列表（按 quality 降序）
    if (Array.isArray(photo.mainMvUrls)) {
      for (const item of photo.mainMvUrls) {
        const u = typeof item === "string" ? item : item && item.url;
        if (u && u.startsWith("http")) {
          videoData.photoUrl = u;
          break;
        }
      }
    }
    if (!videoData.photoUrl && photo.manifest) {
      const reps = [];
      if (Array.isArray(photo.manifest.adaptationSet)) {
        for (const set of photo.manifest.adaptationSet) {
          if (Array.isArray(set.representation)) reps.push(...set.representation);
        }
      }
      reps.sort((a, b) => Number(b.quality || 0) - Number(a.quality || 0));
      for (const rep of reps) {
        if (rep.url && rep.url.startsWith("http")) {
          videoData.photoUrl = rep.url;
          break;
        }
        if (
          Array.isArray(rep.backupUrl) &&
          rep.backupUrl[0] &&
          rep.backupUrl[0].startsWith("http")
        ) {
          videoData.photoUrl = rep.backupUrl[0];
          break;
        }
      }
    }
    // 封面：coverUrls 优先
    if (Array.isArray(photo.coverUrls)) {
      for (const item of photo.coverUrls) {
        const u = typeof item === "string" ? item : item && item.url;
        if (u && u.startsWith("http")) {
          videoData.coverUrl = u;
          break;
        }
      }
    } else if (typeof photo.coverUrl === "string" && photo.coverUrl.startsWith("http")) {
      videoData.coverUrl = photo.coverUrl;
    }
    // 文案 / 作者 / 头像 / 作者ID
    if (typeof photo.caption === "string") videoData.caption = photo.caption;
    if (typeof photo.userName === "string") videoData.authorName = photo.userName;
    if (typeof photo.headUrl === "string" && photo.headUrl.startsWith("http")) {
      // 快手官方页面（分享页/m.gifshow/桌面 short-video）统一使用 _s.jpg 变体；
      // 实测 _c/_b/原图变体在 uhead 资源上大量 404（之前曾尝试 _s→_c 高清化导致破图），
      // 因此保持原始 URL 不变，仅靠 CDN 备选容错。
      const primary = photo.headUrl;
      videoData.authorAvatar = primary;
      // headUrls 提供同一资源的 CDN 备选（实测部分节点如 p2-pro DNS 解析失效，需容错）。
      // 收集与主 URL 不同的备选，供图片代理按序重试。
      const fallbacks = [];
      if (Array.isArray(photo.headUrls)) {
        for (const item of photo.headUrls) {
          const u = typeof item === "string" ? item : item && item.url;
          if (u && u.startsWith("http") && u !== primary && !fallbacks.includes(u)) {
            fallbacks.push(u);
          }
        }
      }
      if (fallbacks.length) videoData.authorAvatarFallbacks = fallbacks;
    }
    if (photo.userId !== undefined) videoData.authorId = String(photo.userId);
    // 互动统计
    for (const k of ["likeCount", "viewCount", "commentCount", "shareCount", "forwardCount"]) {
      if (photo[k] !== undefined) videoData[k] = photo[k];
    }
    // 时长（毫秒）与发布时间（毫秒时间戳）
    if (photo.duration !== undefined) videoData.duration = photo.duration;
    if (photo.timestamp !== undefined) videoData.timestamp = photo.timestamp;
    return videoData;
  }

  parseApolloStateRegex(htmlContent) {
    try {
      const apolloStatePattern =
        /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})(?:\s*;|\s*<\/script>)/;
      const matches = htmlContent.match(apolloStatePattern);
      if (matches) {
        try {
          let apolloStateStr = matches[1];
          apolloStateStr = this.cleanJsonString(apolloStateStr);
          const apolloState = JSON.parse(apolloStateStr);
          const defaultClient = apolloState.defaultClient || apolloState;
          if (defaultClient) {
            const result = this.extractVideoDataFromApolloState(defaultClient);
            if (result) return result;
          }
        } catch {}
      }
      return null;
    } catch {
      return null;
    }
  }

  parseWithRegexFallback(htmlContent) {
    try {
      const regexPatterns = [
        /"photoUrl":\s*"([^"]+)"/,
        /"playUrl":\s*"([^"]+)"/,
        /"videoUrl":\s*"([^"]+)"/,
        /"mp4Url":\s*"([^"]+)"/,
        /photoUrl['"]\s*:\s*['"]([^'"]+)['"]/,
        /playUrl['"]\s*:\s*['"]([^'"]+)['"]/,
      ];
      for (const pattern of regexPatterns) {
        const match = htmlContent.match(pattern);
        if (match) {
          let videoUrl = match[1];
          videoUrl = this.cleanUrl(videoUrl);
          if (videoUrl.startsWith("http")) {
            const contextData = {
              photoUrl: videoUrl,
              source: "regex-fallback",
            };
            this.extractAdditionalInfo(htmlContent, contextData);
            return formatResponse(200, "解析成功", contextData);
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  parseApolloState(document) {
    try {
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const content = script.textContent || script.innerHTML;
        if (content.includes("__APOLLO_STATE__")) {
          const apolloStateMatch = content.match(
            /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})(?:\s*;|\s*<\/script>)/
          );
          if (apolloStateMatch) {
            try {
              const apolloStateStr = this.cleanJsonString(apolloStateMatch[1]);
              const apolloState = JSON.parse(apolloStateStr);
              const defaultClient = apolloState.defaultClient || apolloState;
              if (defaultClient) {
                const result =
                  this.extractVideoDataFromApolloState(defaultClient);
                if (result) return result;
              }
            } catch {}
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  parseScriptData(document) {
    try {
      const scripts = document.querySelectorAll("script");
      const dataPatterns = [
        {
          name: "INITIAL_STATE",
          pattern: /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
        },
        { name: "NUXT", pattern: /window\.__NUXT__\s*=\s*({[\s\S]*?});/ },
        { name: "videoDetail", pattern: /"videoDetail":\s*({[\s\S]*?})/ },
        { name: "photoInfo", pattern: /"photoInfo":\s*({[\s\S]*?})/ },
      ];
      for (const script of scripts) {
        const content = script.textContent || script.innerHTML;
        for (const { pattern } of dataPatterns) {
          const match = content.match(pattern);
          if (match) {
            try {
              const data = JSON.parse(match[1]);
              const result = this.findVideoDataDeep(data);
              if (result) return result;
            } catch {}
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  parseInlineJsonData(htmlContent) {
    try {
      const jsonPatterns = [
        { name: "photoUrl", pattern: /"photoUrl":\s*"([^"]+)"/ },
        { name: "playUrl", pattern: /"playUrl":\s*"([^"]+)"/ },
        { name: "videoUrl", pattern: /"videoUrl":\s*"([^"]+)"/ },
        { name: "mp4Url", pattern: /"mp4Url":\s*"([^"]+)"/ },
      ];
      for (const { name, pattern } of jsonPatterns) {
        const match = htmlContent.match(pattern);
        if (match) {
          let videoUrl = this.cleanUrl(match[1]);
          if (videoUrl.startsWith("http")) {
            const videoData = {
              photoUrl: videoUrl,
              source: `inline-json-${name}`,
            };
            this.extractAdditionalInfo(htmlContent, videoData);
            return formatResponse(200, "解析成功", videoData);
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  parseMetaTags(document) {
    try {
      const videoData = {};
      const metaTags = document.querySelectorAll("meta");
      for (const meta of metaTags) {
        const property =
          meta.getAttribute("property") || meta.getAttribute("name");
        const content = meta.getAttribute("content");
        if (!property || !content) continue;
        if (property === "og:video" || property === "og:video:url") {
          videoData.photoUrl = content;
        } else if (property === "og:image") {
          videoData.coverUrl = content;
        } else if (property === "og:title" || property === "og:description") {
          videoData.title = content;
        }
        if (property.includes("video") && content.startsWith("http")) {
          videoData.photoUrl = content;
        }
      }
      if (videoData.photoUrl) {
        videoData.source = "meta-tags";
        return formatResponse(200, "解析成功", videoData);
      }
      return null;
    } catch {
      return null;
    }
  }

  extractVideoDataFromApolloState(apolloState) {
    const videoKeys = Object.keys(apolloState).filter(
      (key) =>
        key.includes("Photo") || key.includes("Video") || key.includes("Detail")
    );
    for (const key of videoKeys) {
      const data = apolloState[key];
      if (data && typeof data === "object") {
        const result = this.extractVideoDataFromObject(data);
        if (result) return result;
      }
    }
    const deepResult = this.findVideoDataDeep(apolloState);
    if (deepResult) return deepResult;
    return null;
  }

  extractVideoDataFromObject(obj) {
    if (!obj || typeof obj !== "object") return null;
    const videoUrl =
      obj.photoUrl || obj.playUrl || obj.videoUrl || obj.mp4Url || obj.src;
    if (
      videoUrl &&
      typeof videoUrl === "string" &&
      videoUrl.startsWith("http")
    ) {
      const result = { photoUrl: videoUrl, source: "apollo-state-object" };
      this.mapObjectFields(obj, result);
      return formatResponse(200, "解析成功", result);
    }
    return null;
  }

  mapObjectFields(source, target) {
    const fieldMappings = {
      caption: "caption",
      title: "title",
      coverUrl: "coverUrl",
      cover: "coverUrl",
      poster: "coverUrl",
      thumbnail: "coverUrl",
      previewUrl: "coverUrl",
      name: "authorName",
      author: "author",
      headUrl: "authorAvatar",
      avatar: "avatar",
      likeCount: "likeCount",
      like: "like",
      commentCount: "commentCount",
      shareCount: "shareCount",
      playCount: "playCount",
      duration: "duration",
      createTime: "createTime",
      timestamp: "timestamp",
    };
    for (const [sourceKey, targetKey] of Object.entries(fieldMappings)) {
      if (source[sourceKey] !== undefined) {
        target[targetKey] = source[sourceKey];
      }
    }
  }

  findVideoDataDeep(obj, depth = 0) {
    if (depth > 6) return null;
    if (!obj || typeof obj !== "object") return null;
    const directResult = this.extractVideoDataFromObject(obj);
    if (directResult) return directResult;
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        try {
          const result = this.findVideoDataDeep(obj[key], depth + 1);
          if (result) return result;
        } catch {}
      }
    }
    return null;
  }

  extractAdditionalInfo(htmlContent, videoData) {
    const allImages = htmlContent.match(
      /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)(?:[^"'\s]*)?/gi
    );
    const coverPatterns = [
      /"coverUrl":\s*"([^"]+)"/,
      /"cover":\s*"([^"]+)"/,
      /"poster":\s*"([^"]+)"/,
      /"thumbnail":\s*"([^"]+)"/,
      /"previewUrl":\s*"([^"]+)"/,
      /"imageUrl":\s*"([^"]+)"/,
    ];
    for (const pattern of coverPatterns) {
      const match = htmlContent.match(pattern);
      if (match) {
        let coverUrl = this.cleanUrl(match[1]);
        if (coverUrl.startsWith("http") && this.isSimpleImageUrl(coverUrl)) {
          videoData.coverUrl = coverUrl;
          break;
        }
      }
    }
    if (!videoData.coverUrl && allImages) {
      for (const imageUrl of allImages) {
        const cleanUrl = this.cleanUrl(imageUrl);
        if (this.isKuaishouImageUrl(cleanUrl)) {
          videoData.coverUrl = cleanUrl;
          break;
        }
      }
      if (!videoData.coverUrl) {
        for (const imageUrl of allImages.slice(0, 15)) {
          const cleanUrl = this.cleanUrl(imageUrl);
          if (this.looksLikeCover(cleanUrl)) {
            videoData.coverUrl = cleanUrl;
            break;
          }
        }
      }
      if (!videoData.coverUrl && allImages.length > 0) {
        const firstImage = this.cleanUrl(allImages[0]);
        if (this.isReasonableImage(firstImage)) {
          videoData.coverUrl = firstImage;
        }
      }
    }
    const captionMatch = htmlContent.match(/"caption":\s*"([^"]+)"/);
    if (captionMatch) videoData.caption = captionMatch[1];
    const authorMatch = htmlContent.match(/"name":\s*"([^"]+)"/);
    if (authorMatch && !authorMatch[1].includes("原声"))
      videoData.authorName = authorMatch[1];
  }

  isSimpleImageUrl(url) {
    if (!url || !url.startsWith("http")) return false;
    return url.toLowerCase().match(/\.(jpg|jpeg|png|webp)/);
  }
  isKuaishouImageUrl(url) {
    if (!url || !url.startsWith("http")) return false;
    const urlLower = url.toLowerCase();
    const kuaishouDomains = ["kwimgs.com", "kwaicdn.com", "kuaishou.com"];
    const isKuaishouDomain = kuaishouDomains.some((domain) =>
      urlLower.includes(domain)
    );
    if (!isKuaishouDomain) return false;
    const excludeKeywords = [
      "icon",
      "logo",
      "button",
      "menu",
      "ui",
      "asset",
      "sprite",
    ];
    const hasExcludeKeyword = excludeKeywords.some((keyword) =>
      urlLower.includes(keyword)
    );
    return !hasExcludeKeyword;
  }
  looksLikeCover(url) {
    if (!url || !url.startsWith("http")) return false;
    const urlLower = url.toLowerCase();
    const excludeKeywords = [
      "icon",
      "logo",
      "button",
      "menu",
      "ui",
      "asset",
      "avatar",
      "user",
      "profile",
      "head",
      "background",
      "bg",
      "sprite",
      "line-up",
      "arrow",
      "close",
      "play-btn",
    ];
    const hasExcludeKeyword = excludeKeywords.some((keyword) =>
      urlLower.includes(keyword)
    );
    if (hasExcludeKeyword) return false;
    return urlLower.match(/\.(jpg|jpeg|png|webp)/);
  }
  isReasonableImage(url) {
    if (!url || !url.startsWith("http")) return false;
    const urlLower = url.toLowerCase();
    if (!urlLower.match(/\.(jpg|jpeg|png|webp)/)) return false;
    const unreasonableKeywords = [
      "data:image",
      "base64",
      "1x1",
      "pixel",
      "tracking",
    ];
    return !unreasonableKeywords.some((keyword) => urlLower.includes(keyword));
  }
  cleanJsonString(jsonStr) {
    try {
      return jsonStr
        .replace(/function\s*\([^)]*\)\s*{[^{}]*(?:{[^{}]*}[^{}]*)*}/g, "null")
        .replace(/:\s*undefined/g, ":null")
        .replace(/,\s*undefined/g, ",null")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/,\s*(?=})/g, "")
        .replace(/,\s*(?=])/g, "")
        .replace(/new\s+Date\([^)]*\)/g, "null")
        .replace(/Symbol\([^)]*\)/g, "null")
        .replace(/[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)/g, "null")
        .replace(/(['"])??([a-zA-Z0-9_]+)(['"])??:/g, '"$2":');
    } catch {
      return jsonStr;
    }
  }
  cleanUrl(url) {
    return url
      .replace(/\\u002F/g, "/")
      .replace(/\\\//g, "/")
      .replace(/\\/g, "");
  }
  isValidImageUrl(url) {
    return (
      url.startsWith("http") &&
      (url.includes(".jpg") ||
        url.includes(".jpeg") ||
        url.includes(".png") ||
        url.includes(".webp") ||
        url.includes("image") ||
        url.includes("cover") ||
        url.includes("thumb"))
    );
  }
  parseWithBroadSearch(htmlContent) {
    try {
      const broadPatterns = [
        /https?:\/\/[^"'\s]+\.(?:mp4|m3u8|flv|avi|mov|wmv|mkv)(?:[^"'\s]*)?/gi,
        /https?:\/\/[^"'\s]*(?:video|media|stream|play|cdn)[^"'\s]*\.(?:mp4|m3u8|flv)/gi,
        /https?:\/\/[^"'\s]*(?:kuaishou|kwai|ks)[^"'\s]*\.(mp4|m3u8|flv)/gi,
        /https?:\/\/[^"'\s]+(?:play|stream|video)[^"'\s]*/gi,
      ];
      for (const pattern of broadPatterns) {
        const matches = htmlContent.match(pattern);
        if (matches) {
          for (const url of matches.slice(0, 10)) {
            if (this.isValidVideoUrl(url)) {
              const videoData = { photoUrl: url, source: "broad-search" };
              this.extractAdditionalInfo(htmlContent, videoData);
              return formatResponse(200, "解析成功", videoData);
            }
          }
        }
      }
      return this.extractFromJsonFragments(htmlContent);
    } catch {
      return null;
    }
  }
  extractEnhancedInfo(htmlContent, videoData) {
    // 保留占位，核心逻辑已在 extractAdditionalInfo 覆盖
    return videoData;
  }
  isValidCoverUrl(url) {
    const lower = (url || "").toLowerCase();
    return lower.startsWith("http") && /\.(jpg|jpeg|png|webp)/.test(lower);
  }
  extractFromJsonFragments(htmlContent) {
    try {
      const jsonPatterns = [
        /\{[^{}]*"(?:photoUrl|playUrl|videoUrl|mp4Url)"[^{}]*\}/g,
        /\{[^{}]*"url":\s*"https?:\/\/[^\"]*\.(?:mp4|m3u8|flv)[^\"]*"[^{}]*\}/g,
        /\{[^{}]*"src":\s*"https?:\/\/[^\"]*\.(?:mp4|m3u8|flv)[^\"]*"[^{}]*\}/g,
      ];
      for (const pattern of jsonPatterns) {
        const matches = htmlContent.match(pattern);
        if (matches) {
          for (const jsonStr of matches.slice(0, 5)) {
            try {
              const data = JSON.parse(jsonStr);
              const videoUrl =
                data.photoUrl ||
                data.playUrl ||
                data.videoUrl ||
                data.mp4Url ||
                data.url ||
                data.src;
              if (videoUrl && this.isValidVideoUrl(videoUrl)) {
                return formatResponse(200, "解析成功", {
                  photoUrl: videoUrl,
                  source: "json-fragment",
                  ...data,
                });
              }
            } catch {}
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  isValidVideoUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!url.startsWith("http")) return false;
    const videoIndicators = [
      ".mp4",
      ".m3u8",
      ".flv",
      ".avi",
      ".mov",
      ".wmv",
      ".mkv",
      "video",
      "play",
      "stream",
      "media",
    ];
    return videoIndicators.some((indicator) =>
      url.toLowerCase().includes(indicator)
    );
  }
}

export async function parseKuaishou(url) {
  const parser = new KuaishouParser();
  return await parser.parse(url);
}
