// Сканер выгодных сделок на рынке MetaForge (ARC Raiders).
// Запуск: node deals.js   (или двойной клик по start.bat)
// Остановить: Ctrl+C
// Нейросеть: вставь бесплатный ключ в файл ai-key.txt (инструкция внутри файла).

const fs = require('fs');
const path = require('path');

// ===== НАСТРОЙКИ =====
const CONFIG = {
  minProfit: 0.5,        // показывать только сделки с наваром от 50% при перепродаже
  minMarketPrice: 300,   // «дорогой» предмет: цена от стольки семян за штуку
  minSalesPerDay: 1,     // меньше продаж в день — товар неликвидный, не показываем
  minRatings: 3,         // минимум отзывов у продавца (0 = показывать всех)
  sellerActiveHours: 24, // продавец должен быть онлайн или выставлять что-то за последние N часов,
                         // иначе это «мёртвое» объявление — он не ответит
  minSamples: 3,         // сколько объявлений нужно, чтобы считать рыночную цену надёжной
  priceWindowHours: 48,  // цены считаем только по свежим объявлениям и сделкам (новые предметы дешевеют)
  pollSeconds: 20,       // как часто проверять новые объявления
  fullScanMinutes: 10,   // как часто пересчитывать рыночные цены по всему рынку
  showBarter: true,      // бартер (предмет на предмет)
  aiModel: '',           // пусто = выбрать модель автоматически
  beep: true,            // пищать при новой сделке
  showExistingOnStart: false, // true = при запуске показать (и отправить) сделки, которые уже висят на рынке
  // Telegram: токен и канал — в telegram.txt (или переменные TG_TOKEN / TG_CHAT на сервере)
  quietFrom: 2,          // с 2:00 до 12:00 по Берлину сигналы приходят без звука
  quietTo: 12,
  quietTimeZone: 'Europe/Berlin',
};

const BASE = 'https://metaforge.app/api/arc-raiders/trade';
const SEEDS_ID = 'assorted-seeds';
// Валюты — не предметы, цена «за штуку» у них не имеет смысла
const CURRENCIES = new Set([SEEDS_ID, 'research-points', 'coins']);
const DAY = 24 * 3600 * 1000;

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toLocaleTimeString('ru-RU');
const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

async function getJson(url, opts = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'user-agent': 'arc-deals-scanner', ...opts.headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

const fetchPage = (type, page) =>
  getJson(`${BASE}/listings?page=${page}&limit=100&sortBy=created_at&sortOrder=desc&listing_type=${type}`);

async function fetchAll(type) {
  const first = await fetchPage(type, 1);
  const all = [...first.data];
  // Качаем по 4 страницы одновременно — так в разы быстрее, но сайт не перегружаем
  const pages = Array.from({ length: first.pagination.totalPages - 1 }, (_, i) => i + 2);
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let p; (p = pages.shift()); ) {
      all.push(...(await fetchPage(type, p)).data);
      await sleep(100);
    }
  }));
  return all;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ===== РЫНОК =====
// Цена по объявлениям (медиана) — только для быстрого отсева; решение принимается по реальным продажам
let market = new Map(); // item_id -> { name, median, samples, asks: [{id, price}], buys: [price] }
let volume30d = new Map(); // item_id -> сделок за семена за 30 дней

const isFresh = (l) =>
  Date.now() - Math.max(Date.parse(l.created_at), Date.parse(l.updated_at || l.created_at)) < CONFIG.priceWindowHours * 3600000;

// Когда продавец последний раз проявлял активность: онлайн сейчас или выставлял/обновлял любое объявление
let sellerActivity = new Map(); // username -> время последней активности
const listingTime = (l) => Math.max(Date.parse(l.created_at), Date.parse(l.updated_at || l.created_at));

function noteActivity(l) {
  const u = l.user_profile?.username;
  if (!u) return;
  const t = l.user_profile.online_expires_at > Date.now() ? Date.now() : listingTime(l);
  if (t > (sellerActivity.get(u) || 0)) sellerActivity.set(u, t);
}

function lastActive(l) {
  noteActivity(l);
  return sellerActivity.get(l.user_profile?.username) || listingTime(l);
}

