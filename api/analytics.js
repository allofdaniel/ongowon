/**
 * 온고원 ONGOWON — Privacy-Safe First-Party Analytics & Funnel API
 * Route: GET / POST / DELETE /api/analytics/
 *
 * Storage:
 *  - Primary: Vercel Blob (BLOB_READ_WRITE_TOKEN) — atomic per-event blobs with
 *    compact metadata in pathname for O(1)-request aggregation (zero race conditions).
 *  - Fallback: In-memory ring buffer for local dev without BLOB_READ_WRITE_TOKEN.
 *
 * Privacy:
 *  - Zero cookies, zero IP storage, zero PII.
 *  - Ephemeral anonymous session IDs (sessionStorage) for funnel attribution only.
 */

const crypto = require('crypto');

const BLOB_API = 'https://blob.vercel-storage.com';
const BLOB_PREFIX = 'a/';
const MAX_BODY_BYTES = 4096;
const RATE_LIMIT_PER_MIN = 120;

const ALLOWED_EVENTS = {
  page_view: 'pv',
  minhwa_generate: 'mg',
  mockup_download: 'md',
  notify_signup: 'ns',
  language_switch: 'ls',
};
const CODE_TO_EVENT = Object.fromEntries(Object.entries(ALLOWED_EVENTS).map(([k, v]) => [v, k]));

const ROUTE_DEFS = {
  home: { path: '/', label: '홈 (KO)' },
  studio: { path: '/studio/', label: 'AI 민화 스튜디오' },
  wish: { path: '/wish/', label: '소원 놀이터' },
  minhwa: { path: '/minhwa/', label: '민화 소원 사전 (KO)' },
  en: { path: '/en/', label: 'Home (EN)' },
  ja: { path: '/ja/', label: 'Home (JA)' },
  en_minhwa: { path: '/en/minhwa/', label: 'Minhwa Guide (EN)' },
  ja_minhwa: { path: '/ja/minhwa/', label: '民画事典 (JA)' },
  linktree: { path: '/linktree/', label: '링크트리' },
  other: { path: '/other/', label: '기타 페이지' },
};

const CHANNEL_DEFS = {
  instagram: { label: 'Instagram', group: 'social' },
  threads: { label: 'Threads', group: 'social' },
  youtube_shorts: { label: 'YouTube Shorts', group: 'social' },
  youtube: { label: 'YouTube', group: 'social' },
  naver: { label: 'Naver', group: 'search' },
  google: { label: 'Google', group: 'search' },
  ai_chatgpt: { label: 'ChatGPT', group: 'ai_search' },
  ai_perplexity: { label: 'Perplexity', group: 'ai_search' },
  ai_gemini: { label: 'Gemini', group: 'ai_search' },
  ai_claude: { label: 'Claude', group: 'ai_search' },
  ai_other: { label: 'AI Search (기타)', group: 'ai_search' },
  kakao: { label: 'KakaoTalk / Daum', group: 'social' },
  x: { label: 'X (Twitter)', group: 'social' },
  facebook: { label: 'Facebook', group: 'social' },
  search_other: { label: '기타 검색', group: 'search' },
  utm: { label: 'UTM 캠페인', group: 'campaign' },
  referral: { label: '외부 유입 (Referral)', group: 'referral' },
  direct: { label: '직접 방문 (Direct)', group: 'direct' },
};

const BOT_RE =
  /googlebot|bingbot|yandex|baiduspider|duckduckbot|yeti|daumoa|gptbot|oai-searchbot|claudebot|claude-searchbot|perplexitybot|applebot|ahrefsbot|semrushbot|bytespider|facebookexternalhit|kakaotalk-scrap|twitterbot|slackbot|discordbot|linkedinbot|whatsapp|telegrambot|pinterest/i;

// In-memory rate limiter + dev fallback store
const rateBuckets = new Map();
const memoryEvents = [];

