/**
 * PV5 Data Collector - Cloudflare Worker
 * 
 * 환경변수 (Cloudflare Dashboard > Workers > Settings > Variables):
 *   YOUTUBE_API_KEY       : YouTube Data API v3 키
 *   GOOGLE_API_KEY        : Google Custom Search API 키
 *   GOOGLE_CX             : Google Programmable Search Engine ID
 *   AUTH_TOKEN            : 크롤링 버튼 보호용 임의 비밀키 (예: "mysecret123")
 * 
 * KV Namespace:
 *   PV5_KV : 수집 데이터 저장소 (wrangler.toml에서 바인딩)
 * 
 * 수집 방식: 버튼 클릭 시 수동 수집 (자동 수집 없음)
 *   - YouTube: 최대 50개
 *   - Google 이미지: 최대 50개
 *   - 합계: 최대 100개 (중복 제거)
 */

const SEARCH_QUERY = '#KIA #PV5';
const MAX_YOUTUBE  = 50;  // YouTube 최대 수집 수
const MAX_IMAGES   = 10;  // Google Custom Search 무료 최대 (1회 쿼리당 10개, 5회 호출)

// CORS 헤더
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── 라우팅 ──
    if (url.pathname === '/api/crawl' && request.method === 'POST') {
      return handleCrawl(request, env);
    }

    if (url.pathname === '/api/items' && request.method === 'GET') {
      return handleGetItems(env, url);
    }

    if (url.pathname === '/api/delete' && request.method === 'POST') {
      return handleDelete(request, env);
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(env);
    }

    return json({ error: 'Not found' }, 404);
  },

};

// ── 크롤링 실행 ──
async function handleCrawl(request, env) {
  // 간단한 인증 (AUTH_TOKEN 환경변수와 비교)
  const auth = request.headers.get('Authorization') || '';
  if (env.AUTH_TOKEN && auth !== `Bearer ${env.AUTH_TOKEN}`) {
    return json({ error: '인증 실패' }, 401);
  }

  try {
    const result = await runCrawl(env);
    return json(result);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function runCrawl(env) {
  const results = { youtube: [], images: [], errors: [] };

  // 1. YouTube 검색
  try {
    const ytItems = await fetchYouTube(env);
    results.youtube = ytItems;
  } catch (e) {
    results.errors.push(`YouTube: ${e.message}`);
  }

  // 2. Google 이미지 검색
  try {
    const imgItems = await fetchGoogleImages(env);
    results.images = imgItems;
  } catch (e) {
    results.errors.push(`Google Images: ${e.message}`);
  }

  // 3. KV에 저장 (기존 데이터와 머지, 중복 제거)
  const allNew = [...results.youtube, ...results.images];
  if (allNew.length > 0) {
    await saveItems(env, allNew);
  }

  // 4. 마지막 크롤링 시각 기록
  await env.PV5_KV.put('last_crawled', new Date().toISOString());

  return {
    success: true,
    collected: allNew.length,
    youtube: results.youtube.length,
    images: results.images.length,
    errors: results.errors,
    timestamp: new Date().toISOString(),
  };
}

// ── YouTube Data API (최대 50개) ──
async function fetchYouTube(env) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY 미설정');

  const params = new URLSearchParams({
    part: 'snippet',
    q: SEARCH_QUERY,
    type: 'video',
    maxResults: MAX_YOUTUBE,  // 최대 50개
    order: 'date',
    key: env.YOUTUBE_API_KEY,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return (data.items || []).map(item => ({
    id: `yt_${item.id.videoId}`,
    type: 'youtube',
    title: item.snippet.title,
    description: item.snippet.description,
    thumb: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    channel: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
    collectedAt: new Date().toISOString(),
  }));
}

// ── Google Custom Search API — 이미지 최대 50개 (10개씩 5페이지) ──
async function fetchGoogleImages(env) {
  if (!env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY 미설정');
  if (!env.GOOGLE_CX)      throw new Error('GOOGLE_CX 미설정');

  const allItems = [];
  const pages = 5; // 10개 × 5페이지 = 최대 50개

  for (let page = 0; page < pages; page++) {
    const startIndex = page * 10 + 1; // Google은 1-based
    const params = new URLSearchParams({
      q: SEARCH_QUERY,
      searchType: 'image',
      num: 10,
      start: startIndex,
      cx: env.GOOGLE_CX,
      key: env.GOOGLE_API_KEY,
    });

    try {
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
      if (!res.ok) break; // 더 이상 결과 없으면 중단

      const data = await res.json();
      const items = data.items || [];
      if (items.length === 0) break;

      allItems.push(...items.map(item => ({
        id: `img_${btoa(item.link).replace(/[^a-zA-Z0-9]/g,'').slice(0, 16)}`,
        type: 'image',
        title: item.title,
        description: item.snippet,
        thumb: item.pagemap?.cse_thumbnail?.[0]?.src || item.link,
        url: item.image?.contextLink || item.link,
        source: item.displayLink,
        publishedAt: new Date().toISOString(),
        collectedAt: new Date().toISOString(),
      })));

      if (items.length < 10) break; // 마지막 페이지
    } catch {
      break;
    }
  }

  return allItems;
}

// ── KV 저장/조회 ──
async function saveItems(env, newItems) {
  const existing = await getStoredItems(env);
  const existingIds = new Set(existing.map(i => i.id));

  const merged = [
    ...newItems.filter(i => !existingIds.has(i.id)),
    ...existing,
  ].slice(0, 500); // 최대 500개 보관

  await env.PV5_KV.put('items', JSON.stringify(merged));
}

async function getStoredItems(env) {
  try {
    const raw = await env.PV5_KV.get('items');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function handleGetItems(env, url) {
  const items = await getStoredItems(env);
  const type = url.searchParams.get('type'); // 'youtube' | 'image' | null
  const filtered = type ? items.filter(i => i.type === type) : items;
  return json({ items: filtered, total: filtered.length });
}

async function handleDelete(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (env.AUTH_TOKEN && auth !== `Bearer ${env.AUTH_TOKEN}`) {
    return json({ error: '인증 실패' }, 401);
  }

  const { id } = await request.json();
  const items = await getStoredItems(env);
  const filtered = items.filter(i => i.id !== id);
  await env.PV5_KV.put('items', JSON.stringify(filtered));
  return json({ success: true, remaining: filtered.length });
}

async function handleStats(env) {
  const items = await getStoredItems(env);
  const lastCrawled = await env.PV5_KV.get('last_crawled');
  return json({
    total: items.length,
    youtube: items.filter(i => i.type === 'youtube').length,
    images: items.filter(i => i.type === 'image').length,
    lastCrawled,
  });
}