function buildMarket(sells, buys) {
  sellerActivity = new Map();
  for (const l of sells) noteActivity(l);
  for (const l of buys) noteActivity(l);
  const m = new Map();
  const entry = (l) => {
    if (!m.has(l.item_id)) m.set(l.item_id, { name: l.item.name, asks: [], buys: [] });
    return m.get(l.item_id);
  };
  // Старые объявления не учитываем: цены на новые предметы быстро падают, старые цены завышены
  for (const l of sells) {
    if (l.trade_type !== 'seed' || !l.price || CURRENCIES.has(l.item_id) || !isFresh(l)) continue;
    entry(l).asks.push({ id: l.id, price: l.price });
  }
  for (const l of buys) {
    if (l.trade_type !== 'seed' || !l.price || CURRENCIES.has(l.item_id) || !isFresh(l)) continue;
    if (Date.now() - lastActive(l) > CONFIG.sellerActiveHours * 3600000) continue; // покупатель пропал
    entry(l).buys.push(l.price);
  }
  for (const e of m.values()) {
    e.asks.sort((a, b) => a.price - b.price);
    e.buys.sort((a, b) => b - a);
    e.samples = e.asks.length;
    e.median = e.samples ? median(e.asks.map((a) => a.price)) : 0;
  }
  market = m;
}

async function loadVolumes() {
  const v = new Map();
  for (let page = 1; ; page++) {
    const j = await getJson(`${BASE}/stats/items?page=${page}&limit=100`);
    for (const it of j.data) v.set(it.item_id, it.seed_trades || 0);
    if (!j.pagination?.hasNextPage) break;
    await sleep(250);
  }
  volume30d = v;
}

// История реальных сделок по предмету (сайт отдаёт последние 50, примерно за сутки)
const historyCache = new Map();
function salesHistory(itemId) {
  const hit = historyCache.get(itemId);
  if (hit && Date.now() - hit.t < 15 * 60000) return hit.data;
  const data = getJson(`${BASE}/stats/live-batch?limit=50&item_id=${encodeURIComponent(itemId)}`).then((j) => j.data);
  data.catch(() => historyCache.delete(itemId));
  historyCache.set(itemId, { t: Date.now(), data });
  return data;
}

// Реальная цена, тренд и скорость продаж предмета
async function soldStats(itemId) {
  const now = Date.now();
  const raw = await salesHistory(itemId);
  const sales = raw.filter((x) => x.trade_type === 'seed' && x.price_in_seeds > 0 &&
    now - Date.parse(x.timestamp) < CONFIG.priceWindowHours * 3600000); // свежие сначала
  const prices = sales.map((x) => x.price_in_seeds);
  const soldMedian = prices.length >= 3 ? median(prices) : null;

  // Тренд: свежая половина сделок против более старой
  let trend = 0, recentMedian = null;
  if (prices.length >= 6) {
    const half = prices.length >> 1;
    recentMedian = median(prices.slice(0, half));
    trend = recentMedian / median(prices.slice(half)) - 1;
  }

  // Продаж в день: по последним суткам, а если история упёрлась в 50 сделок — экстраполируем.
  // Статистику за 30 дней берём, только если свежих данных нет совсем.
  let perDay = sales.filter((x) => now - Date.parse(x.timestamp) < DAY).length;
  if (raw.length >= 50) {
    const span = now - Date.parse(raw.at(-1).timestamp);
    if (span > 0 && span < DAY) perDay = sales.length * (DAY / span);
  }
  if (!raw.length) perDay = (volume30d.get(itemId) || 0) / 30;

  // Если цена падает — считаем по самым свежим сделкам, чтобы не обмануться
  const price = trend < -0.1 && recentMedian ? recentMedian : soldMedian;
  return { prices, soldMedian, recentMedian, trend, perDay, price,
    lastSale: sales[0] ? (now - Date.parse(sales[0].timestamp)) / 3600000 : null };
}

// Сколько стоит одна штука предмета в семенах: по реальным продажам, иначе по объявлениям
async function seedValue(itemId) {
  if (itemId === SEEDS_ID) return 1;
  if (CURRENCIES.has(itemId)) return null;
  const s = await soldStats(itemId).catch(() => null);
  if (s?.price) return s.price;
  const m = market.get(itemId);
  return m && m.samples >= CONFIG.minSamples ? m.median : null;
}

