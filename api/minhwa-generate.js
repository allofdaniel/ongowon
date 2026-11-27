/**
 * 온고원 AI 소원 민화 스튜디오 (Ongowon Minhwa AI Studio) Serverless API
 * Route: GET / POST /api/minhwa-generate
 *
 * Uses BizRouter API (BIZROUTER_API_KEY) with Google Gemini models:
 *  - Image: google/gemini-2.5-flash-image (fallback: google/gemini-3.1-flash-image)
 *  - Text : google/gemini-2.5-flash (structured Korean iconography + wish postcard copy)
 * Also supports direct GEMINI_API_KEY fallback if configured without BIZROUTER_API_KEY.
 */

const BIZROUTER_BASE = 'https://api.bizrouter.ai/v1';
const IMAGE_MODELS = (process.env.BIZROUTER_IMAGE_MODELS || 'google/gemini-2.5-flash-image,google/gemini-3.1-flash-image')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TEXT_MODEL = process.env.BIZROUTER_TEXT_MODEL || 'google/gemini-2.5-flash';

const DAILY_LIMIT = Math.max(1, Math.min(20, Number(process.env.MINHWA_DAILY_LIMIT || 5)));
const ATTEMPT_TIMEOUT_MS = 38000;

// In-memory per-IP daily quota store (best-effort within serverless instance lifetime)
const dailyUsage = new Map();

function getKstDateString() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return String(fwd).split(',')[0].trim() || 'unknown';
}

function getQuotaStatus(ip) {
  const today = getKstDateString();
  const key = `${today}:${ip}`;
  const used = dailyUsage.get(key) || 0;
  return {
    date: today,
    limit: DAILY_LIMIT,
    used,
    remaining: Math.max(0, DAILY_LIMIT - used),
  };
}

function consumeQuota(ip) {
  const today = getKstDateString();
  if (dailyUsage.size > 4000) {
    for (const k of dailyUsage.keys()) {
      if (!k.startsWith(today)) dailyUsage.delete(k);
    }
  }
  const key = `${today}:${ip}`;
  const used = (dailyUsage.get(key) || 0) + 1;
  dailyUsage.set(key, used);
  return {
    date: today,
    limit: DAILY_LIMIT,
    used,
    remaining: Math.max(0, DAILY_LIMIT - used),
  };
}

