'use strict';

const CACHE = new Map();
const MAX_CACHE = 4000;
const BATCH_SIZE = 12;
const READER_MAP_KEY = 'legrendasReaderWindows';
const YOUTUBE_WATCH_URL =
  /^https:\/\/(?:www\.|m\.)youtube\.com\/(?:watch|live)(?:[/?#]|$)/;
let memoryReaderMap = {};

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

  return undefined;
});

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    cleanupClosedWindow(windowId).catch(() => {});
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupRemovedTab(tabId).catch(() => {});
  });
}

let actionNoticeTimer = 0;

function clearActionNotice() {
  clearTimeout(actionNoticeTimer);
  actionNoticeTimer = 0;

  if (!chrome.action) return;

  try {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'SubIngles' });
  } catch {
    // The action UI may be unavailable.
  }
}

function showActionNotice(message) {
  if (!chrome.action) return;

  clearTimeout(actionNoticeTimer);

  try {
    chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setTitle({
      title: message || 'Abre um vídeo do YouTube',
    });
  } catch {
    // The action UI may be unavailable.
  }

  actionNoticeTimer = setTimeout(clearActionNotice, 2600);
}

async function handleActionClick(tab) {
  let activeTab = tab;

  if (!activeTab || !Number.isInteger(activeTab.id)) {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    activeTab = tabs.find((item) => item && Number.isInteger(item.id)) || null;
  }

  if (!activeTab || !Number.isInteger(activeTab.id)) {
    showActionNotice('Abre um vídeo do YouTube');
    return;
  }

  if (
    typeof activeTab.url === 'string' &&
    activeTab.url &&
    !YOUTUBE_WATCH_URL.test(activeTab.url)
  ) {
    showActionNotice('Abre um vídeo do YouTube');
    return;
  }

  let result;
  try {
    result = await openReader(activeTab.id);
  } catch {
    result = null;
  }

  if (!result || result.ok === false) {
    showActionNotice(
      (result && result.error) || 'Não foi possível abrir o leitor'
    );
    return;
  }

  clearActionNotice();
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    handleActionClick(tab).catch(() => {});
  });

  // Clear a popup that may have been persisted by the fallback below.
  if (typeof chrome.action.setPopup === 'function') {
    try {
      chrome.action.setPopup({ popup: '' });
    } catch {
      // Not supported.
    }
  }
} else if (chrome.action && typeof chrome.action.setPopup === 'function') {
  // Browsers without action.onClicked keep the old popup as a launcher.
  try {
    chrome.action.setPopup({ popup: 'popup.html' });
  } catch {
    // Not supported.
  }
}

function getTab(tabId) {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.get !== 'function') {
      resolve(null);
      return;
    }

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

function canUseWindows() {
  return !!(chrome.windows && typeof chrome.windows.create === 'function');
}

function createWindow(options) {
  return new Promise((resolve, reject) => {
    if (!canUseWindows()) {
      reject(new Error('windows-unavailable'));
      return;
    }

    chrome.windows.create(options, (window) => {
      if (chrome.runtime.lastError || !window) {
        reject(
          new Error(
            (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              'create-failed'
          )
        );
      } else {
        resolve(window);
      }
    });
  });
}

function getWindow(windowId) {
  return new Promise((resolve) => {
    if (!chrome.windows || typeof chrome.windows.get !== 'function') {
      resolve(null);
      return;
    }

    chrome.windows.get(windowId, (window) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(window || null);
    });
  });
}

function updateWindow(windowId, options) {
  return new Promise((resolve) => {
    if (!chrome.windows || typeof chrome.windows.update !== 'function') {
      resolve();
      return;
    }

    chrome.windows.update(windowId, options, () => resolve());
  });
}