// ===== НЕЙРОСЕТИ =====
// Можно подключить несколько сразу: запросы распределяются между ними, так быстрее и надёжнее.
// interval — пауза между запросами к одному сервису, чтобы не упираться в бесплатный лимит.
const AI_PROVIDERS = {
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', interval: 2500,
    match: (k) => k.startsWith('gsk_'),
    prefer: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
    fallback: (id) => /gpt-oss|llama|qwen/.test(id) && !/guard|whisper|tts|vision/.test(id) },
  gemini: { name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', interval: 6000,
    match: (k) => k.startsWith('AIza') || k.startsWith('AQ.'),
    prefer: ['gemini-flash-lite-latest', 'gemini-flash-latest'], // lite отвечает за секунду, обычная думает минуту
    fallback: (id) => /gemini.*flash/.test(id) && !/image|tts|audio|live|exp|preview/.test(id) },
  // Только бесплатные модели (:free) — деньги с баланса не тратятся
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', interval: 4000,
    match: (k) => k.startsWith('sk-or-'),
    prefer: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'],
    fallback: (id) => id.endsWith(':free') && /gpt-oss|llama|qwen|deepseek|gemma/.test(id) && !/vl|vision/.test(id) },
};

const ai = { on: false, workers: [], cache: new Map() };

function readKeys() {
  if (process.env.AI_KEYS) return process.env.AI_KEYS.split(/[\s,]+/).filter(Boolean); // на сервере
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'ai-key.txt'), 'utf8').split(/\r?\n/);
    return lines.map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  } catch { return []; }
}

async function setupAI() {
  const keys = readKeys();
  if (!keys.length) return console.log(`${c.yellow}Нейросеть не подключена (нет ключа в ai-key.txt) — описания объявлений проверять не буду, такие сделки пропущу.${c.reset}`);
  for (const key of keys) {
    const p = Object.values(AI_PROVIDERS).find((x) => x.match(key));
    if (!p) { console.log(`${c.red}Не понял, от какого сервиса ключ «${key.slice(0, 6)}...» в ai-key.txt — пропускаю.${c.reset}`); continue; }
    // Несколько подходящих моделей: если одна перегружена, сканер переключится на следующую
    let models = CONFIG.aiModel ? [CONFIG.aiModel] : [];
    try {
      if (!models.length) {
        const j = await getJson(`${p.base}/models`, { headers: { authorization: `Bearer ${key}` } });
        const ids = (j.data || []).map((m) => String(m.id).replace(/^models\//, ''));
        models = [...p.prefer.filter((x) => ids.includes(x)), ...ids.filter((x) => p.fallback(x) && !p.prefer.includes(x))].slice(0, 4);
      }
    } catch (e) {
      console.log(`${c.red}Нейросеть ${p.name} недоступна (${e.message}) — проверь ключ или интернет/VPN.${c.reset}`);
      continue;
    }
    if (!models.length) { console.log(`${c.red}У ${p.name} не нашлось подходящей бесплатной модели.${c.reset}`); continue; }
    ai.workers.push({ name: p.name, base: p.base, interval: p.interval, key, models, mi: 0, nextFree: 0, pausedUntil: 0 });
    console.log(`${c.green}Нейросеть подключена: ${p.name}, модель ${models[0]}${c.reset}`);
  }
  ai.on = ai.workers.length > 0;
}

const AI_SYSTEM = `You check player trade listings in the game ARC Raiders. The currency is "seeds".
I want to BUY the listed item and resell it for seeds.
Sellers often fill the structured fields wrongly. The free-text description is written by the seller and has priority
when it states a price, ratio, quantity or condition (examples: "500 each", "5:1", "1 inductor for 2 nodes",
"3 items per inductor", "only all together", "price is per 100", "research points only", "DM offers").
Task: work out WHAT exactly I must give for ONE unit of the listed item, choosing the cheapest deal the seller
actually accepts (wanted_options have value_per_unit_seeds to compare). Do NOT calculate the total cost — just list
what to give: items by their index in wanted_options with the quantity for ONE unit, plus seeds if seeds are paid
(for trade_type "seed" the listed price per unit is in listed_price_per_unit_seeds unless the description says otherwise).
If the seller wants something not in wanted_options or with unknown value, or the terms are unclear or contradictory,
or the listing looks like bait/scam, set valid false.
If the description invites offers or bidding ("send offers", "make an offer", "highest bidder", "offer in either",
"negotiable", "name your price"), the wanted quantities are only placeholders: set valid false unless the description
itself states a concrete price or ratio.
If what you get is worth below 30% of market_price_per_unit_seeds, be very skeptical: set valid false unless the
description clearly confirms such a low price.
Answer with JSON only:
{"valid": true | false, "give": [{"option": index, "quantity": number}], "seeds": number,
 "confidence": "high" | "medium" | "low", "reason_ru": "one short sentence in Russian"}`;

// Берём сервис, который освободится раньше всех, и занимаем у него очередь
async function takeWorker() {
  const now = Date.now();
  const ready = ai.workers.filter((w) => w.pausedUntil <= now);
  const pool = ready.length ? ready : ai.workers;
  const w = pool.reduce((a, b) => (Math.max(a.nextFree, a.pausedUntil) <= Math.max(b.nextFree, b.pausedUntil) ? a : b));
  const start = Math.max(now, w.nextFree, w.pausedUntil);
  w.nextFree = start + w.interval;
  if (start > now) await sleep(start - now);
  return w;
}

async function callWorker(w, payload) {
  const body = {
    model: w.models[w.mi], temperature: 0, max_tokens: 2000,
    messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: JSON.stringify(payload) }],
  };
  if (!w.noJsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(`${w.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${w.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000), // медленный сервис не должен тормозить остальных
  });
  if (res.status === 400 && !w.noJsonMode) { w.noJsonMode = true; return callWorker(w, payload); }
  if (!res.ok) {
    const err = new Error(`${w.name}: HTTP ${res.status}`);
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    err.status = res.status;
    throw err;
  }
  const text = (await res.json()).choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${w.name}: пустой ответ`);
  return JSON.parse(m[0]);
}

async function askAI(payload) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const w = await takeWorker();
    try {
      const r = await callWorker(w, payload);
      r.by = w.name;
      return r;
    } catch (e) {
      lastErr = e;
      // Лимит или сбой у одного сервиса — переключаем его на другую модель, даём передохнуть,
      // а запрос уходит другому сервису
      w.mi = (w.mi + 1) % w.models.length;
      const pause = e.status === 429 && w.models.length === 1 ? (e.retryAfter || 30) : w.mi === 0 ? 30 : 2;
      w.pausedUntil = Date.now() + pause * 1000;
    }
  }
  throw lastErr;
}

