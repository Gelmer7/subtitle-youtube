(() => {
  'use strict';

  const CHANNEL = 'legrendas';

  function isMobileSite() {
    return location.hostname === 'm.youtube.com';
  }

  const state = {
    settings: { enabled: true },
    videoId: null,
    tracks: [],
    captured: [],
    capturedBodies: new Map(),
    originalCues: [],
    readerLines: [],
    ready: false,
    loading: false,
    abort: null,
    loadKey: '',
    retryTimer: 0,
    ccTimer: 0,
    navTimer: 0,
    lastHref: location.href,
    warning: '',
    lastError: '',
    lastMessage: null,
    messageCount: 0,
    readerActive: false,
    readerRevision: 0,
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
    let safeEnd = Number.isFinite(end)
      ? end
      : safeStart + Math.max(0.8, tokens.length * 0.3);
    if (safeEnd <= safeStart) {
      safeEnd = safeStart + Math.max(0.8, tokens.length * 0.3);
    }

    const totalWeight = tokens.reduce(
      (sum, token) => sum + Math.max(1, token.length),
      0
    );
    let cursor = safeStart;

    return tokens.map((token, index) => {
      const share = Math.max(1, token.length) / totalWeight;
      const wordStart = cursor;
      let wordEnd =
        index === tokens.length - 1
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
      return makeWordTimings(
        parts.map((part) => part.text).join(' '),
        start,
        end
      );
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
      let partEnd =
        Number.isFinite(nextStart) && nextStart > starts[index]
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
      'legrendas-mobile',
      isMobileSite()
    );
    document.documentElement.classList.toggle(
      'legrendas-active',
      !!on && state.settings.enabled
    );
  }

  function cleanupLegacyUi() {
    for (const id of ['legrendas-host', 'legrendas-reader-overlay']) {
      const element = document.getElementById(id);
      if (element) element.remove();
    }

    const player = getPlayer();
    if (player) {
      player.classList.remove('legrendas-fs');
      player.style.removeProperty('--legrendas-fs-h');
    }
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
        warning: state.warning,
        cues: state.originalCues.length,
        error: state.lastError,
        messageCount: state.messageCount,
        lastMessage: state.lastMessage,
        readerActive: state.readerActive,
        ...extra,
      });
    } catch {
      // Debug output must never break the extension.
    }
  }

  function loadSettings() {
    return chrome.storage.sync
      .get({ enabled: true })
      .then((stored) => {
        state.settings.enabled = stored.enabled !== false;
      })
      .catch(() => {
        state.settings.enabled = true;
      });
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

  function getCapturedBody() {
    const bodies = Array.from(state.capturedBodies.values())
      .filter((body) => validUrl(body.url))
      .sort((a, b) => (b.at || 0) - (a.at || 0));

    return (
      bodies.find(
        (body) => !body.tlang && isEnglish(body)
      ) || null
    );
  }

  function buildReaderLines() {
    const cues = state.originalCues || [];
    const lines = [];

    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      if (!cue || !cue.text) continue;

      const cueWords =
        Array.isArray(cue.words) && cue.words.length
          ? cue.words
          : makeWordTimings(cue.text, cue.start, cue.end);
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
          continue;
        }
      }

      lines.push({
        start: cue.start,
        end: cue.end,
        text: cue.text,
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

  function getReaderLightState() {
    const video = getVideo();
    const duration =
      video && Number.isFinite(video.duration) ? video.duration : 0;
    const currentTime =
      video && Number.isFinite(video.currentTime) ? video.currentTime : 0;

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
      warning: state.warning,
      error: state.lastError,
      revision: state.readerRevision,
      lineCount: state.readerLines.length,
    };
  }

  function buildReaderState(full = false) {
    const data = getReaderLightState();
    if (full) data.lines = state.readerLines;
    return data;
  }

  function setReaderActive(active) {
    state.readerActive = !!active;
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
          video.muted =
            typeof value === 'boolean' ? value : !video.muted;
          break;
        case 'retry':
          state.lastError = '';
          state.loading = false;
          state.loadKey = '';
          requestCaptions();
          initVideo(0);
          break;
        default:
          return { ok: false, error: 'comando-desconhecido' };
      }

      return getReaderLightState();
    } catch (error) {
      return {
        ok: false,
        error:
          error && error.name === 'NotAllowedError'
            ? 'play-blocked'
            : String(error),
      };
    }
  }

  function setParam(rawUrl, key, value) {
    const pattern = new RegExp(`([?&])${key}=[^&]*`);
    if (pattern.test(rawUrl)) {
      return rawUrl.replace(
        pattern,
        `$1${key}=${encodeURIComponent(value)}`
      );
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
    return (
      !!item &&
      typeof item.lang === 'string' &&
      (item.lang === 'en' || item.lang.startsWith('en-'))
    );
  }

  function currentCaptures() {
    return (state.captured || []).filter((item) => validUrl(item.url));
  }

  function chooseCapturedUrl() {
    const captures = currentCaptures();
    if (!captures.length) return null;

    const english = captures.filter(isEnglish);
    const englishWithPot = english.filter((item) => item.pot);
    if (englishWithPot.length) {
      return englishWithPot[englishWithPot.length - 1];
    }

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
      url = url.startsWith('/')
        ? location.origin + url
        : new URL(url, location.href).href;
    }
    if (captured && captured.pot) url = setParam(url, 'pot', captured.pot);
    return url;
  }

  function pickOriginalUrl(captured, english) {
    if (captured && isEnglish(captured) && captured.pot) {
      return captured.url;
    }
    if (english) {
      const built = buildTrackUrl(english, captured);
      if (built) return built;
    }
    if (captured) return captured.url;
    return null;
  }

  async function loadCues(options = {}) {
    if (!state.settings.enabled || !isWatchPage()) return;
    const videoId = getVideoId();
    if (!videoId) return;
    if (!options.allowNonEnglish && !hasEnglishSource()) return;
    if (
      !state.captured.length &&
      !state.tracks.length &&
      !state.capturedBodies.size
    ) {
      return;
    }

    const captured = chooseCapturedUrl();
    const english = chooseEnglishTrack();
    const capturedBody = getCapturedBody();
    const url =
      pickOriginalUrl(captured, english) ||
      (capturedBody && capturedBody.url) ||
      null;
    if (!url && !capturedBody) return;

    const key = `${videoId}|${url || (capturedBody && capturedBody.url) || 'body'}`;
    if (!options.force && state.ready && state.loadKey === key) return;
    if (!options.force && state.loading && state.loadKey === key) return;

    const sequence = ++loadSeq;
    if (state.abort) state.abort.abort();
    const controller = new AbortController();
    state.abort = controller;
    state.loading = true;
    state.loadKey = key;
    state.warning =
      (captured && isEnglish(captured)) || capturedBody ? '' : 'sem-ingles';
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

      if (
        !original.length &&
        captured &&
        captured.url &&
        captured.url !== url
      ) {
        original = await fetchCues(
          captured.url,
          null,
          controller.signal
        );
        if (sequence !== loadSeq) return;
        if (original.length) state.warning = 'sem-ingles';
      }

      if (!original.length) {
        state.loading = false;
        state.lastError = 'empty-cues';
        state.ready = false;
        debug({ loadResult: 'empty' });
        return;
      }

      state.loading = false;
      state.lastError = '';
      debug({ loadResult: 'ok', cues: original.length });
      applyCues(original);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (sequence !== loadSeq) return;
      state.loading = false;
      state.ready = false;
      state.lastError =
        error && error.message ? error.message : String(error);
      debug({ loadResult: 'error' });
    }
  }

  function applyCues(original) {
    state.originalCues = original;
    state.ready = true;
    state.loading = false;
    state.lastError = '';
    refreshReaderLines();
    debug({
      applied: true,
      cues: original.length,
    });
  }

  function setPlayerCaptions(player, track) {
    if (!player || typeof player.setOption !== 'function') return false;
    try {
      player.setOption('captions', 'track', track);
      return true;
    } catch {
      return false;
    }
  }

  function ensureCC() {
    const player = getPlayer();

    if (
      isMobileSite() &&
      setPlayerCaptions(player, { languageCode: 'en' })
    ) {
      return true;
    }

    const button = document.querySelector('.ytp-subtitles-button');
    if (button) {
      if (button.getAttribute('aria-pressed') === 'false') button.click();
      return true;
    }

    return setPlayerCaptions(player, { languageCode: 'en' });
  }

  function hasUsableCapture() {
    return currentCaptures().some((item) => !!item.pot);
  }

  function hasUsableSource() {
    return hasUsableCapture() || state.capturedBodies.size > 0;
  }

  function hasEnglishSource() {
    return !!getCapturedBody() ||
      currentCaptures().some(
        (item) => isEnglish(item) && !!item.pot
      );
  }

  function requestCaptions() {
    const player = getPlayer();

    if (isMobileSite() && setPlayerCaptions(player, {})) {
      setTimeout(() => {
        setPlayerCaptions(getPlayer(), { languageCode: 'en' });
      }, 250);
      return true;
    }

    const button = document.querySelector('.ytp-subtitles-button');
    if (button) {
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

    if (setPlayerCaptions(player, {})) {
      setTimeout(() => {
        setPlayerCaptions(getPlayer(), { languageCode: 'en' });
      }, 250);
      return true;
    }

    return false;
  }

  function resetForVideo(videoId) {
    state.videoId = videoId;
    state.ready = false;
    state.loading = false;
    state.originalCues = [];
    state.readerLines = [];
    state.readerRevision += 1;
    state.captured = [];
    state.capturedBodies.clear();
    state.tracks = [];
    state.loadKey = '';
    state.warning = '';
    state.lastError = '';
    loadSeq += 1;

    clearTimeout(state.retryTimer);
    clearTimeout(state.ccTimer);
    state.retryTimer = 0;
    state.ccTimer = 0;

    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }

    debug({ reset: true });
  }

  function initVideo(attempt = 0) {
    if (!state.settings.enabled) return;

    const videoId = getVideoId();
    if (!videoId || !isWatchPage()) return;
    if (videoId !== state.videoId) resetForVideo(videoId);

    const player = getPlayer();
    if (!player) {
      if (attempt < 20) {
        setTimeout(() => initVideo(attempt + 1), 250);
      }
      return;
    }

    setActiveClass(true);
    sendToPage('GET');
    ensureCC();
    debug({ init: true, attempt });

    clearTimeout(state.retryTimer);
    let tries = 0;

    const retry = () => {
      if (!state.settings.enabled || !isWatchPage()) return;
      if (state.ready) return;

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
          if (!state.lastError) state.lastError = 'empty-cues';
          debug({ result: 'empty' });
        }
      }
    };
    state.retryTimer = setTimeout(retry, 500);

    clearTimeout(state.ccTimer);
    let ccTries = 0;

    const ensure = () => {
      if (state.ready) return;
      ensureCC();
      ccTries += 1;
      if (ccTries < 5) state.ccTimer = setTimeout(ensure, 600);
    };
    state.ccTimer = setTimeout(ensure, 600);
  }

  function deactivatePage() {
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
    }
    setReaderActive(false);
    setActiveClass(false);
  }

  function onNavigate() {
    if (!state.settings.enabled) return;

    const videoId = getVideoId();
    if (!isWatchPage()) {
      deactivatePage();
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

  function applySettings() {
    if (!state.settings.enabled) {
      try {
        chrome.runtime.sendMessage({
          type: 'legrendas:close-reader-for-tab',
        });
      } catch {
        // ignore
      }
      deactivatePage();
      return;
    }

    cleanupLegacyUi();
    if (!isWatchPage()) {
      deactivatePage();
      return;
    }

    const videoId = getVideoId();
    if (videoId !== state.videoId) {
      resetForVideo(videoId);
      sendToPage('RESET');
    }

    setActiveClass(true);
    if (!state.ready && !state.loading) initVideo(0);
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
    if (data.videoId && state.videoId && data.videoId !== state.videoId) {
      return;
    }

    if (data.type === 'CAPTURE' && Array.isArray(data.urls)) {
      const fresh = data.urls.filter((item) => validUrl(item.url));
      // A late empty update (for example from a SPA event) must not erase a
      // useful capture that arrived a moment earlier.
      if (fresh.length || state.captured.length === 0) state.captured = fresh;
      debug({
        captureMessage: data.urls.length,
        freshCaptures: fresh.length,
      });

      if (!state.settings.enabled || !isWatchPage()) return;

      if (hasEnglishSource()) {
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
          if (!state.ready && !state.loading) loadCues();
          else if (state.ready && state.warning && !state.loading) {
            loadCues({ force: true });
          }
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
      sendResponse(buildReaderState(!!message.full));
      return false;
    }

    if (message.type === 'legrendas:reader-command') {
      if (
        message.reader &&
        !state.readerActive &&
        state.settings.enabled &&
        isWatchPage()
      ) {
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
    if (area !== 'sync' || !changes.enabled) return;
    state.settings.enabled = changes.enabled.newValue !== false;
    applySettings();
  });

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
      setTimeout(() => {
        if (!state.settings.enabled || !isWatchPage() || state.ready) return;
        state.loading = false;
        state.loadKey = '';
        requestCaptions();
        initVideo(0);
      }, 700);
      return;
    }
    wasAd = ad;
  }, 500);

  loadSettings().then(() => {
    cleanupLegacyUi();
    state.lastHref = location.href;
    if (state.settings.enabled) {
      onNavigate();
    } else {
      deactivatePage();
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