function removeWindow(windowId) {
  return new Promise((resolve) => {
    if (!chrome.windows || typeof chrome.windows.remove !== 'function') {
      resolve(false);
      return;
    }

    chrome.windows.remove(windowId, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function createTab(options) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabs || typeof chrome.tabs.create !== 'function') {
      reject(new Error('tabs-unavailable'));
      return;
    }

    chrome.tabs.create(options, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        reject(
          new Error(
            (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              'create-tab-failed'
          )
        );
      } else {
        resolve(tab);
      }
    });
  });
}

function updateTab(tabId, options) {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.update !== 'function') {
      resolve();
      return;
    }

    chrome.tabs.update(tabId, options, () => resolve());
  });
}

function removeTab(tabId) {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.remove !== 'function') {
      resolve(false);
      return;
    }

    chrome.tabs.remove(tabId, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function queryTabs(options) {
  return new Promise((resolve) => {
    if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve([]);
      return;
    }

    chrome.tabs.query(options, (tabs) => resolve(tabs || []));
  });
}

async function readReaderMap() {
  const areas = [
    chrome.storage && chrome.storage.session,
    chrome.storage && chrome.storage.local,
  ];

  for (const area of areas) {
    if (!area || typeof area.get !== 'function') continue;
    try {
      const data = await area.get(READER_MAP_KEY);
      const value = data && data[READER_MAP_KEY];
      if (value && typeof value === 'object') return value;
    } catch {
      // Try the next storage area.
    }
  }

  return memoryReaderMap;
}

async function getReaderMap() {
  const map = await readReaderMap();
  memoryReaderMap = map && typeof map === 'object' ? { ...map } : {};
  return { ...memoryReaderMap };
}

async function saveReaderMap(map) {
  memoryReaderMap = map && typeof map === 'object' ? { ...map } : {};
  const areas = [
    chrome.storage && chrome.storage.session,
    chrome.storage && chrome.storage.local,
  ];

  for (const area of areas) {
    if (!area || typeof area.set !== 'function') continue;
    try {
      await area.set({ [READER_MAP_KEY]: memoryReaderMap });
      return;
    } catch {
      // Try the next storage area.
    }
  }
}

function findEntryByReaderTab(map, readerTabId) {
  if (!readerTabId) return null;
  return (
    Object.entries(map).find(
      ([, entry]) => entry && entry.readerTabId === readerTabId
    ) || null
  );
}

function findEntryByWindow(map, windowId) {
  return (
    Object.entries(map).find(
      ([, entry]) =>
        entry &&
        entry.windowId === windowId &&
        entry.surface !== 'tab'
    ) || null
  );
}

async function entryIsAlive(entry) {
  if (!entry) return false;

  if (entry.readerTabId) {
    return !!(await getTab(entry.readerTabId));
  }

  if (entry.surface === 'tab') return false;

  if (entry.windowId) {
    return !!(await getWindow(entry.windowId));
  }

  return false;
}

async function focusEntry(entry) {
  if (!entry) return;

  if (entry.readerTabId) {
    await updateTab(entry.readerTabId, { active: true });
  }

  if (entry.windowId) {
    await updateWindow(entry.windowId, { focused: true });
  }
}

async function removeEntrySurface(entry) {
  if (!entry) return false;

  if (entry.surface === 'tab') {
    return entry.readerTabId ? removeTab(entry.readerTabId) : false;
  }

  if (entry.surface === 'window' && entry.windowId) {
    // Be defensive: if the "window" actually contains other tabs (some Android
    // browsers emulate windows with tabs), close only the reader tab.
    if (entry.readerTabId) {
      const readerTab = await getTab(entry.readerTabId);
      if (!readerTab) return false;
      if (!Number.isInteger(readerTab.windowId)) {
        return removeTab(entry.readerTabId);
      }
      const tabs = await queryTabs({ windowId: readerTab.windowId });
      if (tabs.length !== 1) return removeTab(entry.readerTabId);
    }

    const removed = await removeWindow(entry.windowId);
    if (removed) return true;
    return entry.readerTabId ? removeTab(entry.readerTabId) : false;
  }

  if (entry.windowId) {
    const removed = await removeWindow(entry.windowId);
    if (removed) return true;
  }

  return entry.readerTabId ? removeTab(entry.readerTabId) : false;
}