// ===== ОЦЕНКА СДЕЛКИ =====
// Быстрый отсев по объявлениям, без сетевых запросов
function quickCheck(l) {
  if (l.listing_type !== 'sell' || l.status !== 'active' || !l.available_quantity) return false;
  if (CURRENCIES.has(l.item_id)) return false;
  if ((l.user_reputation?.total_ratings || 0) < CONFIG.minRatings) return false;
  if (Date.now() - lastActive(l) > CONFIG.sellerActiveHours * 3600000) return false; // продавец пропал
  const m = market.get(l.item_id);
  if (!m || m.samples < CONFIG.minSamples || m.median < CONFIG.minMarketPrice) return false;
  const limit = m.median / (1 + CONFIG.minProfit);
  if (l.trade_type === 'seed') return l.price > 0 && l.price <= limit;
  if (l.trade_type === 'barter' && CONFIG.showBarter && l.preferences?.length) {
    // Оптимистично: самый дешёвый вариант, количество могли указать на весь лот
    return l.preferences.some((p) => {
      const mm = p.item_id === SEEDS_ID ? { median: 1, samples: 99 } : market.get(p.item_id);
      if (!mm || mm.samples < CONFIG.minSamples) return false;
      const qty = l.quantity > 1 && p.quantity >= l.quantity ? p.quantity / l.quantity : p.quantity;
      return mm.median * qty <= limit;
    });
  }
  return false;
}

