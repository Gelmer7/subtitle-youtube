'use strict';

const CACHE = new Map();
const MAX_CACHE = 4000;
const BATCH_SIZE = 12;
const READER_MAP_KEY = 'legrendasReaderWindows';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'translate') {
    translateTexts(message.texts, message.target).then(
      (translations) => sendResponse({ translations }),
      (error) => sendResponse({ translations: [], error: String(error) })
    );
    return true;
  }

  if (message.type === 'legrendas:open-reader') {
    const tabId = Number(message.tabId || (sender.tab && sender.tab.id));
    openReader(tabId).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error) })
    );
    return true;
  }

  if (message.type === 'legrendas:reader-ready') {
    onReaderReady(message, sender).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error) })
    );
    return true;
  }

  if (message.type === 'legrendas:reader-state') {
    forwardToTab(message.tabId, {
      type: 'legrendas:reader-state',
      full: !!message.full,
      reader: true,
    }).then(sendResponse);
    return true;
  }

  if (message.type === 'legrendas:reader-command') {
    forwardToTab(message.tabId, {
      type: 'legrendas:reader-command',
      action: message.action,
      value: message.value,
      reader: true,
    }).then(sendResponse);
    return true;
  }

  if (message.type === 'legrendas:close-reader') {
    closeReaderWindow(sender, message.tabId).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error) })
    );
    return true;
  }

  if (message.type === 'legrendas:close-reader-for-tab') {
    closeReaderForTab(sender.tab && sender.tab.id).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: String(error) })
    );
    return true;
  }

  return undefined;
});

chrome.windows.onRemoved.addListener((windowId) => {
  cleanupClosedReader(windowId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupClosedReaderTab(tabId).catch(() => {});
});

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tab || null);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'timeout' });
    }, 5000);

    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'tab-unavailable' });
        } else {
          resolve(response || { ok: true });
        }
      });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error) });
    }
  });
}

function createWindow(options) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(options, (window) => {
      if (chrome.runtime.lastError || !window) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'create-failed'));
      } else {
        resolve(window);
      }
    });
  });
}

function getWindow(windowId) {
  return new Promise((resolve) => {
    chrome.windows.get(windowId, (window) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(window || null);
    });
  });
}

function updateWindow(windowId, options) {
  return new Promise((resolve) => {
    chrome.windows.update(windowId, options, () => resolve());
  });
}

function removeWindow(windowId) {
  return new Promise((resolve, reject) => {
    chrome.windows.remove(windowId, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function getReaderMap() {
  try {
    const data = await chrome.storage.session.get(READER_MAP_KEY);
    const value = data && data[READER_MAP_KEY];
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function saveReaderMap(map) {
  try {
    await chrome.storage.session.set({ [READER_MAP_KEY]: map });
  } catch {
    // The reader still works for this session; only restore-on-close is lost.
  }
}

function entryForWindow(map, windowId) {
  return Object.entries(map).find(([, entry]) => entry && entry.windowId === windowId) || null;
}

async function openReader(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: 'sem-video' };
  }

  const tab = await getTab(tabId);
  if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
    return { ok: false, error: 'Abre um vídeo do YouTube primeiro.' };
  }

  const map = await getReaderMap();
  const existing = map[tabId];

  if (existing && existing.windowId) {
    const window = await getWindow(existing.windowId);
    if (window) {
      await updateWindow(existing.windowId, { focused: true });
      return { ok: true, existing: true };
    }
    delete map[tabId];
    await saveReaderMap(map);
  }

  const window = await createWindow({
    url: chrome.runtime.getURL(`reader.html?tabId=${tabId}`),
    type: 'normal',
    width: 980,
    height: 900,
    focused: true,
  });

  map[tabId] = {
    windowId: window.id,
    readerTabId: window.tabs && window.tabs[0] ? window.tabs[0].id : null,
    createdAt: Date.now(),
  };
  await saveReaderMap(map);

  return { ok: true, windowId: window.id };
}

async function onReaderReady(message, sender) {
  const tabId = Number(message.tabId);
  const windowId = sender.tab && sender.tab.windowId;

  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: 'sem-video' };
  }

  const tab = await getTab(tabId);
  if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
    return { ok: false, error: 'Abre um vídeo do YouTube primeiro.' };
  }

  if (windowId) {
    const map = await getReaderMap();
    const entry = map[tabId];
    if (!entry) {
      map[tabId] = {
        windowId,
        readerTabId: sender.tab && sender.tab.id,
        createdAt: Date.now(),
      };
      await saveReaderMap(map);
    } else if (entry.windowId !== windowId) {
      entry.windowId = windowId;
      entry.readerTabId = sender.tab && sender.tab.id;
      await saveReaderMap(map);
    }
  }

  const response = await sendTabMessage(tabId, {
    type: 'legrendas:reader-active',
  });

  return response;
}

async function forwardToTab(tabId, message) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'sem-video' };
  }
  return sendTabMessage(id, message);
}

async function closeReaderWindow(sender, tabIdHint) {
  const map = await getReaderMap();
  let windowId = sender && sender.tab && sender.tab.windowId;
  let found = windowId ? entryForWindow(map, windowId) : null;
  let tabId = found ? Number(found[0]) : Number(tabIdHint);

  if (!windowId && Number.isInteger(tabId) && map[tabId]) {
    windowId = map[tabId].windowId;
    found = [String(tabId), map[tabId]];
  }

  if (!windowId) return { ok: false, error: 'sem-janela' };

  try {
    await removeWindow(windowId);
  } catch {
    return { ok: false, error: 'janela-já-fechada' };
  }

  if (found) {
    delete map[found[0]];
    await saveReaderMap(map);
  }

  if (Number.isInteger(tabId) && tabId > 0) {
    await sendTabMessage(tabId, { type: 'legrendas:reader-closed' });
  }

  return { ok: true };
}

async function closeReaderForTab(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) return { ok: true };

  const map = await getReaderMap();
  const entry = map[id];
  if (!entry || !entry.windowId) return { ok: true };

  try {
    await removeWindow(entry.windowId);
  } catch {
    return { ok: false, error: 'janela-já-fechada' };
  }

  delete map[id];
  await saveReaderMap(map);
  await sendTabMessage(id, { type: 'legrendas:reader-closed' });
  return { ok: true };
}

async function cleanupClosedReader(windowId) {
  const map = await getReaderMap();
  const found = entryForWindow(map, windowId);
  if (!found) return;

  const [tabId] = found;
  delete map[tabId];
  await saveReaderMap(map);

  await sendTabMessage(Number(tabId), {
    type: 'legrendas:reader-closed',
  });
}

async function cleanupClosedReaderTab(readerTabId) {
  const map = await getReaderMap();
  const found =
    Object.entries(map).find(
      ([, entry]) => entry && entry.readerTabId === readerTabId
    ) || null;
  if (!found) return;

  const [tabId] = found;
  delete map[tabId];
  await saveReaderMap(map);

  await sendTabMessage(Number(tabId), {
    type: 'legrendas:reader-closed',
  });
}

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
