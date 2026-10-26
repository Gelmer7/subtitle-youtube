(() => {
  'use strict';

  if (window.__legrendasInjected) return;
  window.__legrendasInjected = true;

  const CHANNEL = 'legrendas';
  const state = {
    videoId: null,
    urls: [],
    tracks: [],
  };
  const seen = new Set();
  let postTimer = 0;
  const log = [];
  const bodies = new Map();
  const QUALITY_ORDER = [
    'highres',
    'hd2880',
    'hd2160',
    'hd1440',
    'hd1080',
    'hd720',
    'large',
    'medium',
    'small',
    'tiny',
  ];
  let savedQuality = null;
  let qualityActive = false;
  let qualityTimer = 0;

  function currentVideoId() {
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

  function post(type, extra = {}) {
    log.push({
      type,
      at: Date.now(),
      videoId: state.videoId,
      urls: extra.urls ? extra.urls.length : null,
      tracks: extra.tracks ? extra.tracks.length : null,
    });
    if (log.length > 120) log.shift();
    try {
      window.postMessage(
        { source: CHANNEL, type, videoId: state.videoId, ...extra },
        '*'
      );
    } catch {
      // ignore
    }
  }

  function schedulePost() {
    clearTimeout(postTimer);
    postTimer = window.setTimeout(() => {
      post('CAPTURE', { urls: state.urls.slice(-12) });
    }, 80);
  }

  function absoluteRaw(raw) {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return location.protocol + raw;
    if (raw.startsWith('/')) return location.origin + raw;
    try {
      return new URL(raw, location.href).href;
    } catch {
      return raw;
    }
  }

  function capture(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.includes('/api/timedtext')) return;

    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return;
    }

    const videoId = url.searchParams.get('v') || currentVideoId();
    if (!videoId) return;

    // Ignore pre-roll ads and preloaded players: their timedtext URLs belong to
    // another video and often have no valid "pot" token.
    const pageVideoId = currentVideoId();
    if (pageVideoId && videoId !== pageVideoId) return;

    if (state.videoId && state.videoId !== videoId) {
      state.videoId = videoId;
      state.urls = [];
      state.tracks = [];
      seen.clear();
    } else {
      state.videoId = videoId;
    }

    // Keep the exact raw query string. Re-serialising it through URLSearchParams
    // percent-encodes "sparams" and can invalidate the signature/token.
    const href = absoluteRaw(rawUrl);
    if (seen.has(href)) return;
    seen.add(href);

    state.urls.push({
      url: href,
      lang: (url.searchParams.get('lang') || '').toLowerCase(),
      kind: url.searchParams.get('kind') || '',
      pot: url.searchParams.get('pot') || '',
      fmt: url.searchParams.get('fmt') || '',
      at: Date.now(),
    });

    if (state.urls.length > 30) state.urls.shift();
    schedulePost();
  }

  function captureBody(rawUrl, text) {
    if (!text || !text.trim()) return;

    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      return;
    }
    if (!url.pathname.includes('/api/timedtext')) return;

    const videoId = url.searchParams.get('v') || currentVideoId();
    const pageVideoId = currentVideoId();
    if (pageVideoId && videoId && videoId !== pageVideoId) return;

    const href = absoluteRaw(rawUrl);
    if (bodies.has(href)) return;

    const entry = {
      url: href,
      lang: (url.searchParams.get('lang') || '').toLowerCase(),
      tlang: (url.searchParams.get('tlang') || '').toLowerCase(),
      kind: url.searchParams.get('kind') || '',
      text,
      at: Date.now(),
    };

    bodies.set(href, entry);
    if (bodies.size > 12) {
      const first = bodies.keys().next().value;
      if (first) bodies.delete(first);
    }

    // The response body is the ground truth: no second request, no signature
    // or token issues. The content script parses it directly.
    post('CUES', { body: entry });
  }

  function readTracks() {
    try {
      const player = document.getElementById('movie_player');
      const response = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
      const videoId =
        (response && response.videoDetails && response.videoDetails.videoId) ||
        currentVideoId();

      if (!videoId) return;

      const pageVideoId = currentVideoId();
      if (pageVideoId && videoId !== pageVideoId) return;

      if (state.videoId && state.videoId !== videoId) {
        state.videoId = videoId;
        state.urls = [];
        seen.clear();
      } else {
        state.videoId = videoId;
      }

      const raw =
        response &&
        response.captions &&
        response.captions.playerCaptionsTracklistRenderer &&
        response.captions.playerCaptionsTracklistRenderer.captionTracks;

      state.tracks = Array.isArray(raw)
        ? raw.map((track) => ({
            lang: (track.languageCode || '').toLowerCase(),
            kind: track.kind || '',
            name:
              (track.name && track.name.simpleText) ||
              (track.name && track.name.runs && track.name.runs.map((run) => run.text).join('')) ||
              track.languageCode ||
              '',
            baseUrl: track.baseUrl || '',
            translatable: !!track.isTranslatable,
          }))
        : [];

      post('TRACKS', { tracks: state.tracks });
    } catch {
      // The player may not be ready yet.
    }
  }

  function forceEnglish() {
    try {
      const player = document.getElementById('movie_player');
      if (!player || typeof player.setOption !== 'function') return false;
      player.setOption('captions', 'track', { languageCode: 'en' });
      return true;
    } catch {
      return false;
    }
  }

  function lowestAvailableQuality(player) {
    const levels =
      player && typeof player.getAvailableQualityLevels === 'function'
        ? player.getAvailableQualityLevels() || []
        : [];
    let lowest = levels[levels.length - 1] || 'tiny';

    for (const level of levels) {
      if (QUALITY_ORDER.indexOf(level) > QUALITY_ORDER.indexOf(lowest)) {
        lowest = level;
      }
    }
    return lowest;
  }

  function setPlaybackQuality(player, quality) {
    try {
      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(quality, quality);
      }
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(quality);
      }
    } catch {
      // The audio must keep playing even if quality control is unavailable.
    }
  }

  function applyLowestQuality() {
    const player = document.getElementById('movie_player');
    if (!player) return;

    if (!qualityActive) {
      qualityActive = true;
      savedQuality =
        typeof player.getPlaybackQuality === 'function'
          ? player.getPlaybackQuality()
          : null;
    }

    const lowest = lowestAvailableQuality(player);
    setPlaybackQuality(player, lowest);

    clearTimeout(qualityTimer);
    let attempts = 0;

    const retry = () => {
      if (!qualityActive) return;
      const currentPlayer = document.getElementById('movie_player');
      if (!currentPlayer) return;

      const current =
        typeof currentPlayer.getPlaybackQuality === 'function'
          ? currentPlayer.getPlaybackQuality()
          : null;

      if (current === lowest || attempts >= 6) return;
      attempts += 1;
      setPlaybackQuality(currentPlayer, lowest);
      qualityTimer = setTimeout(retry, 1200);
    };

    const current =
      typeof player.getPlaybackQuality === 'function'
        ? player.getPlaybackQuality()
        : null;

    if (current !== lowest) qualityTimer = setTimeout(retry, 1000);
  }

  function restoreQuality() {
    qualityActive = false;
    clearTimeout(qualityTimer);
    qualityTimer = 0;

    const player = document.getElementById('movie_player');
    const quality = savedQuality;
    savedQuality = null;

    if (!player || !quality) return;
    setPlaybackQuality(player, quality);
  }

  function reset() {
    state.videoId = currentVideoId();
    state.urls = [];
    state.tracks = [];
    seen.clear();
    bodies.clear();
    post('RESET', {});
  }

  // Capture the player's own timedtext requests. The current YouTube player
  // includes a per-request "pot" token in those URLs; a direct fetch without it
  // usually returns an empty body.
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      let url = null;
      try {
        const input = args[0];
        url = typeof input === 'string' ? input : input && input.url;
        if (typeof url === 'string' && url.includes('/api/timedtext')) capture(url);
        else url = null;
      } catch {
        // never break the page
      }

      const promise = originalFetch.apply(this, args);

      if (url && promise && typeof promise.then === 'function') {
        promise
          .then((response) => {
            try {
              const copy = response.clone();
              copy
                .text()
                .then((text) => captureBody(url, text))
                .catch(() => {});
            } catch {
              // The page may already have consumed the body.
            }
          })
          .catch(() => {});
      }

      return promise;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && url.includes('/api/timedtext')) {
        this.__legrendasTimedtextUrl = absoluteRaw(url);
        capture(url);
      } else {
        this.__legrendasTimedtextUrl = null;
      }
    } catch {
      // ignore
    }
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const timedtextUrl = this.__legrendasTimedtextUrl;
    if (timedtextUrl) {
      this.addEventListener('load', () => {
        try {
          if (this.responseText) captureBody(timedtextUrl, this.responseText);
        } catch {
          // responseType may not be text.
        }
      });
    }
    return originalSend.apply(this, args);
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry && typeof entry.name === 'string' && entry.name.includes('/api/timedtext')) {
          capture(entry.name);
        }
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    // PerformanceObserver is optional.
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== CHANNEL + '-content') return;

    switch (data.type) {
      case 'GET':
        state.videoId = currentVideoId();
        readTracks();
        post('CAPTURE', { urls: state.urls.slice(-12) });
        post('TRACKS', { tracks: state.tracks });
        for (const body of bodies.values()) {
          post('CUES', { body });
        }
        break;
      case 'READ_TRACKS':
        readTracks();
        break;
      case 'FORCE_EN':
        forceEnglish();
        break;
      case 'SET_QUALITY':
        applyLowestQuality();
        break;
      case 'RESTORE_QUALITY':
        restoreQuality();
        break;
      case 'RESET':
        reset();
        break;
      default:
        break;
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    reset();
    window.setTimeout(() => {
      readTracks();
      if (state.urls.length) {
        post('CAPTURE', { urls: state.urls.slice(-12) });
      }
    }, 500);
  });

  window.addEventListener('yt-page-data-updated', () => {
    window.setTimeout(readTracks, 400);
  });

  window.setTimeout(() => {
    state.videoId = currentVideoId();
    readTracks();
  }, 1200);

  // Read-only debug handle for development. It lives in the MAIN world, so the
  // page console (and automated tests) can inspect what the extension captured.
  window.__legrendasMain = {
    get state() {
      return {
        videoId: state.videoId,
        urls: state.urls.slice(-12),
        tracks: state.tracks,
      };
    },
    get log() {
      return log.slice(-40);
    },
    readTracks,
    forceEnglish,
    capture,
  };
})();