async function assess(l) {
  if (!quickCheck(l)) return null;
  const m = market.get(l.item_id);
  const s = await soldStats(l.item_id);
  const resale = s.price ?? m.median;
  if (s.perDay < CONFIG.minSalesPerDay) return null;

  // Варианты оплаты в семенах
  let options = [];
  let ambiguous = false;
  if (l.trade_type === 'seed') {
    options = [{ name: 'Seeds', quantity: l.price, value: 1, cost: l.price, text: `${fmt(l.price)} семян` }];
  } else {
    for (const p of l.preferences) {
      const v = await seedValue(p.item_id);
      const name = p.item?.name || p.item_id;
      options.push({ name, quantity: p.quantity, value: v, cost: v == null ? null : v * p.quantity,
        text: `${p.quantity}× ${name}${v == null ? '' : ` (~${fmt(v * p.quantity)} семян)`}` });
      // «10 штук за 10» — непонятно, за весь лот или за каждую
      if (l.quantity > 1 && p.quantity >= l.quantity) ambiguous = true;
    }
  }
  const known = options.filter((o) => o.cost != null).sort((a, b) => a.cost - b.cost);
  if (!known.length && !l.description) return null;
  let cost = known[0]?.cost ?? null;
  let payText = known[0]?.text ?? '';
  let aiNote = null;

  const desc = (l.description || '').trim();
  if (desc || ambiguous) {
    if (!ai.on) {
      if (desc) return null; // без нейросети описание не проверить — лучше пропустить, чем обмануться
    } else {
      const cacheKey = `${l.id}|${l.updated_at}`;
      let r = ai.cache.get(cacheKey);
      if (!r) {
        r = await askAI({
          listed_item: l.item.name, available_quantity: l.available_quantity, trade_type: l.trade_type,
          listed_price_per_unit_seeds: l.trade_type === 'seed' ? l.price : null,
          wanted_options: l.trade_type === 'barter'
            ? options.map((o, i) => ({ index: i, item: o.name, quantity_field: o.quantity, value_per_unit_seeds: o.value }))
            : [],
          description: desc || null,
          market_price_per_unit_seeds: Math.round(resale),
        });
        ai.cache.set(cacheKey, r);
        if (process.env.ARC_DEBUG) console.log(`${c.dim}[ИИ] ${l.item.name} | "${desc}" | ${l.trade_type === 'seed' ? `${l.price} семян` : options.map((o) => o.text).join(' / ')} → ${JSON.stringify(r)}${c.reset}`);
      }
      if (!r.valid || r.confidence === 'low') return null;
      // ИИ говорит, ЧТО отдать, а цену считаем сами по реальным продажам — без ошибок в арифметике
      const opts = l.trade_type === 'barter' ? options : [];
      const parts = [];
      let aiCost = Number(r.seeds) > 0 ? Number(r.seeds) : 0;
      if (aiCost) parts.push(`${fmt(aiCost)} семян`);
      for (const g of r.give || []) {
        const o = opts[g.option];
        const q = Number(g.quantity);
        if (!o || o.value == null || !(q > 0)) return null;
        if (o.name === 'Assorted Seeds') { aiCost += q; parts.push(`${fmt(q)} семян`); continue; }
        aiCost += o.value * q;
        parts.push(`${+q.toFixed(2)}× ${o.name}`);
      }
      if (!(aiCost > 0)) return null;
      cost = aiCost;
      payText = `${parts.join(' + ')} (~${fmt(aiCost)} семян)`;
      aiNote = `${r.reason_ru || ''} ${c.dim}(${r.by})`;
    }
  }
  if (cost == null) return null;
  if (cost < resale * 0.1) return null; // подозрительно дёшево — скорее ошибка или приманка

  // Заявки сильно дороже реальных продаж никто не исполняет (особые условия или забытые) — не верим им
  const bestBuy = m.buys.find((b) => !s.soldMedian || b <= s.soldMedian * 1.3) || 0;
  const profit = resale - cost;
  const viaOrder = profit / cost < CONFIG.minProfit && (bestBuy - cost) / cost >= CONFIG.minProfit;
  if (profit / cost < CONFIG.minProfit && !viaOrder) return null;

  // Категория сделки — как рассуждал бы опытный перекупщик:
  //  sure   — 100% брать: есть покупатель, который заберёт сразу, или товар улетает за часы
  //  good   — хорошо: навар есть, продаётся нормально, но есть нюанс (мало отзывов, медленнее)
  //  barter — выгодно, только если нужный предмет уже есть
  // Всё остальное (цена не подтверждена продажами, неликвид, навар только через одну заявку) — скрываем
  const ratings = l.user_reputation?.total_ratings || 0;
  const orderExit = bestBuy >= cost * (1 + CONFIG.minProfit); // можно сразу продать покупателю
  const reliable = s.soldMedian && (s.prices.length >= 5 || orderExit); // цена подтверждена реальными продажами
  let cat;
  if (!reliable) return null;
  if (l.trade_type === 'barter') {
    if (viaOrder || s.perDay < 5) return null;
    cat = 'barter';
  } else if (ratings >= 10 && (orderExit || (s.perDay >= 15 && !viaOrder))) cat = 'sure';
  else if (s.perDay >= 5 || orderExit) cat = 'good';
  else return null;

  const competitors = m.asks.filter((a) => a.id !== l.id && a.price <= resale).length;
  return { l, s, m, cost, payText, resale, profit, bestBuy, viaOrder, orderExit, competitors, aiNote, cat };
}

