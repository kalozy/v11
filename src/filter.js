const HEADLESS_PATTERNS = [
  'headlesschrome', 'phantomjs', 'puppeteer', 'selenium', 'webdriver',
  'htmlunit', 'slimerjs', 'nightmare', 'playwright', 'cypress',
  'jsdom', 'zombie', 'mechanize', 'wget', 'curl/', 'python-requests',
  'go-http-client', 'java/', 'okhttp', 'axios/', 'node-fetch',
  'libwww-perl', 'lwp-trivial', 'ruby', 'scrapy', 'httpclient',
];

const KNOWN_BOTS = [
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
  'yandexbot', 'sogou', 'exabot', 'facebot', 'facebookexternalhit',
  'ia_archiver', 'mj12bot', 'ahrefsbot', 'semrushbot', 'dotbot',
  'rogerbot', 'linkdexbot', 'xovibot', 'sistrix', 'seznambot',
  'blexbot', 'applebot', 'petalbot', 'bytespider', 'gptbot',
  'chatgpt-user', 'claudebot', 'anthropic-ai', 'ccbot',
  'amazonbot', 'pinterestbot', 'twitterbot', 'linkedinbot',
  'discordbot', 'slackbot', 'telegrambot', 'whatsapp',
  'archive.org_bot', 'heritrix', 'wget/', 'libwww',
  // Ad platform review bots
  'adsbot-google', 'google-read-aloud', 'googleother', 'google-inspectiontool',
  'google-adwords-instant', 'google-adwords', 'google ads',
  'meta-externalagent', 'facebookcatalog', 'facebookbot',
  'tiktok-page-bot', 'tiktok-eu-bot',
  'snapchat', 'snap ads', 'pinterest ads',
];

// ISPs that belong to ad platforms — real human users never browse from these
const AD_PLATFORM_ISPS = [
  'meta platforms', 'facebook, inc',
  'google llc', 'google cloud',
  'bytedance',
  'amazon.com, inc', 'amazon technologies', 'amazon data services',
  'twitter inc', 'x corp',
  'snap inc',
  'pinterest',
  'microsoft corporation', 'microsoft azure',
  'apple inc',
  'tencent', 'alibaba',
];

const SPY_TOOLS = [
  'adspy', 'bigspy', 'poweradspy', 'adplexity', 'anstrex',
  'adbeat', 'whatrunswhere', 'spyfu', 'moat/', 'adbeat',
  'facebook ads library', 'adspotyai', 'advertiserai',
  'magicadz', 'dropispy', 'ecomhunt', 'minea',
];

/**
 * Evaluate campaign filters against visitor data.
 * Returns { approved: boolean, reason: string | null }
 */