const THEMES = {
  sipjangsaeng: {
    id: 'sipjangsaeng',
    name: '십장생도',
    hanja: '十長生圖',
    wish: '건강 · 무병장수',
    shortDesc: '백학·소나무·해·구름·불로초가 어우러진 영원한 건강의 소원',
    motifsEn: 'a gentle young red-crowned white crane standing beneath an arching Korean red pine tree with soft needles, pastel curling auspicious clouds, a soft coral rising sun, gentle celadon hills, and delicate lingzhi herbs',
    historicalContext:
      '해·구름·산·물·바위·학·사슴·거북·소나무·불로초처럼 오래 사는 열 가지 자연물을 한 폭에 모아, 아이가 병치레 없이 건강하고 오래 살기를 기원하던 조선의 대표 길상화입니다.',
    defaultWish: '아침 해 아래 소나무와 백학처럼 늘 맑고 건강하게 자라기를',
    citations: [
      {
        grade: '사전',
        label: '[출처 : 십장생도 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0034032',
      },
      {
        grade: '사전',
        label: '[출처 : 길상도 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0008538',
      },
    ],
    palette: [
      { name: '연지홍', hex: '#D88A7E', note: '아침 해 · 학 정수리 포인트' },
      { name: '송화청록', hex: '#8DA99D', note: '소나무 · 불로초' },
      { name: '쪽빛하늘', hex: '#9AB3CC', note: '오색 구름 · 맑은 물결' },
      { name: '한지미색', hex: '#F6F1E6', note: '저염료 여백 원단 바탕' },
    ],
  },
  morando: {
    id: 'morando',
    name: '모란도',
    hanja: '牡丹圖',
    wish: '부귀 · 풍요 · 화목',
    shortDesc: '꽃 중의 왕 모란과 나비가 전하는 넉넉하고 행복한 삶',
    motifsEn: 'lush blooming pastel blush-pink and cream-apricot Korean peonies with layered delicate petals, muted celadon-sage leaves, a gentle pair of pale butter-yellow butterflies, and a soft scholarly garden rock',
    historicalContext:
      '모란은 크고 화려한 자태 때문에 "꽃 중의 왕(花王)"으로 불리며 조선 왕실과 민가에서 부귀·풍요·화목의 상징으로 사랑받았습니다. 아기에게 넉넉하고 따뜻한 복이 깃들기를 바라는 그림입니다.',
    defaultWish: '활짝 핀 모란 꽃밭처럼 넉넉하고 사랑받는 날들이 가득하기를',
    citations: [
      {
        grade: '사전',
        label: '[출처 : 길상도 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0008538',
      },
      {
        grade: '박물관',
        label: "[출처 : 국립고궁박물관 '안녕, 모란' 특별전 소개 (서울신문)]",
        url: 'https://m.seoul.co.kr/news/2021/07/22/20210722023001',
      },
    ],
    palette: [
      { name: '모란연분홍', hex: '#E6B8B3', note: '만개한 모란 꽃잎' },
      { name: '주홍낙관', hex: '#C97A6B', note: '꽃술 · 꽃봉오리' },
      { name: '청자비취', hex: '#9EB2A3', note: '모란 잎사귀' },
      { name: '치자미색', hex: '#EFE2C2', note: '꽃심 · 나비' },
    ],
  },
  yangnido: {
    id: 'yangnido',
    name: '약리도',
    hanja: '躍鯉圖',
    wish: '등용문 · 지혜 · 성취',
    shortDesc: '푸른 물결을 박차고 오르는 황금 잉어와 연꽃의 등용문 이야기',
    motifsEn: 'a charming warm golden-apricot carp leaping gracefully upward above layered pastel indigo ocean waves with delicate white sea foam, framed by soft blush-pink lotus blossoms, celadon lotus pads, and a gentle pale coral sun',
    historicalContext:
      '황하 상류 용문(龍門)의 거센 물결을 뛰어넘은 잉어가 용이 되었다는 등용문 고사에서 유래한 민화입니다. 아이가 어떤 관문도 지혜롭고 씩씩하게 넘어 큰 뜻을 펼치기를 바라는 마음을 담았습니다.',
    defaultWish: '푸른 바다를 힘차게 헤엄치는 황금 잉어처럼 건강하고 지혜롭게',
    citations: [
      {
        grade: '사전',
        label: '[출처 : 약리도 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0035303',
      },
      {
        grade: '박물관',
        label: '[출처 : 메트로폴리탄 미술관 소장 〈Dragon and Carp〉(19세기 후반, CC0)]',
        url: 'https://www.metmuseum.org/art/collection/search/853892',
      },
    ],
    palette: [
      { name: '황금살구', hex: '#E5A979', note: '황금 잉어 비늘' },
      { name: '쪽빛물결', hex: '#8BA5C4', note: '푸른 바다 · 청파' },
      { name: '연꽃분홍', hex: '#E9C6C2', note: '연꽃 봉오리' },
      { name: '연엽청록', hex: '#95AEA2', note: '연잎 · 연밥' },
    ],
  },
  chaekgado: {
    id: 'chaekgado',
    name: '책가도',
    hanja: '冊架圖',
    wish: '학문 · 총명 · 실력',
    shortDesc: '서책·청화백자·문방사우에 담긴 총명함과 배움의 기쁨',
    motifsEn: 'an airy Joseon wooden scholar bookshelf arranged neatly with pastel thread-bound Korean books, a soft white Joseon moon jar, a pale indigo-and-white porcelain vase with a single plum blossom branch, calligraphy brushes, and a small peach and pomegranate',
    historicalContext:
      '18세기 후반 문치(文治)를 꿈꾼 정조의 구상에서 비롯되어 19세기 민가로 확산된 대표 민화입니다. 서책과 문방사우, 길상 과일을 정갈하게 배치해 아이의 총명함과 깊은 실력을 기원했습니다.',
    defaultWish: '호기심 가득한 눈빛으로 세상을 배우며 지혜롭고 단단하게 자라기를',
    citations: [
      {
        grade: '사전',
        label: '[출처 : 책가도 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0055679',
      },
      {
        grade: '박물관',
        label: '[출처 : 메트로폴리탄 미술관 소장 〈Books and Scholarly Accoutrements〉(19세기, CC0)]',
        url: 'https://www.metmuseum.org/art/collection/search/853896',
      },
    ],
    palette: [
      { name: '청화쪽빛', hex: '#7F98B8', note: '청화백자 · 서책 표지' },
      { name: '황토서책', hex: '#DFC48D', note: '선장본 고서 · 문방구' },
      { name: '오동목갈', hex: '#B8A38F', note: '책가 목재 프레임' },
      { name: '매화연홍', hex: '#DBA89E', note: '매화 · 석류 포인트' },
    ],
  },
  jogakbo: {
    id: 'jogakbo',
    name: '색동조각보',
    hanja: '色洞褓',
    wish: '오복 · 무병장수 · 이음',
    shortDesc: '천 조각을 한 땀씩 이어 아이의 복과 수명을 잇는 조선 조각보',
    motifsEn: 'a refined Korean traditional jogakbo patchwork textile composition in whisper-soft pastel obangsaek translucent ramie and silk squares (blush peach, butter cream, celadon green, misty sky indigo, warm ivory) with delicate hand-stitched gamchimjil seam lines and subtle tiny embroidered auspicious plum blossoms and stylized good-fortune motifs',
    historicalContext:
      '조선 여인들이 고운 비단과 모시 조각을 정성껏 이어 만든 조각보는 복을 싸서 간직하고(福裹), 조각을 잇듯 아이의 명(命)을 길고 복되게 잇는다는 축원을 담았습니다. 오방색을 저염료 파스텔로 순화해 신생아에게 편안하게 재해석했습니다.',
    defaultWish: '고운 조각보의 한 땀 한 땀처럼 복과 인연이 길고 따뜻하게 이어지기를',
    citations: [
      {
        grade: '사전',
        label: '[출처 : 보자기 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0023502',
      },
      {
        grade: '사전',
        label: '[출처 : 색동 - 한국민족문화대백과사전]',
        url: 'https://encykorea.aks.ac.kr/Article/E0027368',
      },
    ],
    palette: [
      { name: '연지살구', hex: '#E7B7AB', note: '적 · 남방의 온기' },
      { name: '치자노랑', hex: '#EFE0A8', note: '황 · 중앙의 평안' },
      { name: '송화연두', hex: '#BDD0B4', note: '청 · 동방의 생명' },
      { name: '쪽빛하늘', hex: '#A8C0D6', note: '흑 · 북방의 지혜' },
    ],
  },
};