const CATS = {
  sure:   { rank: 0, color: c.green,   label: '■ 100% БРАТЬ' },
  good:   { rank: 1, color: c.yellow,  label: '■ ХОРОШО' },
  barter: { rank: 2, color: c.magenta, label: '■ БАРТЕР — если предмет уже есть' },
};

function print(d, isNew) {
  const { l, s, m } = d;
  const rep = l.user_reputation || {};
  const online = l.user_profile?.online_expires_at > Date.now();
  const ago = (Date.now() - lastActive(l)) / 3600000;
  const activity = online ? `${c.green}● онлайн${c.reset}`
    : `${ago < 3 ? c.green : c.yellow}активен ${ago < 1 ? `${Math.max(1, Math.round(ago * 60))} мин` : `${Math.round(ago)} ч`} назад${c.reset}`;
  const listedDays = (Date.now() - Date.parse(l.created_at)) / DAY;
  const roi = Math.round((d.profit / d.cost) * 100);
  const hours = s.perDay > 0 ? ((d.competitors + 1) / s.perDay) * 24 : Infinity;
  const sellTime = hours < 1 ? 'за час' : hours < 48 ? `за ~${Math.round(hours)} ч` : `за ~${Math.round(hours / 24)} дн`;
  const fast = s.perDay >= 5;
  const cat = CATS[d.cat];
  const tag = isNew ? `  ${c.bold}НОВАЯ!${c.reset}` : '';

  const lines = [
    `\n${c.bold}${cat.color}${cat.label}${c.reset}${tag}  ${c.dim}[${time()}]${c.reset}`,
    `   ${c.bold}${cat.color}${l.item.name}${c.reset} ${c.dim}(${l.available_quantity} шт.)${c.reset}`,
    `   Отдаёшь: ${c.green}${d.payText}${c.reset}`,
  ];
  if (d.cat === 'sure' && d.orderExit) {
    lines.push(`   ${c.bold}${c.green}→ Сразу продай покупателю за ${fmt(d.bestBuy)} (+${fmt(d.bestBuy - d.cost)}). Сначала напиши ему, потом покупай.${c.reset}`);
  }
  if (d.viaOrder) {
    lines.push(`   ${c.bold}${c.magenta}Перепродажа через заявку: ${fmt(d.bestBuy)} → навар ~${fmt(d.bestBuy - d.cost)} (+${Math.round((d.bestBuy / d.cost - 1) * 100)}%)${c.reset}  ${c.dim}(проверь, что покупатель ещё ждёт)${c.reset}`);
  } else {
    lines.push(`   ${c.bold}${c.green}Перепродажа ~${fmt(d.resale)} → навар ~${fmt(d.profit)} (+${roi}%)${c.reset}` +
      (d.bestBuy > d.cost ? `  ${c.magenta}| заявка на покупку: ${fmt(d.bestBuy)}${c.reset}` : ''));
  }
  lines.push(
    `   Продажи: ${s.soldMedian ? `~${fmt(s.soldMedian)} (${s.prices.length} сделок)` : `по объявлениям ~${fmt(m.median)}`}` +
    (s.trend < -0.1 ? `${c.red} ↓ падает до ~${fmt(s.recentMedian)}${c.reset}` : s.trend > 0.1 ? `${c.green} ↑ растёт до ~${fmt(s.recentMedian)}${c.reset}` : '') +
    ` · ${s.perDay < 10 ? s.perDay.toFixed(1) : fmt(s.perDay)}/день · ${fast ? c.green : c.yellow}продашь ${sellTime}${c.reset}`,
    `   Продавец: ${l.user_profile?.full_name || '?'} — ${rep.positive_percentage ?? '?'}% (${rep.total_ratings || 0} отзывов)  ${activity}` +
      (listedDays >= 2 ? `  ${c.dim}(объявлению ${Math.round(listedDays)} дн)${c.reset}` : ''),
  );
  if (l.description) lines.push(`   Описание: "${l.description.replace(/\s+/g, ' ')}"`);
  if (d.aiNote) lines.push(`   ${c.cyan}ИИ: ${d.aiNote}${c.reset}`);
  lines.push(`   ${c.cyan}https://metaforge.app/arc-raiders/market?item_id=${l.item_id}${c.reset}`);
  console.log(lines.join('\n'));
  if (isNew && CONFIG.beep) process.stdout.write('\x07');
  sendTelegram(d);
}