async function inferSurface(readerTab) {
  if (!readerTab || !Number.isInteger(readerTab.windowId)) return 'tab';
  if (!canUseWindows()) return 'tab';

  const tabs = await queryTabs({ windowId: readerTab.windowId });
  return tabs.length <= 1 ? 'window' : 'tab';
}

async function normalizeSurfaceForYoutube(entry, youtubeTab) {
  if (!entry || !youtubeTab || entry.surface !== 'window') return;

  if (
    Number.isInteger(youtubeTab.windowId) &&
    entry.windowId === youtubeTab.windowId
  ) {
    entry.surface = 'tab';
  }

  if (entry.readerTabId) {
    const readerTab = await getTab(entry.readerTabId);
    if (
      readerTab &&
      Number.isInteger(readerTab.windowId) &&
      readerTab.windowId === youtubeTab.windowId
    ) {
      entry.surface = 'tab';
      entry.windowId = readerTab.windowId;
    }
  }
}

async function openReader(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: 'sem-video' };
  }

  const tab = await getTab(tabId);
  if (!tab) {
    return { ok: false, error: 'Abre um vídeo do YouTube primeiro.' };
  }
  if (tab.url && !YOUTUBE_WATCH_URL.test(tab.url)) {
    return { ok: false, error: 'Abre um vídeo do YouTube primeiro.' };
  }

  const map = await getReaderMap();
  const existing = map[tabId];

  if (existing) {
    if (await entryIsAlive(existing)) {
      const surfaceBefore = existing.surface;
      await normalizeSurfaceForYoutube(existing, tab);
      if (existing.surface !== surfaceBefore) await saveReaderMap(map);
      await focusEntry(existing);

      return {
        ok: true,
        existing: true,
        surface:
          existing.surface || (existing.windowId ? 'window' : 'tab'),
      };
    }

    delete map[tabId];
    await saveReaderMap(map);
  }

  const url = chrome.runtime.getURL(`reader.html?tabId=${tabId}`);
  let entry = null;

  try {
    const window = await createWindow({
      url,
      type: 'normal',
      width: 980,
      height: 900,
      focused: true,
    });

    const readerTab = window.tabs && window.tabs[0] ? window.tabs[0] : null;
    const sameWindow =
      window.id === tab.windowId ||
      (readerTab &&
        Number.isInteger(readerTab.windowId) &&
        readerTab.windowId === tab.windowId);

    entry = {
      surface: sameWindow ? 'tab' : 'window',
      windowId:
        sameWindow &&
        readerTab &&
        Number.isInteger(readerTab.windowId)
          ? readerTab.windowId
          : window.id,
      readerTabId: readerTab ? readerTab.id : null,
      createdAt: Date.now(),
    };
  } catch {
    try {
      const tabOptions = { url, active: true };
      if (Number.isInteger(tab.windowId)) tabOptions.windowId = tab.windowId;

      let readerTab;
      try {
        readerTab = await createTab(tabOptions);
      } catch {
        readerTab = await createTab({ url, active: true });
      }

      entry = {
        surface: 'tab',
        windowId: readerTab.windowId,
        readerTabId: readerTab.id,
        createdAt: Date.now(),
      };
    } catch {
      return {
        ok: false,
        error: 'Não foi possível abrir o leitor neste navegador.',
      };
    }
  }

  map[tabId] = entry;
  await saveReaderMap(map);

  return {
    ok: true,
    surface: entry.surface,
    windowId: entry.windowId,
    readerTabId: entry.readerTabId,
  };
}