function sanitizeText(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchJsonWithTimeout(url, init, timeoutMs = ATTEMPT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const raw = await r.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, json, raw };
  } catch (err) {
    return {
      ok: false,
      status: 504,
      json: { error: { message: err instanceof Error ? err.message : 'timeout' } },
      raw: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function generateEditorialPlan({ apiKey, theme, babyName, wishText }) {
  const displayBaby = babyName || '우리 아기';
  const fallback = {
    artworkTitle: babyName ? `${babyName}의 ${theme.name}` : `온고원 맞춤 ${theme.name}`,
    artPromptDetail: `${theme.motifsEn}, subtly inspired by the parent's blessing: "${wishText}"`,
    iconographySummary: `${displayBaby}를 위해 ${theme.name}(${theme.hanja})의 길상 도상을 중심으로 "${wishText}"라는 소원을 온고원 저염료 파스텔 민화로 재해석했습니다.`,
    postcardSalutation: `${displayBaby}에게`,
    postcardMessage: `${wishText}. 조선의 옛 사람들이 가장 간절한 소원을 그림에 담아 아이 곁에 두었듯, ${theme.name}의 고운 기운이 ${displayBaby}의 첫 계절을 포근히 덮어주기를 바랍니다.`,
    textModel: 'fallback-curated',
  };

  const systemPrompt = [
    'You are the chief Korean Minhwa art historian and editorial copywriter for ONGOWON (온고원), a luxury Korean newborn muslin blanket brand.',
    'Given a baby nickname, a traditional Joseon Minhwa theme, and a parent wish/taemong in Korean, output ONLY valid JSON with these exact keys:',
    '{',
    '  "artworkTitle": "short poetic Korean title (8-22 chars, e.g. 복동이의 황금 약리도)",',
    '  "artPromptDetail": "detailed English visual scene description (40-75 words) translating the parent wish/taemong imagery into authentic Joseon Minhwa motifs while strictly keeping the chosen theme and baby-friendly serenity; NO text/letters/characters in the image",',
    '  "iconographySummary": "2-3 warm, scholarly Korean sentences connecting the parent wish/taemong to authentic Joseon Minhwa iconography and Ongowon low-dye pastel color harmony (no fabricated book titles or fake URLs)",',
    '  "postcardSalutation": "short Korean salutation (e.g. 복동이에게 or 사랑하는 우리 아기에게)",',
    '  "postcardMessage": "warm poetic Korean wish postcard blessing (2-3 sentences, 70-130 Korean chars, dignified editorial tone, no emojis)"',
    '}',
  ].join('\n');

  const userPrompt = JSON.stringify({
    babyName: babyName || null,
    themeId: theme.id,
    themeName: `${theme.name}(${theme.hanja})`,
    themeWish: theme.wish,
    baseMotifs: theme.motifsEn,
    wishText,
  });

  const res = await fetchJsonWithTimeout(
    `${BIZROUTER_BASE}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        temperature: 0.65,
        max_tokens: 3200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
    16000
  );

  if (!res.ok) return fallback;
  const content = res.json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return fallback;

  try {
    const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      artworkTitle: sanitizeText(parsed.artworkTitle, 40) || fallback.artworkTitle,
      artPromptDetail: sanitizeText(parsed.artPromptDetail, 500) || fallback.artPromptDetail,
      iconographySummary: sanitizeText(parsed.iconographySummary, 420) || fallback.iconographySummary,
      postcardSalutation: sanitizeText(parsed.postcardSalutation, 30) || fallback.postcardSalutation,
      postcardMessage: sanitizeText(parsed.postcardMessage, 320) || fallback.postcardMessage,
      textModel: TEXT_MODEL,
    };
  } catch {
    return fallback;
  }
}

function buildOngowonImagePrompt(theme, artPromptDetail) {
  return [
    `Authentic Joseon-era Korean Minhwa folk painting adapted by ONGOWON for a luxury organic cotton newborn swaddle blanket (${theme.name} / ${theme.hanja} motif).`,
    `Scene: ${artPromptDetail}.`,
    'Artistic Style: Heirloom Atelier-Choux-meets-Korean-Minhwa illustration painted on subtly textured warm cream hanji mulberry paper (#F7F3EB), delicate fine muted sepia-ink outlines, soft mineral pigment washes (분채 채색), gentle baby-friendly proportions, serene museum-grade composition.',
    'Color & Textile Safety Rules: Low-saturation KC-safe pastel Obangsaek mineral palette only (soft apricot-coral, celadon sage green, misty indigo blue, pale peony blush, warm butter cream). Preserve generous breathable warm ivory hanji negative space (at least 35% light cream ground, 여백의 미) for low-dye newborn fabric printing. No neon colors, no heavy dark solid fills, no harsh shadows.',
    'Framing: Centered harmonious square 1:1 full-bleed flat painting suitable for a 95x95cm carré blanket. STRICTLY NO text, NO Korean/Chinese/English letters, NO calligraphy, NO red stamp seals, NO borders or picture frames, NO watermarks.',
  ].join(' ');
}

async function generateMinhwaImage({ apiKey, prompt }) {
  const modelsToTry = IMAGE_MODELS.length > 0 ? IMAGE_MODELS : ['google/gemini-2.5-flash-image'];
  let lastErr = null;

  for (const model of modelsToTry) {
    const res = await fetchJsonWithTimeout(
      `${BIZROUTER_BASE}/images/generations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          size: '1024x1024',
          output_format: 'jpeg',
          response_format: 'b64_json',
        }),
      },
      ATTEMPT_TIMEOUT_MS
    );

    const item = res.json?.data?.[0];
    if (res.ok && item?.b64_json) {
      const b64 = item.b64_json;
      const mime = b64.startsWith('/9j/')
        ? 'image/jpeg'
        : b64.startsWith('iVBOR')
          ? 'image/png'
          : 'image/webp';
      return {
        ok: true,
        provider: 'bizrouter',
        model,
        image: `data:${mime};base64,${b64}`,
      };
    }

    if (res.ok && item?.url) {
      return {
        ok: true,
        provider: 'bizrouter',
        model,
        image: item.url,
      };
    }

    lastErr = {
      status: res.status,
      message: res.json?.error?.message || `upstream status ${res.status}`,
      code: res.json?.error?.code || 'upstream_error',
    };

    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      break;
    }
  }

  return { ok: false, ...(lastErr || { status: 502, message: 'image generation failed', code: 'upstream_error' }) };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const ip = getClientIp(req);

  if (req.method === 'GET') {
    const quota = getQuotaStatus(ip);
    return res.status(200).json({
      ok: true,
      service: 'ongowon-minhwa-ai-studio',
      configured: Boolean(process.env.BIZROUTER_API_KEY),
      provider: 'bizrouter',
      imageModel: IMAGE_MODELS[0] || 'google/gemini-2.5-flash-image',
      textModel: TEXT_MODEL,
      quota,
      themes: Object.values(THEMES).map((t) => ({
        id: t.id,
        name: t.name,
        hanja: t.hanja,
        wish: t.wish,
        shortDesc: t.shortDesc,
      })),
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'POST 요청만 지원합니다.' });
  }

  const apiKey = process.env.BIZROUTER_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      error: 'server_not_configured',
      message: 'AI 민화 엔진이 아직 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.',
    });
  }

  const currentQuota = getQuotaStatus(ip);
  res.setHeader('X-RateLimit-Limit', String(currentQuota.limit));
  res.setHeader('X-RateLimit-Remaining', String(currentQuota.remaining));

  if (currentQuota.remaining <= 0) {
    return res.status(429).json({
      ok: false,
      error: 'daily_limit_exceeded',
      message: `오늘의 무료 AI 민화 생성 횟수(${DAILY_LIMIT}회)를 모두 사용하셨습니다. 내일 자정(KST) 이후 다시 이용하실 수 있어요.`,
      quota: currentQuota,
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const themeId = typeof body.theme === 'string' && THEMES[body.theme] ? body.theme : 'yangnido';
  const theme = THEMES[themeId];
  const babyName = sanitizeText(body.babyName, 20);
  const rawWish = sanitizeText(body.wishText, 160);
  const wishText = rawWish || theme.defaultWish;

  try {
    // 1. Generate Korean iconography interpretation, wish postcard copy, and tailored art direction
    const plan = await generateEditorialPlan({ apiKey, theme, babyName, wishText });

    // 2. Compose Ongowon proprietary Minhwa + low-dye KC-safe pastel prompt and generate artwork
    const imagePrompt = buildOngowonImagePrompt(theme, plan.artPromptDetail);
    const imgResult = await generateMinhwaImage({ apiKey, prompt: imagePrompt });

    if (!imgResult.ok) {
      const status = imgResult.status === 429 ? 429 : imgResult.status >= 400 && imgResult.status < 500 ? 422 : 502;
      console.error('[minhwa-generate] image generation failed:', imgResult.status, imgResult.code, imgResult.message);
      return res.status(status).json({
        ok: false,
        error: imgResult.code || 'generation_failed',
        message:
          status === 429
            ? '잠시 요청이 몰려 있어요. 잠시 후 다시 민화를 지어 주세요.'
            : '민화 도안을 그리는 중 일시적인 오류가 발생했어요. 다른 문구로 다시 시도해 주세요.',
        quota: currentQuota,
      });
    }

    // Consume quota only upon successful artwork generation
    const updatedQuota = consumeQuota(ip);
    res.setHeader('X-RateLimit-Remaining', String(updatedQuota.remaining));

    return res.status(200).json({
      ok: true,
      provider: imgResult.provider,
      model: imgResult.model,
      textModel: plan.textModel,
      image: imgResult.image,
      artworkTitle: plan.artworkTitle,
      babyName: babyName || '우리 아기',
      wishText,
      theme: {
        id: theme.id,
        name: theme.name,
        hanja: theme.hanja,
        wish: theme.wish,
      },
      iconography: {
        summary: plan.iconographySummary,
        historicalContext: theme.historicalContext,
        citations: theme.citations,
      },
      postcard: {
        salutation: plan.postcardSalutation,
        message: plan.postcardMessage,
        closing: '온고원 溫故園 · 소원을 덮어주는 첫 번째 담요',
      },
      palette: theme.palette,
      spec: {
        size: '95 × 95 cm (까레 정사각)',
        fabric: '오가닉 100% 40수 면 거즈 · KC 영유아 안전 기준 설계',
        dyeRule: '저염료 파스텔 오방색 · 한지 여백 35%+ 저자극 나염 규칙',
      },
      quota: updatedQuota,
    });
  } catch (err) {
    console.error('[minhwa-generate] unexpected error:', err);
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: '민화 도안 생성 중 예기치 못한 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      quota: currentQuota,
    });
  }
};