// ===== TELEGRAM =====
const tg = { token: process.env.TG_TOKEN || '', chat: process.env.TG_CHAT || '', queue: [], busy: false };
const SENT_FILE = path.join(__dirname, 'sent.json');
let sent = new Map(); // id объявления -> когда отправили (чтобы после перезапуска не слать повторно)

function setupTelegram() {
  if (!tg.token) {
    try {
      const lines = fs.readFileSync(path.join(__dirname, 'telegram.txt'), 'utf8').split(/\r?\n/)
        .map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      [tg.token = '', tg.chat = ''] = lines;
    } catch {}
  }
  try { sent = new Map(Object.entries(JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')))); } catch {}
  console.log(tg.token && tg.chat
    ? `${c.green}Telegram подключён: сигналы идут в канал (с ${CONFIG.quietFrom}:00 до ${CONFIG.quietTo}:00 по Берлину — без звука)${c.reset}`
    : `${c.dim}Telegram не настроен (нет telegram.txt) — сигналы только в консоли${c.reset}`);
}

function saveSent() {
  const weekAgo = Date.now() - 7 * DAY;
  for (const [id, t] of sent) if (t < weekAgo) sent.delete(id);
  try { fs.writeFileSync(SENT_FILE, JSON.stringify(Object.fromEntries(sent))); } catch {}
}

function isQuietHours() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: CONFIG.quietTimeZone }).format(new Date()));
  return CONFIG.quietFrom <= CONFIG.quietTo ? h >= CONFIG.quietFrom && h < CONFIG.quietTo : h >= CONFIG.quietFrom || h < CONFIG.quietTo;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tgMessage(d) {
  const { l, s } = d;
  const rep = l.user_reputation || {};
  const head = { sure: '🟢 <b>100% БРАТЬ</b>', good: '🟡 <b>ХОРОШО</b>', barter: '🟣 <b>БАРТЕР</b> — если предмет уже есть' }[d.cat];
  const roi = Math.round((d.profit / d.cost) * 100);
  const online = l.user_profile?.online_expires_at > Date.now();
  const ago = (Date.now() - lastActive(l)) / 3600000;
  const lines = [
    head,
    `<b>${esc(l.item.name)}</b> (${l.available_quantity} шт.)`,
    `Отдаёшь: <b>${esc(d.payText)}</b>`,
  ];
  if (d.cat === 'sure' && d.orderExit) lines.push(`→ Сразу продай покупателю за <b>${fmt(d.bestBuy)}</b> (+${fmt(d.bestBuy - d.cost)}). Сначала напиши ему!`);
  if (d.viaOrder) lines.push(`Перепродажа через заявку: <b>${fmt(d.bestBuy)}</b> → навар ~${fmt(d.bestBuy - d.cost)}`);
  else lines.push(`Перепродажа ~<b>${fmt(d.resale)}</b> → навар <b>~${fmt(d.profit)} (+${roi}%)</b>`);
  lines.push(
    `Продажи: ~${fmt(s.soldMedian)} (${s.prices.length} сделок)` +
      (s.trend < -0.1 ? ` ↓ падает до ~${fmt(s.recentMedian)}` : s.trend > 0.1 ? ` ↑ растёт до ~${fmt(s.recentMedian)}` : '') +
      ` · ${s.perDay < 10 ? s.perDay.toFixed(1) : fmt(s.perDay)}/день`,
    `Продавец: ${esc(l.user_profile?.full_name || '?')} — ${rep.positive_percentage ?? '?'}% (${rep.total_ratings || 0}) · ` +
      (online ? '● онлайн' : `активен ${ago < 1 ? `${Math.max(1, Math.round(ago * 60))} мин` : `${Math.round(ago)} ч`} назад`),
  );
  if (l.description) lines.push(`<i>«${esc(l.description.replace(/\s+/g, ' ').slice(0, 300))}»</i>`);
  if (d.aiNote) lines.push(`🤖 ${esc(d.aiNote.replace(/\x1b\[[0-9;]*m/g, ''))}`);
  return lines.join('\n');
}

function sendTelegram(d) {
  if (!tg.token || !tg.chat || sent.has(d.l.id)) return;
  sent.set(d.l.id, Date.now());
  saveSent();
  tg.queue.push(d);
  drainTelegram();
}