async function onReaderReady(message, sender) {
  const tabId = Number(message.tabId);
  const readerTab = sender.tab;

  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: 'sem-video' };
  }

  const tab = await getTab(tabId);
  if (!tab) {
    return { ok: false, error: 'Abre um vídeo do YouTube primeiro.' };
  }
  if (tab.url && !YOUTUBE_WATCH_URL.test(tab.url)) {
    return { ok: false, error: 'Abre um vídeo do YouTube primeiro.' };
  }

  if (readerTab) {
    const map = await getReaderMap();
    const entry = map[tabId];
    const readerWindowId = Number.isInteger(readerTab.windowId)
      ? readerTab.windowId
      : null;

    if (!entry) {
      map[tabId] = {
        surface: await inferSurface(readerTab),
        windowId: readerWindowId,
        readerTabId: readerTab.id,
        createdAt: Date.now(),
      };
      await saveReaderMap(map);
    } else {
      let changed = false;

      if (entry.readerTabId !== readerTab.id) {
        entry.readerTabId = readerTab.id;
        changed = true;
      }

      if (readerWindowId && entry.windowId !== readerWindowId) {
        entry.windowId = readerWindowId;
        changed = true;
      }

      // Some Android browsers expose windows.create but open the reader in a
      // tab of the same window. In that case the surface must stay a tab, or
      // closing the reader would close the whole browser window.
      if (
        entry.surface === 'window' &&
        readerWindowId &&
        Number.isInteger(tab.windowId) &&
        readerWindowId === tab.windowId
      ) {
        entry.surface = 'tab';
        changed = true;
      }

      if (!entry.surface) {
        entry.surface = await inferSurface(readerTab);
        changed = true;
      }

      if (changed) await saveReaderMap(map);
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
  const readerTabId = sender && sender.tab && sender.tab.id;
  let found = findEntryByReaderTab(map, readerTabId);

  if (!found && sender && sender.tab && sender.tab.windowId) {
    found = findEntryByWindow(map, sender.tab.windowId);
  }

  const hintId = Number(tabIdHint);
  if (!found && Number.isInteger(hintId) && map[hintId]) {
    found = [String(hintId), map[hintId]];
  }

  if (!found) return { ok: false, error: 'sem-janela' };

  const [youtubeTabId, entry] = found;
  const youtubeTab = await getTab(Number(youtubeTabId));
  await normalizeSurfaceForYoutube(entry, youtubeTab);
  await removeEntrySurface(entry);
  delete map[youtubeTabId];
  await saveReaderMap(map);
  await sendTabMessage(Number(youtubeTabId), {
    type: 'legrendas:reader-closed',
  });

  return { ok: true };
}

async function cleanupClosedWindow(windowId) {
  const map = await getReaderMap();
  const entries = Object.entries(map).filter(
    ([, entry]) =>
      entry &&
      entry.windowId === windowId &&
      (entry.surface === 'window' || !entry.surface)
  );
  if (!entries.length) return;

  for (const [youtubeTabId] of entries) {
    delete map[youtubeTabId];
  }
  await saveReaderMap(map);

  for (const [youtubeTabId] of entries) {
    await sendTabMessage(Number(youtubeTabId), {
      type: 'legrendas:reader-closed',
    });
  }
}

async function cleanupRemovedTab(tabId) {
  const map = await getReaderMap();
  let changed = false;

  // The YouTube tab was closed: close its reader surface too.
  if (map[tabId]) {
    const entry = map[tabId];
    await removeEntrySurface(entry);
    delete map[tabId];
    changed = true;
  }

  // The reader tab was closed: notify the YouTube tab.
  const found = findEntryByReaderTab(map, tabId);
  if (found) {
    const [youtubeTabId] = found;
    delete map[youtubeTabId];
    changed = true;
    await sendTabMessage(Number(youtubeTabId), {
      type: 'legrendas:reader-closed',
    });
  }

  if (changed) await saveReaderMap(map);
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
