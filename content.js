(() => {
  'use strict';

  const CHANNEL = 'legrendas';
  const HOST_ID = 'legrendas-host';

  const DEFAULTS = {
    enabled: true,
    targetLang: 'pt-BR',
    showTranslation: true,
    fontSize: 20,
    fullscreen: 'shrink',
  };

  const DOCK_CSS = `
    :host { display: block; }
    *, *::before, *::after { box-sizing: border-box; }
    .dock {
      position: relative;
      width: 100%;
      min-height: 76px;
      padding: 12px 24px;
      background: #000;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      text-align: center;
      font-family: Roboto, "YouTube Sans", Arial, sans-serif;
      border-radius: 0 0 12px 12px;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .row {
      max-width: 100%;
      font-size: var(--font-size, 20px);
      line-height: 1.35;
      font-weight: 500;
      white-space: pre-wrap;
    }
    .row--translation {
      font-size: calc(var(--font-size, 20px) * 0.85);
      font-weight: 400;
      color: #c9c9c9;
    }
    .row[data-empty="true"] { visibility: hidden; }
    .reader-launch {
      position: absolute;
      top: 5px;
      right: 8px;
      margin: 0;
      padding: 3px 7px;
      border: 1px solid #333;
      border-radius: 5px;
      background: #181818;
      color: #bdbdbd;
      font: 600 10px/1.3 Roboto, Arial, sans-serif;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      cursor: pointer;
      opacity: 0.3;
      transition: opacity 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .reader-launch:hover,
    .reader-launch:focus-visible {
      opacity: 1;
      color: #fff;
      border-color: #666;
      outline: none;
    }
    :host(.legrendas-fs-host) .reader-launch { display: none; }
    :host(.legrendas-fs-host) .dock {
      height: 100%;
      min-height: 0;
      border-radius: 0;
      padding: 8px 24px;
      overflow: hidden;
    }
  `;

  const state = {
    settings: { ...DEFAULTS },
    videoId: null,
    host: null,
    shadow: null,
    rows: { original: null, translation: null },
    tracks: [],
    captured: [],
    capturedBodies: new Map(),
    originalCues: [],
    translationCues: [],
    translationByCue: [],
    currentIndex: -1,
    ready: false,
    loading: false,
    fallback: false,
    rafId: 0,
    fallbackRaf: 0,
    abort: null,
    loadKey: '',
    loadedTarget: null,
    isFullscreen: false,
    ro: null,
    videoEl: null,
    navTimer: 0,
    retryTimer: 0,
    ccTimer: 0,
    lastHref: location.href,
    warning: '',
    translationToken: 0,
    lastError: '',
    lastMessage: null,
    messageCount: 0,
    emptyRetries: 0,
    readerActive: false,
    readerRevision: 0,
    readerLines: [],
    audioMode: false,
    readerOverlay: null,
  };

  let loadSeq = 0;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function wordQuery(value) {
    return String(value || '')
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[^\p{L}\p{N}]+$/u, '');
  }

  function makeWordTimings(text, start, end) {
    const clean = cleanText(text);
    if (!clean) return [];

    const tokens = clean.match(/\S+/g) || [];
    if (!tokens.length) return [];

    const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
    let safeEnd = Number.isFinite(end) ? end : safeStart + Math.max(0.8, tokens.length * 0.3);
    if (safeEnd <= safeStart) safeEnd = safeStart + Math.max(0.8, tokens.length * 0.3);

    const totalWeight = tokens.reduce((sum, token) => sum + Math.max(1, token.length), 0);
    let cursor = safeStart;

    return tokens.map((token, index) => {
      const share = Math.max(1, token.length) / totalWeight;
      const wordStart = cursor;
      let wordEnd = index === tokens.length - 1
        ? safeEnd
        : Math.min(safeEnd, wordStart + (safeEnd - safeStart) * share);

      if (wordEnd <= wordStart) wordEnd = Math.min(safeEnd, wordStart + 0.06);
      cursor = wordEnd;

      return {
        text: token,
        query: wordQuery(token),
        start: wordStart,
        end: Math.max(wordEnd, wordStart + 0.06),
      };
    });
  }

  function makeWordsFromSegments(segments, start, end) {
    const parts = (Array.isArray(segments) ? segments : [])
      .map((segment) => ({
        text: cleanText(segment && segment.utf8),
        offset: Number(segment && segment.tOffsetMs),
      }))
      .filter((part) => part.text);

    if (!parts.length) return makeWordTimings('', start, end);

    const offsets = parts
      .filter((part) => Number.isFinite(part.offset))
      .map((part) => part.offset);
    const hasDistinctOffsets = new Set(offsets).size > 1;

    if (!hasDistinctOffsets) {
      return makeWordTimings(parts.map((part) => part.text).join(' '), start, end);
    }

    const starts = [];
    let previousStart = start;

    parts.forEach((part) => {
      let partStart = Number.isFinite(part.offset)
        ? Math.max(start, start + part.offset / 1000)
        : previousStart;
      partStart = Math.min(partStart, end);
      starts.push(partStart);
      previousStart = partStart;
    });

    const words = [];
    parts.forEach((part, index) => {
      const nextStart = starts[index + 1];
      let partEnd = Number.isFinite(nextStart) && nextStart > starts[index]
        ? nextStart
        : end;
      if (partEnd <= starts[index]) partEnd = Math.min(end, starts[index] + 0.6);
      if (partEnd <= starts[index]) partEnd = starts[index] + 0.6;
      words.push(...makeWordTimings(part.text, starts[index], partEnd));
    });

    words.sort((a, b) => a.start - b.start);
    return words;
  }

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v') || null;
      if (url.pathname.startsWith('/live/')) return url.pathname.split('/')[2] || null;
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    } catch {
      // ignore
    }
    return null;
  }

  function isWatchPage() {
    return location.pathname === '/watch' || location.pathname.startsWith('/live/');
  }

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function getVideo() {
    const player = getPlayer();
    return (
      (player && player.querySelector('video')) ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video')
    );
  }

  function isAd() {
    const player = getPlayer();
    return !!(player && player.classList.contains('ad-showing'));
  }

  function sendToPage(type, extra = {}) {
    window.postMessage({ source: CHANNEL + '-content', type, ...extra }, '*');
  }

  function setActiveClass(on) {
    document.documentElement.classList.toggle(
      'legrendas-active',
      !!on && state.settings.enabled
    );
  }

  function debug(extra = {}) {
    try {
      document.documentElement.dataset.legrendasDebug = JSON.stringify({
        videoId: state.videoId,
        captured: state.captured.length,
        tracks: state.tracks.length,
        bodies: state.capturedBodies.size,
        ready: state.ready,
        loading: state.loading,
        fallback: state.fallback,
        warning: state.warning,
        cues: state.originalCues.length,
        translated: state.translationCues.length,
        error: state.lastError,
        messageCount: state.messageCount,
        lastMessage: state.lastMessage,
        ...extra,
      });
    } catch {
      // Debug output must never break the extension.
    }
  }

  function loadSettings() {
    return chrome.storage.sync
      .get(DEFAULTS)
      .then((stored) => {
        state.settings = { ...DEFAULTS, ...stored };
        normalizeSettings();
      })
      .catch(() => {
        state.settings = { ...DEFAULTS };
      });
  }

  function normalizeSettings() {
    if (state.settings.targetLang !== 'es') state.settings.targetLang = 'pt-BR';
    state.settings.fontSize = Math.min(28, Math.max(16, Number(state.settings.fontSize) || 20));
    if (state.settings.fullscreen !== 'hide') state.settings.fullscreen = 'shrink';
  }

  function applyFontSize() {
    const size = Number(state.settings.fontSize) || 20;
    const dock = state.shadow && state.shadow.querySelector('.dock');
    if (dock) dock.style.setProperty('--font-size', `${size}px`);

    if (state.isFullscreen) {
      const player = getPlayer();
      const height = Math.max(88, Math.round(size * 4.2));
      if (player) player.style.setProperty('--legrendas-fs-h', `${height}px`);
      if (state.host) state.host.style.height = `${height}px`;
      fitFullscreenText();
    }
  }

  function findAnchor() {
    return (
      document.querySelector('#primary-inner > #player') ||
      document.querySelector('#player') ||
      document.querySelector('#player-container-outer') ||
      getPlayer()
    );
  }

  function createReaderLaunchButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reader-launch';
    button.textContent = 'Texto';
    button.title = 'Abrir modo leitura';
    button.setAttribute('aria-label', 'Abrir modo leitura');
    button.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage(
          { type: 'legrendas:open-reader' },
          (response) => {
            if (chrome.runtime.lastError || !response || !response.ok) {
              button.title =
                (response && response.error) || 'Não foi possível abrir o modo leitura';
            }
          }
        );
      } catch {
        // The extension may have been reloaded.
      }
    });
    return button;
  }

  function createDock() {
    if (state.host && state.rows.original) return state.host;

    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
    }

    if (!host.shadowRoot) {
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = DOCK_CSS;

      const dock = document.createElement('div');
      dock.className = 'dock';

      const original = document.createElement('div');
      original.className = 'row row--original';
      original.dataset.empty = 'true';

      const translation = document.createElement('div');
      translation.className = 'row row--translation';
      translation.dataset.empty = 'true';

      dock.append(original, translation, createReaderLaunchButton());
      shadow.append(style, dock);

      state.shadow = shadow;
      state.rows.original = original;
      state.rows.translation = translation;
    } else {
      state.shadow = host.shadowRoot;
      state.rows.original = host.shadowRoot.querySelector('.row--original');
      state.rows.translation = host.shadowRoot.querySelector('.row--translation');
      if (!host.shadowRoot.querySelector('.reader-launch')) {
        const dock = host.shadowRoot.querySelector('.dock');
        if (dock) dock.append(createReaderLaunchButton());
      }
    }

    state.host = host;
    applyFontSize();
    return host;
  }

  function placeDock() {
    if (!state.host || state.isFullscreen) return;
    const anchor = findAnchor();
    if (!anchor) return;

    if (
      state.host.parentElement !== anchor.parentElement ||
      state.host.previousElementSibling !== anchor
    ) {
      anchor.insertAdjacentElement('afterend', state.host);
    }

    state.host.classList.remove('legrendas-fs-host');
    state.host.style.cssText = '';
    state.host.style.display = 'block';
    state.host.style.flex = 'none';
    state.host.style.width = '100%';
    state.host.style.margin = '0 auto 12px';
    updateDockWidth();
  }

  function mountDock() {
    if (!state.settings.enabled || !isWatchPage()) return;
    createDock();
    if (!state.isFullscreen) placeDock();
    observePlayer();
    attachVideoEvents();
    setActiveClass(true);
    if (document.fullscreenElement) onFullscreenChange();
  }

  function unmountDock() {
    stopSync();
    stopFallback();
    exitAudioMode();
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }
    if (state.host) state.host.remove();
    state.host = null;
    state.shadow = null;
    state.rows = { original: null, translation: null };
    if (state.ro) {
      state.ro.disconnect();
      state.ro = null;
    }
    state.isFullscreen = false;

    const player = getPlayer();
    if (player) {
      player.classList.remove('legrendas-fs');
      player.style.removeProperty('--legrendas-fs-h');
    }

    setActiveClass(false);
  }

  function updateDockWidth() {
    if (!state.host) return;
    if (state.isFullscreen) {
      state.host.style.width = '100%';
      return;
    }

    const video = getVideo();
    const player = getPlayer();
    const element = video || player;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    if (!rect.width) return;

    let width = rect.width;
    if (video && video.videoWidth && video.videoHeight) {
      const aspect = video.videoWidth / video.videoHeight;
      width = Math.min(rect.width, rect.height * aspect);
    }

    if (width > 0) state.host.style.width = `${Math.round(width)}px`;
  }

  function observePlayer() {
    if (state.ro) state.ro.disconnect();
    const player = getPlayer();
    const video = getVideo();
    if (!player) return;

    state.ro = new ResizeObserver(() => updateDockWidth());
    state.ro.observe(player);
    if (video) state.ro.observe(video);
  }

  function attachVideoEvents() {
    const video = getVideo();
    if (!video || video === state.videoEl) return;
    state.videoEl = video;
    updateDockWidth();

    video.addEventListener('play', () => syncOnce(true));
    video.addEventListener('pause', () => syncOnce(true));
    video.addEventListener('seeked', () => syncOnce(true));
    video.addEventListener('ratechange', () => syncOnce(true));
    video.addEventListener('timeupdate', () => syncOnce());
    video.addEventListener('loadedmetadata', () => updateDockWidth());
    video.addEventListener('resize', () => updateDockWidth());
  }

  function setRow(name, text) {
    const element = state.rows[name];
    if (!element) return;
    const value = String(text || '');
    if (element.textContent !== value) element.textContent = value;
    element.dataset.empty = value ? 'false' : 'true';
    if (name === 'translation') {
      element.style.display = state.settings.showTranslation ? '' : 'none';
    }
  }

  function clearRows() {
    setRow('original', '');
    setRow('translation', '');
  }

  function renderCue(index) {
    if (index < 0) {
      clearRows();
      return;
    }
    const original = (state.originalCues[index] && state.originalCues[index].text) || '';
    const translation = state.translationByCue[index] || '';
    setRow('original', original);
    setRow('translation', state.settings.showTranslation ? translation : '');
    if (state.isFullscreen) fitFullscreenText();
  }

  function findCueIndex(cues, time) {
    if (!cues.length) return -1;

    let low = 0;
    let high = cues.length - 1;
    let position = -1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      if (cues[middle].start <= time) {
        position = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (position < 0) return -1;
    if (time < cues[position].end) return position;

    for (let i = position - 1; i >= 0 && i >= position - 4; i -= 1) {
      if (time < cues[i].end) return i;
    }
    return -1;
  }

  function syncOnce(force = false) {
    if (!state.ready || !state.originalCues.length) return;
    if (!state.settings.enabled) return;

    const video = getVideo();
    if (!video) return;

    if (isAd()) {
      if (state.currentIndex !== -2) {
        state.currentIndex = -2;
        clearRows();
      }
      return;
    }

    const index = findCueIndex(state.originalCues, video.currentTime);
    if (!force && index === state.currentIndex) return;
    state.currentIndex = index;
    renderCue(index);
  }

  function startSync() {
    stopSync();
    const tick = () => {
      if (!state.settings.enabled) return;
      const video = getVideo();
      if (video && video !== state.videoEl) attachVideoEvents();
      if (video && !video.paused) syncOnce();
      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
    syncOnce(true);
  }

  function stopSync() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = 0;
  }

  function parseJson3(data) {
    const events = Array.isArray(data && data.events) ? data.events : [];
    const cues = [];
    const seen = new Set();

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (!event || event.aAppend) continue;
      if (!Array.isArray(event.segs) || !event.segs.length) continue;

      const startMs = Number(event.tStartMs) || 0;
      const text = cleanText(
        event.segs.map((segment) => (segment && segment.utf8) || '').join('')
      );
      if (!text) continue;

      const nextStart = Number(events[i + 1] && events[i + 1].tStartMs);
      let durationMs = Number(event.dDurationMs) || 0;
      if (!durationMs && Number.isFinite(nextStart) && nextStart > startMs) {
        durationMs = nextStart - startMs;
      }
      if (!durationMs) durationMs = 2500;

      const key = `${startMs}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const start = startMs / 1000;
      const end = (startMs + durationMs) / 1000;
      cues.push({
        start,
        end,
        text,
        words: makeWordsFromSegments(event.segs, start, end),
      });
    }

    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  function parseXmlCaptions(text) {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      return Array.from(doc.querySelectorAll('text'))
        .map((node) => {
          const start = Number(node.getAttribute('start')) || 0;
          const duration = Number(node.getAttribute('dur')) || 2.5;
          const text = cleanText(node.textContent);
          return {
            start,
            end: start + duration,
            text,
            words: makeWordTimings(text, start, start + duration),
          };
        })
        .filter((cue) => cue.text);
    } catch {
      return [];
    }
  }

  function parseBody(text) {
    const value = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!value) return [];
    if (value.startsWith('<')) return parseXmlCaptions(value);
    try {
      return parseJson3(JSON.parse(value));
    } catch {
      return [];
    }
  }

  function getCapturedBody(kind, target) {
    const bodies = Array.from(state.capturedBodies.values())
      .filter((body) => validUrl(body.url))
      .sort((a, b) => (b.at || 0) - (a.at || 0));

    if (kind === 'original') {
      return (
        bodies.find(
          (body) => !body.tlang && (body.lang === 'en' || body.lang.startsWith('en-'))
        ) || null
      );
    }

    if (kind === 'translation') {
      const code = target === 'es' ? 'es' : 'pt';
      return (
        bodies.find((body) => {
          const lang = body.tlang || body.lang || '';
          return lang === code || lang.startsWith(`${code}-`);
        }) || null
      );
    }

    return null;
  }

  function buildReaderLines() {
    const cues = state.originalCues || [];
    const translations = state.translationByCue || [];
    const lines = [];

    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      if (!cue || !cue.text) continue;

      const cueWords = Array.isArray(cue.words) && cue.words.length
        ? cue.words
        : makeWordTimings(cue.text, cue.start, cue.end);
      const translation = cleanText(translations[i] || '');
      const previous = lines.length ? lines[lines.length - 1] : null;

      if (previous) {
        const gap = cue.start - previous.end;
        const joinedLength = previous.text.length + 1 + cue.text.length;
        const previousEndsSentence = /[.!?…]["')\]]?\s*$/.test(previous.text);
        const previousDuration = previous.end - previous.start;

        if (
          gap <= 0.9 &&
          joinedLength <= 200 &&
          previousDuration <= 14 &&
          !previousEndsSentence
        ) {
          previous.text = cleanText(`${previous.text} ${cue.text}`);
          previous.end = Math.max(previous.end, cue.end);
          previous.words.push(...cueWords);
          if (translation) {
            previous.translation = cleanText(
              `${previous.translation} ${translation}`
            );
          }
          continue;
        }
      }

      lines.push({
        start: cue.start,
        end: cue.end,
        text: cue.text,
        translation,
        words: cueWords.slice(),
      });
    }

    lines.forEach((line) => line.words.sort((a, b) => a.start - b.start));
    return lines.map((line, index) => ({ ...line, id: index }));
  }

  function refreshReaderLines() {
    state.readerLines = buildReaderLines();
    state.readerRevision += 1;
  }

  function getVideoTitle() {
    const title =
      cleanText(
        (document.querySelector('h1.ytd-watch-metadata yt-formatted-string') || {})
          .textContent
      ) ||
      cleanText(
        (document.querySelector('#title h1 yt-formatted-string') || {}).textContent
      ) ||
      cleanText(
        (document.querySelector('#above-the-fold #title') || {}).textContent
      ) ||
      cleanText(document.title.replace(/\s*-\s*YouTube\s*$/i, ''));

    return title || 'Vídeo do YouTube';
  }

  function getChannelName() {
    return cleanText(
      (document.querySelector('#owner #channel-name a') || {}).textContent ||
      (document.querySelector('ytd-channel-name a') || {}).textContent ||
      ''
    );
  }

  function getReaderLightState() {
    const video = getVideo();
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;
    const currentTime = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;

    return {
      ok: true,
      videoId: state.videoId,
      title: getVideoTitle(),
      channel: getChannelName(),
      duration,
      currentTime: Math.min(currentTime, Math.max(0, duration || currentTime)),
      paused: video ? video.paused : true,
      ended: video ? video.ended : false,
      rate: video ? video.playbackRate : 1,
      muted: video ? video.muted : false,
      volume: video ? video.volume : 1,
      ad: isAd(),
      ready: state.ready,
      loading: state.loading,
      fallback: state.fallback,
      warning: state.warning,
      error: state.lastError,
      revision: state.readerRevision,
      lineCount: state.readerLines.length,
      targetLang: state.settings.targetLang,
      showTranslation: state.settings.showTranslation,
      audioMode: state.audioMode,
    };
  }

  function buildReaderState(full = false) {
    const data = getReaderLightState();
    if (full) data.lines = state.readerLines;
    return data;
  }

  function applyLowestQuality() {
    sendToPage('SET_QUALITY');
  }

  function restoreQuality() {
    sendToPage('RESTORE_QUALITY');
  }

  function ensureReaderOverlay() {
    const player = getPlayer();
    if (!player) return null;

    let overlay = document.getElementById('legrendas-reader-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'legrendas-reader-overlay';

      const title = document.createElement('strong');
      title.textContent = 'Modo leitura ativo';

      const text = document.createElement('span');
      text.textContent =
        'O áudio continua nesta aba. A transcrição está na janela do leitor.';

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Sair do modo leitura';
      button.addEventListener('click', () => {
        setReaderActive(false);
        try {
          chrome.runtime.sendMessage({
            type: 'legrendas:close-reader-for-tab',
          });
        } catch {
          // The extension may have been reloaded.
        }
      });

      overlay.append(title, text, button);
    }

    if (overlay.parentElement !== player) player.appendChild(overlay);
    state.readerOverlay = overlay;
    return overlay;
  }

  function syncReaderAudioVisuals() {
    if (!state.readerActive) {
      document.documentElement.classList.remove('legrendas-reader-audio');
      if (state.readerOverlay) state.readerOverlay.hidden = true;
      return;
    }

    const ad = isAd();
    document.documentElement.classList.toggle('legrendas-reader-audio', !ad);

    const overlay = ensureReaderOverlay();
    if (overlay) overlay.hidden = ad;
  }

  function enterAudioMode() {
    if (!state.audioMode) state.audioMode = true;
    applyLowestQuality();
    syncReaderAudioVisuals();
  }

  function exitAudioMode() {
    state.audioMode = false;
    document.documentElement.classList.remove('legrendas-reader-audio');
    if (state.readerOverlay) state.readerOverlay.remove();
    state.readerOverlay = null;
    restoreQuality();
  }

  function setReaderActive(active) {
    state.readerActive = !!active;
    if (state.readerActive) enterAudioMode();
    else exitAudioMode();
    return buildReaderState(false);
  }

  async function handleReaderCommand(action, value) {
    if (!state.settings.enabled) {
      return { ok: false, error: 'disabled' };
    }
    if (!isWatchPage()) {
      return { ok: false, error: 'not-watch' };
    }

    const video = getVideo();
    if (!video) return { ok: false, error: 'sem-video' };

    try {
      switch (action) {
        case 'play':
          if (video.ended) video.currentTime = 0;
          await video.play();
          break;
        case 'pause':
          video.pause();
          break;
        case 'toggle':
          if (video.paused) {
            if (video.ended) video.currentTime = 0;
            await video.play();
          } else {
            video.pause();
          }
          break;
        case 'seek': {
          const target = Math.max(0, Number(value) || 0);
          video.currentTime = Math.min(target, video.duration || target);
          break;
        }
        case 'seek-by': {
          const delta = Number(value) || 0;
          const target = Math.max(0, video.currentTime + delta);
          video.currentTime = Math.min(target, video.duration || target);
          break;
        }
        case 'rate': {
          const rate = Math.min(2, Math.max(0.5, Number(value) || 1));
          video.playbackRate = rate;
          break;
        }
        case 'mute':
          video.muted = typeof value === 'boolean' ? value : !video.muted;
          break;
        case 'retry':
          state.lastError = '';
          state.emptyRetries = 0;
          state.loading = false;
          stopFallback();
          requestCaptions();
          initVideo(0);
          break;
        default:
          return { ok: false, error: 'comando-desconhecido' };
      }

      syncOnce(true);
      if (state.readerActive) syncReaderAudioVisuals();
      return getReaderLightState();
    } catch (error) {
      return {
        ok: false,
        error: error && error.name === 'NotAllowedError' ? 'play-blocked' : String(error),
      };
    }
  }

  function setParam(rawUrl, key, value) {
    const pattern = new RegExp(`([?&])${key}=[^&]*`);
    if (pattern.test(rawUrl)) {
      return rawUrl.replace(pattern, `$1${key}=${encodeURIComponent(value)}`);
    }
    return `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
  }

  function stripParam(rawUrl, key) {
    return rawUrl
      .replace(new RegExp(`([?&])${key}=[^&]*`, 'g'), '$1')
      .replace(/[?&]{2,}/g, (match) => (match[0] === '?' ? '?' : '&'))
      .replace(/[?&]$/, '');
  }

  async function fetchCues(rawUrl, tlang, signal) {
    // Do not rebuild the query with URLSearchParams: it re-encodes "sparams"
    // and can invalidate the player's signature/token. Edit the raw string.
    let url = stripParam(rawUrl, 'tlang');
    url = setParam(url, 'fmt', 'json3');
    if (tlang) url = setParam(url, 'tlang', tlang);

    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();
    const clean = text.replace(/^\uFEFF/, '').trim();
    if (!clean) return [];
    if (clean.startsWith('<')) return parseXmlCaptions(clean);

    try {
      return parseJson3(JSON.parse(clean));
    } catch {
      return [];
    }
  }

  function urlVideoId(url) {
    try {
      return new URL(url, location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  function validUrl(url) {
    if (!url) return false;
    const videoId = urlVideoId(url);
    return !videoId || !state.videoId || videoId === state.videoId;
  }

  function isEnglish(item) {
    return !!item && (item.lang === 'en' || item.lang.startsWith('en-'));
  }

  function currentCaptures() {
    return (state.captured || []).filter((item) => validUrl(item.url));
  }

  function chooseCapturedUrl() {
    const captures = currentCaptures();
    if (!captures.length) return null;

    const english = captures.filter(isEnglish);
    const englishWithPot = english.filter((item) => item.pot);
    if (englishWithPot.length) return englishWithPot[englishWithPot.length - 1];

    const withPot = captures.filter((item) => item.pot);
    if (withPot.length) return withPot[withPot.length - 1];

    return captures[captures.length - 1];
  }

  function chooseEnglishTrack() {
    const tracks = (state.tracks || []).filter(
      (track) => track.baseUrl && isEnglish(track)
    );
    if (!tracks.length) return null;
    return (
      tracks.find((track) => track.kind !== 'asr') ||
      tracks.find((track) => track.kind === 'asr') ||
      tracks[0]
    );
  }

  function buildTrackUrl(track, captured) {
    if (!track || !track.baseUrl) return null;
    let url = track.baseUrl;
    if (!/^https?:\/\//i.test(url)) {
      url = url.startsWith('/') ? location.origin + url : new URL(url, location.href).href;
    }
    if (captured && captured.pot) url = setParam(url, 'pot', captured.pot);
    return url;
  }

  function pickOriginalUrl(captured, english) {
    if (captured && isEnglish(captured) && captured.pot) return captured.url;
    if (english) {
      const built = buildTrackUrl(english, captured);
      if (built) return built;
    }
    if (captured) return captured.url;
    return null;
  }

  function looksUntranslated(original, translated) {
    if (!original.length || !translated.length) return false;
    const count = Math.min(original.length, translated.length, 20);
    let same = 0;
    for (let i = 0; i < count; i += 1) {
      if (original[i].text.toLowerCase() === translated[i].text.toLowerCase()) same += 1;
    }
    return count > 0 && same / count >= 0.8;
  }

  async function fetchTranslated(url, target, original, signal) {
    const tries = target === 'pt-BR' ? ['pt-BR', 'pt'] : ['es'];
    for (const tlang of tries) {
      try {
        const cues = await fetchCues(url, tlang, signal);
        if (cues.length && !looksUntranslated(original, cues)) return cues;
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
      }
    }
    return [];
  }

  async function translateFallback(cues, target, signal) {
    const texts = cues.map((cue) => cue.text);
    const translated = [];
    const batchSize = 12;

    for (let i = 0; i < texts.length; i += batchSize) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = texts.slice(i, i + batchSize);
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'translate',
          texts: batch,
          target,
        });
        if (
          response &&
          Array.isArray(response.translations) &&
          response.translations.length === batch.length
        ) {
          translated.push(...response.translations);
        } else {
          translated.push(...batch.map(() => ''));
        }
      } catch {
        translated.push(...batch.map(() => ''));
      }
    }

    return cues
      .map((cue, index) => ({
        start: cue.start,
        end: cue.end,
        text: cleanText(translated[index]),
      }))
      .filter((cue) => cue.text);
  }

  function alignTranslation(original, translated) {
    if (!translated.length) return original.map(() => '');

    let cursor = 0;
    return original.map((source) => {
      while (cursor < translated.length && translated[cursor].end <= source.start) {
        cursor += 1;
      }

      let index = cursor;
      const parts = [];
      while (index < translated.length && translated[index].start < source.end) {
        if (translated[index].end > source.start) parts.push(translated[index].text);
        index += 1;
      }
      return cleanText(parts.join(' '));
    });
  }

  function applyCues(original, translated) {
    state.originalCues = original;
    state.translationCues = translated;
    state.translationByCue = translated.length
      ? alignTranslation(original, translated)
      : original.map(() => '');
    state.currentIndex = -1;
    state.ready = true;
    state.loading = false;
    state.fallback = false;
    refreshReaderLines();
    stopFallback();
    startSync();
    syncOnce(true);
    debug({ applied: true, cues: original.length, translated: translated.length });
  }

  async function loadTranslation(url, original, target, signal, sequence) {
    const token = ++state.translationToken;
    let translated = [];

    const captured = getCapturedBody('translation', target);
    if (captured) translated = parseBody(captured.text);

    if (!translated.length && url) {
      try {
        translated = await fetchTranslated(url, target, original, signal);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }

    if (sequence !== loadSeq || token !== state.translationToken || signal.aborted) return;

    if (!translated.length) {
      try {
        translated = await translateFallback(original, target, signal);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        translated = [];
      }
    }

    if (sequence !== loadSeq || token !== state.translationToken || signal.aborted) return;

    state.translationCues = translated;
    state.translationByCue = translated.length
      ? alignTranslation(original, translated)
      : original.map(() => '');
    state.currentIndex = -1;
    refreshReaderLines();
    syncOnce(true);
    debug({ translationReady: translated.length });
  }

  async function loadCues(options = {}) {
    if (!state.settings.enabled || !isWatchPage()) return;
    const videoId = getVideoId();
    if (!videoId) return;
    if (!options.allowNonEnglish && !hasEnglishSource()) return;
    if (!state.captured.length && !state.tracks.length && !state.capturedBodies.size) return;

    const captured = chooseCapturedUrl();
    const english = chooseEnglishTrack();
    const capturedBody = getCapturedBody('original');
    const url = pickOriginalUrl(captured, english) || (capturedBody && capturedBody.url) || null;
    if (!url && !capturedBody) return;

    const target = state.settings.targetLang || 'pt-BR';
    const key = `${videoId}|${target}|${url || (capturedBody && capturedBody.url) || 'body'}`;
    if (!options.force && state.ready && state.loadKey === key) return;
    if (!options.force && state.loading && state.loadKey === key) return;

    const sequence = ++loadSeq;
    if (state.abort) state.abort.abort();
    const controller = new AbortController();
    state.abort = controller;
    state.loading = true;
    state.loadKey = key;
    state.loadedTarget = target;
    state.warning = (captured && isEnglish(captured)) || capturedBody ? '' : 'sem-ingles';
    debug({
      loadUrl: url,
      capturedLang: captured && captured.lang,
      capturedPot: !!(captured && captured.pot),
      capturedBody: !!capturedBody,
    });

    try {
      let original = capturedBody ? parseBody(capturedBody.text) : [];
      if (!original.length && url) {
        original = await fetchCues(url, null, controller.signal);
        if (sequence !== loadSeq) return;
      }

      let usedUrl = url;
      if (!original.length && captured && captured.url && captured.url !== url) {
        original = await fetchCues(captured.url, null, controller.signal);
        if (sequence !== loadSeq) return;
        if (original.length) {
          usedUrl = captured.url;
          state.warning = 'sem-ingles';
        }
      }

      if (!original.length) {
        state.loading = false;
        state.lastError = 'empty-cues';
        debug({ loadResult: 'empty' });
        if (hasUsableSource() && state.emptyRetries < 1) {
          state.emptyRetries += 1;
          setTimeout(() => loadCues({ force: true }), 500);
          return;
        }
        startFallback();
        return;
      }

      state.emptyRetries = 0;
      state.loading = false;
      state.lastError = '';
      debug({ loadResult: 'ok', cues: original.length });
      applyCues(original, []);

      if (state.settings.showTranslation) {
        await loadTranslation(usedUrl, original, target, controller.signal, sequence);
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (sequence !== loadSeq) return;
      state.loading = false;
      state.lastError = error && error.message ? error.message : String(error);
      debug({ loadResult: 'error' });
      startFallback();
    }
  }

  function ensureTranslation() {
    if (!state.ready || !state.originalCues.length) return;
    if (state.translationByCue.some((text) => text)) {
      syncOnce(true);
      return;
    }

    const captured = chooseCapturedUrl();
    const english = chooseEnglishTrack();
    const capturedBody = getCapturedBody('translation', state.settings.targetLang);
    const url = pickOriginalUrl(captured, english) || (capturedBody && capturedBody.url) || null;

    const target = state.settings.targetLang;
    const sequence = loadSeq;
    const controller = state.abort || new AbortController();
    state.abort = controller;

    Promise.resolve()
      .then(async () => {
        let translated = capturedBody ? parseBody(capturedBody.text) : [];
        try {
          if (!translated.length && url) {
            translated = await fetchTranslated(url, target, state.originalCues, controller.signal);
          }
          if (!translated.length) {
            translated = await translateFallback(state.originalCues, target, controller.signal);
          }
        } catch (error) {
          if (error && error.name === 'AbortError') return;
        }

        if (sequence !== loadSeq) return;
        state.translationCues = translated;
        state.translationByCue = translated.length
          ? alignTranslation(state.originalCues, translated)
          : state.originalCues.map(() => '');
        state.currentIndex = -1;
        refreshReaderLines();
        syncOnce(true);
      })
      .catch(() => {});
  }

  function ensureCC() {
    const button = document.querySelector('.ytp-subtitles-button');
    if (!button) return false;
    if (button.getAttribute('aria-pressed') === 'false') {
      button.click();
      return true;
    }
    return false;
  }

  function hasUsableCapture() {
    return currentCaptures().some((item) => !!item.pot);
  }

  function hasUsableSource() {
    return hasUsableCapture() || state.capturedBodies.size > 0;
  }

  function hasEnglishSource() {
    return (
      !!getCapturedBody('original') ||
      currentCaptures().some((item) => isEnglish(item) && !!item.pot)
    );
  }

  function requestCaptions() {
    const button = document.querySelector('.ytp-subtitles-button');
    if (!button) return false;
    const isOn = button.getAttribute('aria-pressed') === 'true';
    if (isOn) {
      button.click();
      setTimeout(() => {
        if (button.getAttribute('aria-pressed') === 'false') button.click();
      }, 220);
    } else {
      button.click();
    }
    return true;
  }

  function startFallback() {
    if (!state.settings.enabled || !isWatchPage() || state.fallback) return;
    state.ready = false;
    state.fallback = true;
    state.currentIndex = -1;
    stopSync();
    ensureCC();
    setActiveClass(true);
    debug({ fallback: true });

    const loop = () => {
      if (!state.fallback) return;
      if (isAd()) {
        clearRows();
      } else {
        const text = cleanText(
          $$('.ytp-caption-segment')
            .map((element) => element.textContent || '')
            .join(' ')
        );
        setRow('original', text);
        setRow('translation', '');
      }
      state.fallbackRaf = requestAnimationFrame(loop);
    };
    state.fallbackRaf = requestAnimationFrame(loop);

    setTimeout(() => {
      if (state.fallback) ensureCC();
    }, 1200);
    setTimeout(() => {
      if (state.fallback) ensureCC();
    }, 3000);
  }

  function stopFallback() {
    state.fallback = false;
    if (state.fallbackRaf) cancelAnimationFrame(state.fallbackRaf);
    state.fallbackRaf = 0;
  }

  function fitFullscreenText() {
    if (!state.isFullscreen || state.settings.fullscreen !== 'shrink') return;
    const dock = state.shadow && state.shadow.querySelector('.dock');
    if (!dock) return;

    const base = Number(state.settings.fontSize) || 20;
    let size = base;
    dock.style.setProperty('--font-size', `${size}px`);

    let guard = 0;
    while (dock.scrollHeight > dock.clientHeight + 1 && size > 12 && guard < 20) {
      size -= 1;
      dock.style.setProperty('--font-size', `${size}px`);
      guard += 1;
    }
  }

  function enterFullscreenLayout(player) {
    if (!player || !state.host) return;

    const size = Number(state.settings.fontSize) || 20;
    const height = Math.max(88, Math.round(size * 4.2));

    player.style.setProperty('--legrendas-fs-h', `${height}px`);
    player.classList.add('legrendas-fs');

    state.host.classList.add('legrendas-fs-host');
    state.host.style.display = 'block';
    state.host.style.position = 'absolute';
    state.host.style.left = '0';
    state.host.style.right = '0';
    state.host.style.bottom = '0';
    state.host.style.width = '100%';
    state.host.style.margin = '0';
    state.host.style.zIndex = '60';
    state.host.style.height = `${height}px`;

    if (state.host.parentElement !== player) player.appendChild(state.host);

    state.isFullscreen = true;
    fitFullscreenText();
  }

  function exitFullscreenLayout() {
    const player = getPlayer();
    if (player) {
      player.classList.remove('legrendas-fs');
      player.style.removeProperty('--legrendas-fs-h');
    }

    if (!state.host) return;

    state.host.classList.remove('legrendas-fs-host');
    state.host.style.display = '';
    state.host.style.position = '';
    state.host.style.left = '';
    state.host.style.right = '';
    state.host.style.bottom = '';
    state.host.style.zIndex = '';
    state.host.style.height = '';
    state.host.style.margin = '';
    state.host.style.width = '100%';

    const dock = state.shadow && state.shadow.querySelector('.dock');
    if (dock) dock.style.removeProperty('--font-size');

    if (state.settings.enabled && isWatchPage()) {
      placeDock();
      applyFontSize();
    } else {
      state.host.remove();
    }
  }

  function onFullscreenChange() {
    const fullscreenElement = document.fullscreenElement;
    const player = getPlayer();
    const inPlayerFullscreen = !!(
      fullscreenElement &&
      player &&
      (fullscreenElement === player ||
        fullscreenElement.contains(player) ||
        player.contains(fullscreenElement))
    );

    state.isFullscreen = inPlayerFullscreen;

    if (!inPlayerFullscreen) {
      exitFullscreenLayout();
      return;
    }

    if (!state.settings.enabled || !state.host) return;

    if (state.settings.fullscreen === 'hide') {
      state.host.style.display = 'none';
      if (player) {
        player.classList.remove('legrendas-fs');
        player.style.removeProperty('--legrendas-fs-h');
      }
      return;
    }

    enterFullscreenLayout(player);
  }

  function resetForVideo(videoId) {
    state.videoId = videoId;
    state.ready = false;
    state.loading = false;
    state.fallback = false;
    state.originalCues = [];
    state.translationCues = [];
    state.translationByCue = [];
    state.readerLines = [];
    state.readerRevision += 1;
    state.currentIndex = -1;
    state.captured = [];
    state.capturedBodies.clear();
    state.tracks = [];
    state.loadKey = '';
    state.loadedTarget = null;
    state.warning = '';
    state.translationToken += 1;
    state.emptyRetries = 0;
    loadSeq += 1;

    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }

    stopSync();
    stopFallback();
    clearRows();
    debug({ reset: true });
  }

  function initVideo(attempt = 0) {
    if (!state.settings.enabled) return;

    const videoId = getVideoId();
    if (!videoId || !isWatchPage()) return;
    if (videoId !== state.videoId) resetForVideo(videoId);

    const player = getPlayer();
    if (!player) {
      if (attempt < 20) setTimeout(() => initVideo(attempt + 1), 250);
      return;
    }

    mountDock();
    attachVideoEvents();
    observePlayer();
    sendToPage('GET');
    ensureCC();
    if (state.readerActive) enterAudioMode();
    debug({ init: true, attempt });

    clearTimeout(state.retryTimer);
    let tries = 0;

    const retry = () => {
      if (!state.settings.enabled || !isWatchPage()) return;
      if (state.ready || state.fallback) return;

      const usable = hasUsableSource();
      const english = hasEnglishSource();
      if (!state.loading && usable && (english || tries >= 6)) {
        loadCues({ allowNonEnglish: tries >= 6 });
      } else if (!english && (tries === 1 || tries === 3 || tries === 5)) {
        sendToPage('FORCE_EN');
        requestCaptions();
      }

      tries += 1;
      if (tries < 8) {
        state.retryTimer = setTimeout(retry, 700);
      } else if (!state.ready) {
        if (state.loading) {
          state.retryTimer = setTimeout(retry, 700);
        } else {
          startFallback();
        }
      }
    };
    state.retryTimer = setTimeout(retry, 500);

    clearTimeout(state.ccTimer);
    let ccTries = 0;

    const ensure = () => {
      if (state.ready || state.fallback) return;
      ensureCC();
      ccTries += 1;
      if (ccTries < 5) state.ccTimer = setTimeout(ensure, 600);
    };
    state.ccTimer = setTimeout(ensure, 600);
  }

  function onNavigate() {
    if (!state.settings.enabled) return;

    const videoId = getVideoId();
    if (!isWatchPage()) {
      unmountDock();
      resetForVideo(null);
      return;
    }

    if (videoId !== state.videoId) {
      resetForVideo(videoId);
      sendToPage('RESET');
    }

    clearTimeout(state.navTimer);
    state.navTimer = setTimeout(() => initVideo(0), 350);
  }

  function applySettings(previous = {}) {
    if (!state.settings.enabled) {
      if (state.readerActive) {
        try {
          chrome.runtime.sendMessage({
            type: 'legrendas:close-reader-for-tab',
          });
        } catch {
          // ignore
        }
        setReaderActive(false);
      }
      unmountDock();
      return;
    }

    const videoId = getVideoId();
    if (videoId !== state.videoId) {
      resetForVideo(videoId);
      sendToPage('RESET');
    }

    if (!isWatchPage()) {
      unmountDock();
      return;
    }

    mountDock();
    applyFontSize();

    if (previous.targetLang && previous.targetLang !== state.settings.targetLang) {
      loadSeq += 1;
      state.translationToken += 1;
      state.emptyRetries = 0;
      if (state.abort) {
        state.abort.abort();
        state.abort = null;
      }
      if (state.ready) {
        state.translationByCue = state.originalCues.map(() => '');
        state.currentIndex = -1;
        refreshReaderLines();
        syncOnce(true);
        if (state.settings.showTranslation) ensureTranslation();
      } else if (state.loading) {
        state.loading = false;
        state.loadKey = '';
        initVideo(0);
      }
    }

    if (previous.showTranslation && !state.settings.showTranslation) {
      setRow('translation', '');
    }

    if (!previous.showTranslation && state.settings.showTranslation && state.ready) {
      ensureTranslation();
    }

    if (previous.fullscreen && previous.fullscreen !== state.settings.fullscreen) {
      onFullscreenChange();
    }

    if (!state.ready && !state.loading) initVideo(0);
    if (state.ready) syncOnce(true);
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;
    state.messageCount += 1;
    state.lastMessage = {
      type: data.type,
      videoId: data.videoId || null,
      urls: Array.isArray(data.urls) ? data.urls.length : null,
      tracks: Array.isArray(data.tracks) ? data.tracks.length : null,
      at: Date.now(),
    };
    if (data.videoId && state.videoId && data.videoId !== state.videoId) return;

    if (data.type === 'CAPTURE' && Array.isArray(data.urls)) {
      const fresh = data.urls.filter((item) => validUrl(item.url));
      // A late empty update (for example from a SPA event) must not erase a
      // useful capture that arrived a moment earlier.
      if (fresh.length || state.captured.length === 0) state.captured = fresh;
      debug({ captureMessage: data.urls.length, freshCaptures: fresh.length });

      if (!state.settings.enabled || !isWatchPage()) return;

      if (hasEnglishSource()) {
        if (state.fallback) stopFallback();
        if (!state.ready && !state.loading) loadCues();
      } else if (
        state.ready &&
        state.warning &&
        data.urls.some(isEnglish) &&
        data.urls.some((item) => item.pot)
      ) {
        loadCues({ force: true });
      }
    } else if (data.type === 'TRACKS' && Array.isArray(data.tracks)) {
      state.tracks = data.tracks;
      debug({ trackMessage: data.tracks.length });
      if (
        state.settings.enabled &&
        isWatchPage() &&
        hasEnglishSource() &&
        !state.ready &&
        !state.loading
      ) {
        loadCues();
      }
    } else if (data.type === 'CUES' && data.body && data.body.url) {
      if (!validUrl(data.body.url)) return;
      state.capturedBodies.set(data.body.url, data.body);
      if (state.capturedBodies.size > 12) {
        const oldest = Array.from(state.capturedBodies.entries()).sort(
          (a, b) => (a[1].at || 0) - (b[1].at || 0)
        )[0];
        if (oldest) state.capturedBodies.delete(oldest[0]);
      }
      debug({
        body: {
          lang: data.body.lang,
          tlang: data.body.tlang,
          length: data.body.text ? data.body.text.length : 0,
        },
      });

      if (state.settings.enabled && isWatchPage()) {
        if (hasEnglishSource()) {
          if (state.fallback) stopFallback();
          if (!state.ready && !state.loading) loadCues();
          else if (state.ready && state.warning && !state.loading) loadCues({ force: true });
        } else if (!state.ready) {
          sendToPage('FORCE_EN');
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (!message.type.startsWith('legrendas:')) return undefined;

    if (message.type === 'legrendas:reader-active') {
      if (!state.settings.enabled || !isWatchPage()) {
        sendResponse({ ok: false, error: 'indisponivel' });
        return false;
      }
      setReaderActive(true);
      syncReaderAudioVisuals();
      sendResponse({ ok: true, state: buildReaderState(false) });
      return false;
    }

    if (message.type === 'legrendas:reader-closed') {
      setReaderActive(false);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'legrendas:reader-state') {
      if (!state.settings.enabled) {
        sendResponse({ ok: false, error: 'disabled' });
        return false;
      }
      if (!isWatchPage()) {
        sendResponse({ ok: false, error: 'not-watch' });
        return false;
      }
      if (message.reader && !state.readerActive) setReaderActive(true);
      syncReaderAudioVisuals();
      sendResponse(buildReaderState(!!message.full));
      return false;
    }

    if (message.type === 'legrendas:reader-command') {
      if (message.reader && !state.readerActive && state.settings.enabled && isWatchPage()) {
        setReaderActive(true);
      }
      handleReaderCommand(message.action, message.value).then(
        (result) => sendResponse(result),
        (error) => sendResponse({ ok: false, error: String(error) })
      );
      return true;
    }

    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const previous = { ...state.settings };
    let changed = false;

    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) {
        state.settings[key] = changes[key].newValue == null
          ? DEFAULTS[key]
          : changes[key].newValue;
        changed = true;
      }
    }

    if (changed) {
      normalizeSettings();
      applySettings(previous);
    }
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('resize', updateDockWidth);
  window.addEventListener('yt-navigate-finish', () => {
    state.lastHref = location.href;
    onNavigate();
  });
  window.addEventListener('yt-page-data-updated', () => {
    sendToPage('READ_TRACKS');
  });
  window.addEventListener('popstate', () => {
    state.lastHref = location.href;
    onNavigate();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      updateDockWidth();
      syncOnce(true);
    }
  });

  setInterval(() => {
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      onNavigate();
    }
  }, 1000);

  let wasAd = false;
  setInterval(() => {
    if (!state.settings.enabled || !isWatchPage()) {
      wasAd = false;
      return;
    }
    const ad = isAd();
    if (wasAd && !ad) {
      wasAd = false;
      if (state.readerActive) {
        applyLowestQuality();
        syncReaderAudioVisuals();
      }
      setTimeout(() => {
        if (!state.settings.enabled || !isWatchPage() || state.ready) return;
        stopFallback();
        state.loading = false;
        state.loadKey = '';
        requestCaptions();
        initVideo(0);
      }, 700);
      return;
    }
    wasAd = ad;
    if (state.readerActive && ad) syncReaderAudioVisuals();
  }, 500);

  loadSettings().then(() => {
    state.lastHref = location.href;
    if (state.settings.enabled) {
      onNavigate();
    } else {
      setReaderActive(false);
      unmountDock();
      try {
        chrome.runtime.sendMessage({
          type: 'legrendas:close-reader-for-tab',
        });
      } catch {
        // ignore
      }
    }
  });
})();