// Отправляем по одному с паузой — у Telegram лимит на частоту сообщений в канал
async function drainTelegram() {
  if (tg.busy) return;
  tg.busy = true;
  while (tg.queue.length) {
    const d = tg.queue.shift();
    try {
      const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: tg.chat, text: tgMessage(d), parse_mode: 'HTML',
          disable_notification: isQuietHours(), link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [[{ text: 'Открыть на рынке', url: `https://metaforge.app/arc-raiders/market?item_id=${d.l.item_id}` }]] },
        }),
      });
      const j = await res.json();
      if (res.status === 429) { tg.queue.unshift(d); await sleep((j.parameters?.retry_after || 10) * 1000); continue; }
      if (!j.ok) console.log(`${c.red}[${time()}] Telegram: ${j.description}${c.reset}`);
    } catch (e) {
      console.log(`${c.red}[${time()}] Telegram недоступен: ${e.message}${c.reset}`);
    }
    await sleep(3500);
  }
  tg.busy = false;
}

const seen = new Set();

async function check(listings, isNew) {
  const found = [];
  const queue = listings.filter((l) => !seen.has(l.id));
  queue.forEach((l) => seen.add(l.id));
  // Проверяем несколько объявлений одновременно — нейросети работают параллельно
  const worker = async () => {
    for (let l; (l = queue.shift()); ) {
      try {
        const d = await assess(l);
        if (!d) continue;
        found.push(d);
        if (isNew) print(d, true); // новые показываем сразу
      } catch (e) {
        seen.delete(l.id); // попробуем ещё раз в следующий проход
        console.log(`${c.dim}[${time()}] не смог проверить «${l.item?.name}»: ${e.message}${c.reset}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 2 + ai.workers.length * 2 }, worker));
  // Уже висящие на рынке — списком: сначала «100% брать», потом «хорошо», потом бартер; внутри — по навару
  if (!isNew) {
    found.sort((a, b) => CATS[a.cat].rank - CATS[b.cat].rank || b.profit / b.cost - a.profit / a.cost);
    found.forEach((d) => print(d, false));
  }
  return found;
}

async function fullScan(firstRun) {
  process.stdout.write(`${c.dim}[${time()}] Сканирую весь рынок...${c.reset}`);
  const sells = await fetchAll('sell');
  const buys = await fetchAll('buy');
  await loadVolumes();
  buildMarket(sells, buys);
  console.log(`${c.dim} ${sells.length} продаж, ${buys.length} покупок. Проверяю кандидатов...${c.reset}`);
  // При запуске старые объявления просто запоминаем, чтобы не спамить; сигналим только о новых
  if (firstRun && !CONFIG.showExistingOnStart) {
    sells.forEach((l) => seen.add(l.id));
    console.log(`${c.bold}Запомнил ${sells.length} объявлений, которые уже висят на рынке, — их не показываю.${c.reset}`);
    console.log(`${c.bold}Слежу за новыми объявлениями каждые ${CONFIG.pollSeconds} сек...${c.reset}`);
    return;
  }
  // При первом запуске показываем то, что уже висит на рынке; дальше — только новое
  const found = await check(sells, !firstRun);
  if (firstRun) {
    const n = (cat) => found.filter((d) => d.cat === cat).length;
    console.log(`\n${c.bold}Итого: ${c.green}100% брать — ${n('sure')}${c.reset}${c.bold}, ${c.yellow}хорошо — ${n('good')}${c.reset}${c.bold}, ${c.magenta}бартер — ${n('barter')}${c.reset}`);
    console.log(`${c.bold}Дальше слежу за новыми объявлениями каждые ${CONFIG.pollSeconds} сек...${c.reset}`);
  }
}

async function main() {
  console.log(`${c.bold}${c.cyan}ARC Raiders — охотник за сделками${c.reset}`);
  console.log(`${c.dim}Показываю только сделки с наваром от ${Math.round(CONFIG.minProfit * 100)}% на дорогих предметах (от ${CONFIG.minMarketPrice} семян)${c.reset}`);
  await setupAI();
  setupTelegram();
  console.log();
  await fullScan(true);
  let lastFull = Date.now();
  for (;;) {
    await sleep(CONFIG.pollSeconds * 1000);
    try {
      if (Date.now() - lastFull > CONFIG.fullScanMinutes * 60000) {
        await fullScan(false);
        lastFull = Date.now();
      } else {
        const page = await fetchPage('sell', 1);
        await check(page.data, true);
      }
    } catch (e) {
      console.log(`${c.red}[${time()}] Ошибка сети: ${e.message} — попробую снова${c.reset}`);
    }
  }
}

main().catch((e) => {
  console.error(`${c.red}Не удалось запуститься: ${e.message}${c.reset}`);
  process.exit(1);
});
