'use strict';

const CACHE = new Map();
const MAX_CACHE = 4000;
const BATCH_SIZE = 12;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'translate') return undefined;

  translateTexts(message.texts, message.target).then(
    (translations) => sendResponse({ translations }),
    (error) => sendResponse({ translations: [], error: String(error) })
  );

  return true;
});

async function translateTexts(texts, target) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const language = target === 'es' ? 'es' : 'pt-BR';
  const output = new Array(texts.length).fill('');
  const pending = [];

  texts.forEach((text, index) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    const key = `${language}\u0000${clean}`;
    if (CACHE.has(key)) {
      output[index] = CACHE.get(key);
      return;
    }
    pending.push({ index, clean, key });
  });

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const params = new URLSearchParams();
    params.set('client', 'gtx');
    params.set('sl', 'en');
    params.set('tl', language);
    for (const item of chunk) params.append('q', item.clean);

    try {
      const response = await fetch(
        `https://translate.googleapis.com/translate_a/t?${params.toString()}`,
        { cache: 'no-store' }
      );
      if (!response.ok) throw new Error(`translate HTTP ${response.status}`);

      const data = await response.json();
      const list = Array.isArray(data) ? data : [];

      chunk.forEach((item, index) => {
        const translated = pickTranslation(list[index]);
        output[item.index] = translated;
        if (translated) CACHE.set(item.key, translated);
      });
    } catch {
      // Leave this chunk empty; the original line remains visible.
    }

    if (i + BATCH_SIZE < pending.length) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  trimCache();
  return output;
}

function pickTranslation(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (typeof value[0] === 'string') return value[0];
    if (Array.isArray(value[0]) && typeof value[0][0] === 'string') return value[0][0];
  }
  return '';
}

function trimCache() {
  if (CACHE.size <= MAX_CACHE) return;
  const excess = CACHE.size - MAX_CACHE;
  let removed = 0;
  for (const key of CACHE.keys()) {
    CACHE.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}