function evaluate(filters, geoData, uaData, queryParams = {}, headers = {}) {
  if (!filters || typeof filters !== 'object') {
    return { approved: true, reason: null };
  }

  const ua = (headers['user-agent'] || '').toLowerCase();
  const lang = (headers['accept-language'] || '').toLowerCase();

  // ── Security token check ─────────────────────────────────────────────────
  if (filters.token_param && filters.token_param.trim()) {
    const name     = filters.token_param.trim();
    const expected = filters.token_value ? filters.token_value.trim() : '';
    const actual   = queryParams[name];

    if (actual === undefined || actual === null || actual === '') {
      return { approved: false, reason: 'missing_token' };
    }
    if (expected && actual !== expected) {
      return { approved: false, reason: 'invalid_token' };
    }
  }

  // ── Empty User Agent ─────────────────────────────────────────────────────
  if (filters.block_empty_ua && !ua.trim()) {
    return { approved: false, reason: 'empty_user_agent' };
  }

  // ── No Accept-Language ───────────────────────────────────────────────────
  if (filters.block_no_language && !lang.trim()) {
    return { approved: false, reason: 'no_accept_language' };
  }

  // ── Headless / automation browsers ───────────────────────────────────────
  if (filters.block_headless) {
    for (const pattern of HEADLESS_PATTERNS) {
      if (ua.includes(pattern)) {
        return { approved: false, reason: `headless:${pattern}` };
      }
    }
  }

  // ── Known crawlers & bots ─────────────────────────────────────────────────
  if (filters.block_known_bots) {
    for (const bot of KNOWN_BOTS) {
      if (ua.includes(bot)) {
        return { approved: false, reason: `bot:${bot}` };
      }
    }
  }

  // ── Ad spy tools ──────────────────────────────────────────────────────────
  if (filters.block_spy_tools) {
    for (const tool of SPY_TOOLS) {
      if (ua.includes(tool)) {
        return { approved: false, reason: `spy:${tool}` };
      }
    }
  }

  // ── No referrer ───────────────────────────────────────────────────────────
  if (filters.block_no_referrer) {
    const ref = (headers['referer'] || headers['referrer'] || '').trim();
    if (!ref) {
      return { approved: false, reason: 'no_referrer' };
    }
  }

  // ── Ad platform ISPs (Facebook, Google, ByteDance, etc.) ─────────────────
  if (filters.block_ad_platform_isps) {
    const isp = (geoData.isp || '').toLowerCase();
    for (const platform of AD_PLATFORM_ISPS) {
      if (isp.includes(platform)) {
        return { approved: false, reason: `ad_platform_isp:${geoData.isp}` };
      }
    }
  }

  // ── Geo ───────────────────────────────────────────────────────────────────
  const country = (geoData.country || 'XX').toUpperCase();

  if (Array.isArray(filters.allowed_countries) && filters.allowed_countries.length > 0) {
    const allowed = filters.allowed_countries.map(c => c.toUpperCase());
    if (!allowed.includes(country)) {
      return { approved: false, reason: `country_not_allowed:${country}` };
    }
  }

  if (Array.isArray(filters.blocked_countries) && filters.blocked_countries.length > 0) {
    const blocked = filters.blocked_countries.map(c => c.toUpperCase());
    if (blocked.includes(country)) {
      return { approved: false, reason: `country_blocked:${country}` };
    }
  }

  // ── Proxy / VPN / datacenter ──────────────────────────────────────────────
  if (filters.block_proxy && geoData.proxy) {
    return { approved: false, reason: 'proxy_detected' };
  }
  if (filters.block_vpn && geoData.vpn) {
    return { approved: false, reason: 'vpn_detected' };
  }
  if (filters.block_datacenter && geoData.hosting) {
    return { approved: false, reason: 'datacenter_detected' };
  }

  // ── OS filters ────────────────────────────────────────────────────────────
  const os = (uaData.os || '').toLowerCase();

  if (Array.isArray(filters.allowed_os) && filters.allowed_os.length > 0) {
    const allowedOs = filters.allowed_os.map(o => o.toLowerCase());
    if (!allowedOs.some(o => os.includes(o))) {
      return { approved: false, reason: `os_not_allowed:${uaData.os}` };
    }
  }

  if (Array.isArray(filters.blocked_os) && filters.blocked_os.length > 0) {
    const blockedOs = filters.blocked_os.map(o => o.toLowerCase());
    if (blockedOs.some(o => os.includes(o))) {
      return { approved: false, reason: `os_blocked:${uaData.os}` };
    }
  }

  // ── Device filters ────────────────────────────────────────────────────────
  const device = (uaData.device || '').toLowerCase();

  if (Array.isArray(filters.allowed_devices) && filters.allowed_devices.length > 0) {
    const allowedDev = filters.allowed_devices.map(d => d.toLowerCase());
    if (!allowedDev.includes(device)) {
      return { approved: false, reason: `device_not_allowed:${uaData.device}` };
    }
  }

  if (Array.isArray(filters.blocked_devices) && filters.blocked_devices.length > 0) {
    const blockedDev = filters.blocked_devices.map(d => d.toLowerCase());
    if (blockedDev.includes(device)) {
      return { approved: false, reason: `device_blocked:${uaData.device}` };
    }
  }

  return { approved: true, reason: null };
}

module.exports = { evaluate };