function getKstDate(ts = Date.now()) {
  const kst = new Date(ts + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getKstIso(ts) {
  const kst = new Date(ts + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 19).replace('T', ' ');
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

function checkRateLimit(ip) {
  const minuteKey = `${Math.floor(Date.now() / 60000)}:${ip}`;
  if (rateBuckets.size > 2000) {
    const curPrefix = `${Math.floor(Date.now() / 60000)}:`;
    for (const k of rateBuckets.keys()) {
      if (!k.startsWith(curPrefix)) rateBuckets.delete(k);
    }
  }
  const n = (rateBuckets.get(minuteKey) || 0) + 1;
  rateBuckets.set(minuteKey, n);
  return n <= RATE_LIMIT_PER_MIN;
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  const allowed =
    origin === '' ||
    origin === `https://${host}` ||
    origin === `http://${host}` ||
    origin === 'https://ongowon.com' ||
    origin === 'https://www.ongowon.com' ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Analytics-Token');
}

function sanitizeToken(val, maxLen = 28, allowDot = false) {
  if (typeof val !== 'string') return '_';
  const re = allowDot ? /[^a-z0-9._-]/g : /[^a-z0-9_-]/g;
  const cleaned = val
    .toLowerCase()
    .trim()
    .replace(re, '')
    .replace(/__+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, maxLen);
  return cleaned || '_';
}

function normalizeRoute(rawPath) {
  let p = String(rawPath || '/').split('?')[0].split('#')[0].trim().toLowerCase();
  if (!p.startsWith('/')) p = '/' + p;
  if (p !== '/' && !p.endsWith('/')) p += '/';
  if (p === '/' || p === '/index.html/') return 'home';
  if (p.startsWith('/studio/')) return 'studio';
  if (p.startsWith('/wish/')) return 'wish';
  if (p.startsWith('/minhwa/')) return 'minhwa';
  if (p === '/en/' || p === '/en/index.html/') return 'en';
  if (p === '/ja/' || p === '/ja/index.html/') return 'ja';
  if (p.startsWith('/en/minhwa/')) return 'en_minhwa';
  if (p.startsWith('/ja/minhwa/')) return 'ja_minhwa';
  if (p.startsWith('/linktree/')) return 'linktree';
  return 'other';
}

function normalizeLocale(rawLocale, routeCode) {
  const l = String(rawLocale || '').toLowerCase().trim();
  if (l === 'en' || l.startsWith('en-')) return 'en';
  if (l === 'ja' || l.startsWith('ja-')) return 'ja';
  if (l === 'ko' || l.startsWith('ko-')) return 'ko';
  if (routeCode === 'en' || routeCode === 'en_minhwa') return 'en';
  if (routeCode === 'ja' || routeCode === 'ja_minhwa') return 'ja';
  return 'ko';
}

function normalizeDevice(rawDevice) {
  const d = String(rawDevice || '').toLowerCase();
  if (d === 'mobile' || d === 'm') return 'm';
  if (d === 'tablet' || d === 't') return 't';
  return 'd';
}

function classifyTraffic({ referrer, utmSource, utmMedium, utmCampaign, utmContent }) {
  const src = String(utmSource || '').toLowerCase().trim();
  const med = String(utmMedium || '').toLowerCase().trim();
  const cnt = String(utmContent || '').toLowerCase().trim();
  const cmp = String(utmCampaign || '').toLowerCase().trim();

  let refHost = '';
  let refPath = '';
  if (typeof referrer === 'string' && referrer.trim()) {
    try {
      const u = new URL(referrer.trim());
      refHost = u.hostname.toLowerCase().replace(/^www\./, '');
      refPath = u.pathname.toLowerCase();
      if (refHost === 'ongowon.com' || refHost.endsWith('.ongowon.com')) {
        refHost = '';
        refPath = '';
      }
    } catch {
      refHost = '';
    }
  }

  // 1. Explicit UTM source takes precedence
  if (src) {
    if (/(^|[_-])(ig|insta|instagram|reels)($|[_-])/.test(src) || src.includes('instagram')) {
      return { channel: 'instagram', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('thread')) {
      return { channel: 'threads', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('short') || (src.includes('youtube') && (med.includes('short') || cnt.includes('short') || cmp.includes('short')))) {
      return { channel: 'youtube_shorts', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('youtube') || src === 'yt') {
      return { channel: 'youtube', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('naver')) {
      return { channel: 'naver', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('chatgpt') || src.includes('openai')) {
      return { channel: 'ai_chatgpt', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('perplexity')) {
      return { channel: 'ai_perplexity', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('gemini') || src.includes('bard')) {
      return { channel: 'ai_gemini', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('claude') || src.includes('anthropic')) {
      return { channel: 'ai_claude', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('google')) {
      return { channel: 'google', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('kakao') || src.includes('daum')) {
      return { channel: 'kakao', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src === 'x' || src.includes('twitter')) {
      return { channel: 'x', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    if (src.includes('facebook') || src === 'fb') {
      return { channel: 'facebook', refHost: sanitizeToken(refHost || src, 32, true) };
    }
    return { channel: 'utm', refHost: sanitizeToken(src, 32, true) };
  }

  // 2. Referrer host classification
  if (refHost) {
    if (refHost === 'instagram.com' || refHost.endsWith('.instagram.com')) {
      return { channel: 'instagram', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'threads.net' || refHost.endsWith('.threads.net') || refHost === 'threads.com' || refHost.endsWith('.threads.com')) {
      return { channel: 'threads', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'youtube.com' || refHost.endsWith('.youtube.com') || refHost === 'youtu.be') {
      const isShorts = refPath.includes('/shorts');
      return { channel: isShorts ? 'youtube_shorts' : 'youtube', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'naver.com' || refHost.endsWith('.naver.com')) {
      return { channel: 'naver', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'chatgpt.com' || refHost.endsWith('.chatgpt.com') || refHost === 'chat.openai.com' || refHost === 'openai.com') {
      return { channel: 'ai_chatgpt', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'perplexity.ai' || refHost.endsWith('.perplexity.ai')) {
      return { channel: 'ai_perplexity', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'gemini.google.com' || refHost === 'bard.google.com') {
      return { channel: 'ai_gemini', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'claude.ai' || refHost.endsWith('.claude.ai')) {
      return { channel: 'ai_claude', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'copilot.microsoft.com' || refHost === 'you.com' || refHost === 'phind.com') {
      return { channel: 'ai_other', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'google.com' || refHost.startsWith('google.') || refHost.includes('.google.')) {
      return { channel: 'google', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'kakao.com' || refHost.endsWith('.kakao.com') || refHost === 'daum.net' || refHost.endsWith('.daum.net')) {
      return { channel: 'kakao', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 't.co' || refHost === 'x.com' || refHost === 'twitter.com' || refHost.endsWith('.twitter.com')) {
      return { channel: 'x', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost === 'facebook.com' || refHost.endsWith('.facebook.com') || refHost === 'fb.com') {
      return { channel: 'facebook', refHost: sanitizeToken(refHost, 32, true) };
    }
    if (refHost.includes('bing.com') || refHost.includes('duckduckgo.com') || refHost.includes('yahoo.')) {
      return { channel: 'search_other', refHost: sanitizeToken(refHost, 32, true) };
    }
    return { channel: 'referral', refHost: sanitizeToken(refHost, 32, true) };
  }

  return { channel: 'direct', refHost: '_' };
}

function extractExtra(eventName, meta) {
  if (!meta || typeof meta !== 'object') return '_';
  if (eventName === 'minhwa_generate') {
    return sanitizeToken(String(meta.theme || ''), 20);
  }
  if (eventName === 'mockup_download') {
    const kind = meta.kind === 'raw_png' ? 'raw' : 'blanket';
    const theme = sanitizeToken(String(meta.theme || ''), 14);
    return theme !== '_' ? `${kind}-${theme}` : kind;
  }
  if (eventName === 'notify_signup') {
    const ch = sanitizeToken(String(meta.channel || meta.source || ''), 20);
    return ch;
  }
  if (eventName === 'language_switch') {
    const f = sanitizeToken(String(meta.from_lang || ''), 4);
    const t = sanitizeToken(String(meta.to_lang || ''), 4);
    if (f !== '_' && t !== '_') return `${f}-${t}`;
    return t;
  }
  return '_';
}

function getPublicConfig() {
  const ga4Id = (process.env.GA4_MEASUREMENT_ID || process.env.NEXT_PUBLIC_GA4_ID || '').trim();
  const clarityId = (process.env.CLARITY_PROJECT_ID || process.env.NEXT_PUBLIC_CLARITY_ID || '').trim();
  return { ga4Id, clarityId };
}

function extractAdminToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (req.headers['x-analytics-token']) {
    return String(req.headers['x-analytics-token']).trim();
  }
  if (req.query && typeof req.query.token === 'string') {
    return req.query.token.trim();
  }
  try {
    const u = new URL(req.url || '/', 'https://ongowon.com');
    return (u.searchParams.get('token') || '').trim();
  } catch {
    return '';
  }
}

function verifyAdminToken(req) {
  const expected = (process.env.ANALYTICS_ADMIN_TOKEN || '').trim();
  if (!expected) return { ok: false, reason: 'not_configured' };
  const provided = extractAdminToken(req);
  if (!provided) return { ok: false, reason: 'missing_token' };
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'invalid_token' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid_token' };
  return { ok: true };
}

function buildBlobPathname(rec) {
  const rand = crypto.randomBytes(2).toString('hex');
  return `${BLOB_PREFIX}${rec.date}/${rec.ts}__${rec.sid}__${rec.ev}__${rec.rt}__${rec.lc}__${rec.dv}__${rec.ch}__${rec.rh}__${rec.uc}__${rec.ex}__${rand}.json`;
}

function parseBlobPathname(pathname, url) {
  if (!pathname || !pathname.startsWith(BLOB_PREFIX)) return null;
  const rel = pathname.slice(BLOB_PREFIX.length);
  const slashIdx = rel.indexOf('/');
  if (slashIdx < 0) return null;
  const date = rel.slice(0, slashIdx);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const file = rel.slice(slashIdx + 1).replace(/\.json$/, '');
  const parts = file.split('__');
  if (parts.length < 10) return null;
  const [tsStr, sid, ev, rt, lc, dv, ch, rh, uc, ex] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !CODE_TO_EVENT[ev]) return null;
  return {
    ts,
    date,
    sid,
    ev,
    event: CODE_TO_EVENT[ev],
    rt: ROUTE_DEFS[rt] ? rt : 'other',
    lc: lc === 'en' || lc === 'ja' ? lc : 'ko',
    dv: dv === 'm' || dv === 't' ? dv : 'd',
    ch: CHANNEL_DEFS[ch] ? ch : 'direct',
    rh: rh === '_' ? '' : rh,
    uc: uc === '_' ? '' : uc,
    ex: ex === '_' ? '' : ex,
    url: url || '',
    pathname,
  };
}

async function blobPutEvent(token, rec, fullBody) {
  const pathname = buildBlobPathname(rec);
  const res = await fetch(`${BLOB_API}/${pathname}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-version': '7',
      'x-add-random-suffix': '0',
      'x-cache-control-max-age': '0',
      'content-type': 'application/json',
    },
    body: JSON.stringify(fullBody),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`blob put failed (${res.status}): ${text.slice(0, 140)}`);
  }
  const data = await res.json();
  return { pathname: data.pathname || pathname, url: data.url || '' };
}

async function blobListEvents(token, maxPages = 6) {
  const records = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ prefix: BLOB_PREFIX, limit: '1000' });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${BLOB_API}?${qs.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-version': '7',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`blob list failed (${res.status}): ${text.slice(0, 140)}`);
    }
    const json = await res.json();
    const blobs = Array.isArray(json.blobs) ? json.blobs : [];
    for (const b of blobs) {
      const parsed = parseBlobPathname(b.pathname, b.url);
      if (parsed) records.push(parsed);
    }
    if (!json.hasMore || !json.cursor) break;
    cursor = json.cursor;
  }
  return records;
}

async function blobDeleteUrls(token, urls) {
  if (!urls.length) return 0;
  let deleted = 0;
  for (let i = 0; i < urls.length; i += 100) {
    const chunk = urls.slice(i, i + 100);
    const res = await fetch(`${BLOB_API}/delete`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-api-version': '7',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls: chunk }),
    });
    if (res.ok) deleted += chunk.length;
  }
  return deleted;
}

function enumerateDates(startDate, endDate) {
  const out = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let guard = 0;
  while (cur <= end && guard < 120) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return out;
}

function aggregateRecords(allRecords, daysParam) {
  const endDate = getKstDate();
  let days = 30;
  let startDate = '';

  if (daysParam === 'all') {
    days = 'all';
    const sortedDates = allRecords.map((r) => r.date).sort();
    startDate = sortedDates[0] || endDate;
  } else {
    const parsedDays = Math.max(1, Math.min(90, Number(daysParam) || 30));
    days = parsedDays;
    startDate = getKstDate(Date.now() - (parsedDays - 1) * 24 * 60 * 60 * 1000);
  }

  const records = allRecords
    .filter((r) => r.date >= startDate && r.date <= endDate)
    .sort((a, b) => a.ts - b.ts);

  // Per-session tracking for funnel and attribution
  const allSessions = new Set();
  const studioSessions = new Set();
  const generateSessions = new Set();
  const downloadSessions = new Set();
  const signupSessions = new Set();
  const sessionFirstChannel = new Map();
  const sessionConverted = new Set();

  let pageviews = 0;
  let studioVisits = 0;
  let minhwaGenerates = 0;
  let mockupDownloads = 0;
  let notifySignups = 0;
  let languageSwitches = 0;
  let aiSearchVisits = 0;

  const dailyMap = new Map();
  for (const d of enumerateDates(startDate, endDate)) {
    dailyMap.set(d, { date: d, pageviews: 0, sessionsSet: new Set(), generates: 0, downloads: 0, signups: 0 });
  }

  const sourceMap = new Map();
  const refHostMap = new Map();
  const campaignMap = new Map();
  const routeMap = new Map();
  const localeMap = new Map();
  const deviceMap = new Map();
  const themeMap = new Map();
  const downloadKindMap = new Map();
  const langSwitchMap = new Map();

  for (const r of records) {
    if (!sessionFirstChannel.has(r.sid)) {
      sessionFirstChannel.set(r.sid, r.ch);
    }

    let dayBucket = dailyMap.get(r.date);
    if (!dayBucket) {
      dayBucket = { date: r.date, pageviews: 0, sessionsSet: new Set(), generates: 0, downloads: 0, signups: 0 };
      dailyMap.set(r.date, dayBucket);
    }
    dayBucket.sessionsSet.add(r.sid);

    if (r.ev === 'pv') {
      pageviews++;
      allSessions.add(r.sid);
      dayBucket.pageviews++;

      if (r.rt === 'studio') {
        studioVisits++;
        studioSessions.add(r.sid);
      }

      const chDef = CHANNEL_DEFS[r.ch] || CHANNEL_DEFS.direct;
      if (chDef.group === 'ai_search') aiSearchVisits++;

      // Sources
      if (!sourceMap.has(r.ch)) {
        sourceMap.set(r.ch, {
          channel: r.ch,
          label: chDef.label,
          group: chDef.group,
          visits: 0,
          sessionsSet: new Set(),
          convSessions: new Set(),
        });
      }
      const sEntry = sourceMap.get(r.ch);
      sEntry.visits++;
      sEntry.sessionsSet.add(r.sid);

      // Referrer hosts
      if (r.rh) {
        const key = `${r.rh}|${r.ch}`;
        if (!refHostMap.has(key)) {
          refHostMap.set(key, { host: r.rh, channel: r.ch, channelLabel: chDef.label, visits: 0, sessionsSet: new Set() });
        }
        const rhEntry = refHostMap.get(key);
        rhEntry.visits++;
        rhEntry.sessionsSet.add(r.sid);
      }

      // UTM campaigns
      if (r.uc) {
        const cKey = `${r.uc}|${r.rh || r.ch}`;
        if (!campaignMap.has(cKey)) {
          campaignMap.set(cKey, {
            campaign: r.uc,
            source: r.rh || chDef.label,
            channel: r.ch,
            visits: 0,
            sessionsSet: new Set(),
            convSessions: new Set(),
          });
        }
        const cEntry = campaignMap.get(cKey);
        cEntry.visits++;
        cEntry.sessionsSet.add(r.sid);
      }

      // Routes
      const rDef = ROUTE_DEFS[r.rt] || ROUTE_DEFS.other;
      if (!routeMap.has(r.rt)) {
        routeMap.set(r.rt, { route: r.rt, path: rDef.path, label: rDef.label, pageviews: 0, sessionsSet: new Set() });
      }
      const rtEntry = routeMap.get(r.rt);
      rtEntry.pageviews++;
      rtEntry.sessionsSet.add(r.sid);

      // Locales
      if (!localeMap.has(r.lc)) {
        const lLabel = r.lc === 'en' ? 'English (EN)' : r.lc === 'ja' ? '日本語 (JA)' : '한국어 (KO)';
        localeMap.set(r.lc, { locale: r.lc, label: lLabel, pageviews: 0, sessionsSet: new Set() });
      }
      const lEntry = localeMap.get(r.lc);
      lEntry.pageviews++;
      lEntry.sessionsSet.add(r.sid);

      // Devices
      deviceMap.set(r.dv, (deviceMap.get(r.dv) || 0) + 1);
    } else if (r.ev === 'mg') {
      minhwaGenerates++;
      generateSessions.add(r.sid);
      studioSessions.add(r.sid);
      allSessions.add(r.sid);
      dayBucket.generates++;
      const th = r.ex || 'unknown';
      themeMap.set(th, (themeMap.get(th) || 0) + 1);
    } else if (r.ev === 'md') {
      mockupDownloads++;
      downloadSessions.add(r.sid);
      allSessions.add(r.sid);
      dayBucket.downloads++;
      const kind = r.ex.startsWith('raw') ? 'raw_png' : 'blanket_mockup';
      downloadKindMap.set(kind, (downloadKindMap.get(kind) || 0) + 1);
    } else if (r.ev === 'ns') {
      notifySignups++;
      signupSessions.add(r.sid);
      allSessions.add(r.sid);
      sessionConverted.add(r.sid);
      dayBucket.signups++;
      // Credit conversion to channel & campaign
      const ch = sessionFirstChannel.get(r.sid) || r.ch;
      if (sourceMap.has(ch)) sourceMap.get(ch).convSessions.add(r.sid);
      if (r.uc) {
        for (const cEntry of campaignMap.values()) {
          if (cEntry.campaign === r.uc) cEntry.convSessions.add(r.sid);
        }
      }
    } else if (r.ev === 'ls') {
      languageSwitches++;
      const pair = r.ex || r.lc;
      langSwitchMap.set(pair, (langSwitchMap.get(pair) || 0) + 1);
    }
  }

  // Ensure converted sessions are also attributed to their entry source
  for (const sid of sessionConverted) {
    const ch = sessionFirstChannel.get(sid);
    if (ch && sourceMap.has(ch)) sourceMap.get(ch).convSessions.add(sid);
  }

  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
  const totalUniqueSessions = allSessions.size;

  const funnel = [
    {
      key: 'visit',
      label: '사이트 방문',
      sessions: totalUniqueSessions,
      events: pageviews,
      rateFromStart: totalUniqueSessions > 0 ? 100 : 0,
      rateFromPrev: totalUniqueSessions > 0 ? 100 : 0,
    },
    {
      key: 'studio',
      label: 'AI 민화 스튜디오 진입',
      sessions: studioSessions.size,
      events: studioVisits,
      rateFromStart: pct(studioSessions.size, totalUniqueSessions),
      rateFromPrev: pct(studioSessions.size, totalUniqueSessions),
    },
    {
      key: 'generate',
      label: 'AI 민화 생성',
      sessions: generateSessions.size,
      events: minhwaGenerates,
      rateFromStart: pct(generateSessions.size, totalUniqueSessions),
      rateFromPrev: pct(generateSessions.size, studioSessions.size),
    },
    {
      key: 'download',
      label: '담요 목업 · 원화 저장',
      sessions: downloadSessions.size,
      events: mockupDownloads,
      rateFromStart: pct(downloadSessions.size, totalUniqueSessions),
      rateFromPrev: pct(downloadSessions.size, generateSessions.size || studioSessions.size),
    },
    {
      key: 'signup',
      label: '출시 · 맞춤 알림 신청',
      sessions: signupSessions.size,
      events: notifySignups,
      rateFromStart: pct(signupSessions.size, totalUniqueSessions),
      rateFromPrev: pct(signupSessions.size, downloadSessions.size || generateSessions.size || totalUniqueSessions),
    },
  ];

  const sources = [...sourceMap.values()]
    .map((s) => ({
      channel: s.channel,
      label: s.label,
      group: s.group,
      visits: s.visits,
      sessions: s.sessionsSet.size,
      conversions: s.convSessions.size,
      sharePct: pct(s.visits, pageviews),
    }))
    .sort((a, b) => b.visits - a.visits);

  const referrers = [...refHostMap.values()]
    .map((r) => ({
      host: r.host,
      channel: r.channel,
      channelLabel: r.channelLabel,
      visits: r.visits,
      sessions: r.sessionsSet.size,
    }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 20);

  const campaigns = [...campaignMap.values()]
    .map((c) => ({
      campaign: c.campaign,
      source: c.source,
      channel: c.channel,
      visits: c.visits,
      sessions: c.sessionsSet.size,
      conversions: c.convSessions.size,
    }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 20);

  const routes = [...routeMap.values()]
    .map((r) => ({
      route: r.route,
      path: r.path,
      label: r.label,
      pageviews: r.pageviews,
      sessions: r.sessionsSet.size,
      sharePct: pct(r.pageviews, pageviews),
    }))
    .sort((a, b) => b.pageviews - a.pageviews);

  const locales = [...localeMap.values()]
    .map((l) => ({
      locale: l.locale,
      label: l.label,
      pageviews: l.pageviews,
      sessions: l.sessionsSet.size,
      sharePct: pct(l.pageviews, pageviews),
    }))
    .sort((a, b) => b.pageviews - a.pageviews);

  const devLabels = { m: '모바일', t: '태블릿', d: '데스크톱' };
  const devices = ['m', 'd', 't']
    .map((k) => ({
      device: k,
      label: devLabels[k],
      count: deviceMap.get(k) || 0,
      sharePct: pct(deviceMap.get(k) || 0, pageviews),
    }))
    .filter((d) => d.count > 0);

  const themeNames = {
    sipjangsaeng: '십장생도 (건강·장수)',
    morando: '모란도 (부귀·풍요)',
    yangnido: '약리도 (등용문·지혜)',
    chaekgado: '책가도 (학문·총명)',
    jogakbo: '색동조각보 (오복·이음)',
  };
  const studioThemes = [...themeMap.entries()]
    .map(([id, count]) => ({ id, label: themeNames[id] || id, count }))
    .sort((a, b) => b.count - a.count);

  const downloadKinds = [
    { kind: 'blanket_mockup', label: '95×95cm 담요 목업', count: downloadKindMap.get('blanket_mockup') || 0 },
    { kind: 'raw_png', label: '민화 원화 PNG', count: downloadKindMap.get('raw_png') || 0 },
  ].filter((x) => x.count > 0);

  const languageSwitchPairs = [...langSwitchMap.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count);

  const daily = [...dailyMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      pageviews: d.pageviews,
      sessions: d.sessionsSet.size,
      generates: d.generates,
      downloads: d.downloads,
      signups: d.signups,
    }));

  const recent = records
    .slice(-40)
    .reverse()
    .map((r) => ({
      ts: r.ts,
      kstTime: getKstIso(r.ts),
      event: r.event,
      route: r.rt,
      path: (ROUTE_DEFS[r.rt] || ROUTE_DEFS.other).path,
      locale: r.lc,
      channel: r.ch,
      channelLabel: (CHANNEL_DEFS[r.ch] || CHANNEL_DEFS.direct).label,
      refHost: r.rh,
      utmCampaign: r.uc,
      extra: r.ex,
      device: devLabels[r.dv] || '데스크톱',
      sid: r.sid,
    }));

  return {
    days,
    startDate,
    endDate,
    totalEvents: records.length,
    kpis: {
      pageviews,
      uniqueSessions: totalUniqueSessions,
      studioVisits,
      minhwaGenerates,
      mockupDownloads,
      notifySignups,
      languageSwitches,
      aiSearchVisits,
      visitToSignupRate: pct(signupSessions.size, totalUniqueSessions),
      studioToGenerateRate: pct(generateSessions.size, studioSessions.size),
      generateToDownloadRate: pct(downloadSessions.size, generateSessions.size),
    },
    funnel,
    daily,
    sources,
    referrers,
    campaigns,
    routes,
    locales,
    devices,
    studioThemes,
    downloadKinds,
    languageSwitchPairs,
    recent,
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const blobToken = (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
  const publicConfig = getPublicConfig();

  // --- POST: Ingest event ---
  if (req.method === 'POST') {
    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const ua = String(req.headers['user-agent'] || '');
    if (BOT_RE.test(ua)) {
      return res.status(200).json({ ok: true, ignored: 'bot', config: publicConfig });
    }

    let body = req.body;
    if (typeof body === 'string') {
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ ok: false, error: 'payload_too_large' });
      }
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ ok: false, error: 'invalid_json' });
      }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'invalid_body' });
    }

    const eventName = String(body.event || '').trim();
    const evCode = ALLOWED_EVENTS[eventName];
    if (!evCode) {
      return res.status(400).json({ ok: false, error: 'unsupported_event' });
    }

    const rawPath = String(body.path || '/').slice(0, 120);
    if (rawPath.startsWith('/admin')) {
      return res.status(200).json({ ok: true, ignored: 'admin', config: publicConfig });
    }

    const ts = Date.now();
    const date = getKstDate(ts);
    const rt = normalizeRoute(rawPath);
    const lc = normalizeLocale(body.locale, rt);
    const dv = normalizeDevice(body.device);
    const sidRaw = sanitizeToken(String(body.sid || ''), 12);
    const sid = sidRaw !== '_' ? sidRaw : crypto.randomBytes(4).toString('hex');

    const { channel, refHost } = classifyTraffic({
      referrer: body.referrer,
      utmSource: body.utm_source,
      utmMedium: body.utm_medium,
      utmCampaign: body.utm_campaign,
      utmContent: body.utm_content,
    });
    const uc = sanitizeToken(String(body.utm_campaign || ''), 28);
    const ex = extractExtra(eventName, body.meta);

    const rec = {
      ts,
      date,
      sid,
      ev: evCode,
      event: eventName,
      rt,
      lc,
      dv,
      ch: channel,
      rh: refHost,
      uc,
      ex,
    };

    const fullBody = {
      ts,
      date,
      event: eventName,
      route: rt,
      path: (ROUTE_DEFS[rt] || ROUTE_DEFS.other).path,
      locale: lc,
      device: dv,
      sid,
      channel,
      refHost: refHost === '_' ? '' : refHost,
      utmSource: String(body.utm_source || '').slice(0, 60),
      utmMedium: String(body.utm_medium || '').slice(0, 60),
      utmCampaign: String(body.utm_campaign || '').slice(0, 80),
      utmContent: String(body.utm_content || '').slice(0, 80),
      extra: ex === '_' ? '' : ex,
    };

    try {
      let storage = 'memory';
      if (blobToken) {
        await blobPutEvent(blobToken, rec, fullBody);
        storage = 'vercel_blob';
      } else {
        memoryEvents.push({
          ...rec,
          rh: rec.rh === '_' ? '' : rec.rh,
          uc: rec.uc === '_' ? '' : rec.uc,
          ex: rec.ex === '_' ? '' : rec.ex,
        });
        if (memoryEvents.length > 2000) memoryEvents.shift();
      }

      return res.status(200).json({
        ok: true,
        storage,
        event: eventName,
        route: rt,
        channel,
        config: publicConfig,
      });
    } catch (err) {
      console.error('[analytics] write error:', err);
      return res.status(500).json({ ok: false, error: 'storage_error' });
    }
  }

  // --- GET: Public non-secret config OR Protected summary ---
  if (req.method === 'GET') {
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'https://ongowon.com');
    } catch {
      urlObj = new URL('/', 'https://ongowon.com');
    }

    if (urlObj.searchParams.get('config') === '1') {
      return res.status(200).json({ ok: true, ...publicConfig });
    }

    const auth = verifyAdminToken(req);
    if (!auth.ok) {
      const status = auth.reason === 'not_configured' ? 503 : 401;
      return res.status(status).json({
        ok: false,
        error: auth.reason,
        message:
          auth.reason === 'not_configured'
            ? 'ANALYTICS_ADMIN_TOKEN 환경변수가 설정되지 않았습니다.'
            : '유효한 관리자 토큰이 필요합니다.',
      });
    }

    const daysParam = urlObj.searchParams.get('days') || '30';

    try {
      const storage = blobToken ? 'vercel_blob' : 'memory';
      const allRecords = blobToken ? await blobListEvents(blobToken) : memoryEvents;
      const summary = aggregateRecords(allRecords, daysParam);

      return res.status(200).json({
        ok: true,
        meta: {
          generatedAt: new Date().toISOString(),
          generatedAtKst: getKstIso(Date.now()),
          timezone: 'Asia/Seoul',
          storage,
          ga4Configured: Boolean(publicConfig.ga4Id),
          clarityConfigured: Boolean(publicConfig.clarityId),
        },
        ...summary,
      });
    } catch (err) {
      console.error('[analytics] read error:', err);
      return res.status(500).json({ ok: false, error: 'read_error', message: '분석 데이터를 불러오지 못했습니다.' });
    }
  }

  // --- DELETE: Admin cleanup for synthetic test sessions (?sid=...) ---
  if (req.method === 'DELETE') {
    const auth = verifyAdminToken(req);
    if (!auth.ok) {
      return res.status(401).json({ ok: false, error: auth.reason });
    }
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'https://ongowon.com');
    } catch {
      urlObj = new URL('/', 'https://ongowon.com');
    }
    const targetSid = sanitizeToken(urlObj.searchParams.get('sid') || '', 12);
    if (targetSid === '_') {
      return res.status(400).json({ ok: false, error: 'sid_required' });
    }

    try {
      if (blobToken) {
        const all = await blobListEvents(blobToken);
        const urls = all.filter((r) => r.sid === targetSid && r.url).map((r) => r.url);
        const deleted = await blobDeleteUrls(blobToken, urls);
        return res.status(200).json({ ok: true, deleted, sid: targetSid });
      }
      const before = memoryEvents.length;
      for (let i = memoryEvents.length - 1; i >= 0; i--) {
        if (memoryEvents[i].sid === targetSid) memoryEvents.splice(i, 1);
      }
      return res.status(200).json({ ok: true, deleted: before - memoryEvents.length, sid: targetSid });
    } catch (err) {
      console.error('[analytics] delete error:', err);
      return res.status(500).json({ ok: false, error: 'delete_error' });
    }
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
};
