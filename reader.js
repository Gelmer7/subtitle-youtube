'use strict';

const SETTINGS_DEFAULTS = {
  enabled: true,
  targetLang: 'pt-BR',
  showTranslation: false,
  fontSize: 20,
  pauseOnLookup: true,
  followAudio: true,
  loopLine: false,
};

const READER_PREFS_VERSION = 2;
const LOOP_LEAD = 0.06;

const els = {
  statusBar: document.getElementById('statusBar'),
  scrollArea: document.getElementById('scrollArea'),
  transcript: document.getElementById('transcript'),
  emptyState: document.getElementById('emptyState'),
  emptyText: document.getElementById('emptyText'),
  retryButton: document.getElementById('retryButton'),
  timeCurrent: document.getElementById('timeCurrent'),
  timeTotal: document.getElementById('timeTotal'),
  seekBack: document.getElementById('seekBack'),
  rateSelect: document.getElementById('rateSelect'),
  targetLangSelect: document.getElementById('targetLangSelect'),
  fontSizeButton: document.getElementById('fontSizeButton'),
  fontSizePanel: document.getElementById('fontSizePanel'),
  fontSizeRange: document.getElementById('fontSizeRange'),
  fontSizeOut: document.getElementById('fontSizeOut'),
  followAudio: document.getElementById('followAudio'),
  powerToggle: document.getElementById('powerToggle'),
  wordPopover: document.getElementById('wordPopover'),
  popWord: document.getElementById('popWord'),
  popTranslation: document.getElementById('popTranslation'),
  popContext: document.getElementById('popContext'),
  popRepeat: document.getElementById('popRepeat'),
  popClose: document.getElementById('popClose'),
  toast: document.getElementById('toast'),
};

const state = {
  tabId: 0,
  settings: { ...SETTINGS_DEFAULTS },
  follow: true,
  followSuspended: false,
  lines: [],
  revision: -1,
  fullLoading: false,
  pendingFull: null,
  light: null,
  base: null,
  connected: false,
  connectionError: '',
  disabled: false,
  stateGeneration: 0,
  lineEls: [],
  wordEls: [],
  linePlayEls: [],
  lineLoopEls: [],
  toolActive: -1,
  activeLine: -1,
  activeWord: -1,
  lastDisplayedSecond: -1,
  pollTimer: 0,
  pollBusy: false,
  rafId: 0,
  programmaticScrollUntil: 0,
  translationCache: new Map(),
  openLineTranslations: new Set(),
  lineTranslationRequests: new Set(),
  lookupSession: null,
  hover: {
    timer: 0,
    closeTimer: 0,
    wordEl: null,
  },
  popover: {
    open: false,
    pinned: false,
    requestId: 0,
    anchor: null,
    key: '',
    lineIndex: -1,
    lineStart: 0,
  },
  loop: {
    index: -1,
    seeking: false,
    retryAt: 0,
    endedRetryAt: 0,
  },
  toastTimer: 0,
  fontSaveTimer: 0,
  destroyed: false,
  videoId: null,
};

function sendBackground(type, payload = {}, timeout = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'timeout' });
    }, timeout);

    try {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message || 'runtime-error',
          });
          return;
        }

        resolve(response || { ok: false, error: 'sem-resposta' });
      });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error) });
    }
  });
}

function getSync(defaults) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(defaults, (stored) => {
        if (chrome.runtime.lastError) {
          resolve({ ...defaults });
          return;
        }
        resolve({ ...defaults, ...(stored || {}) });
      });
    } catch {
      resolve({ ...defaults });
    }
  });
}

function getAllSync() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(null, (stored) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        resolve(stored || {});
      });
    } catch {
      resolve({});
    }
  });
}

function setSync(values) {
  try {
    chrome.storage.sync.set(values, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // The extension may have been reloaded.
  }
}

function normalizeSettings() {
  state.settings.enabled = state.settings.enabled !== false;
  state.settings.targetLang = state.settings.targetLang === 'es' ? 'es' : 'pt-BR';
  state.settings.showTranslation = false;
  state.settings.pauseOnLookup = true;
  state.settings.followAudio = state.settings.followAudio !== false;
  state.settings.loopLine = state.settings.loopLine === true;
  state.settings.fontSize = Math.min(
    28,
    Math.max(16, Number(state.settings.fontSize) || 20)
  );
  state.follow = state.settings.followAudio;
}

async function loadSettings() {
  const [stored, raw] = await Promise.all([
    getSync(SETTINGS_DEFAULTS),
    getAllSync(),
  ]);
  state.settings = { ...SETTINGS_DEFAULTS, ...stored };

  const legacy =
    raw.readerPrefsVersion == null ||
    Number(raw.readerPrefsVersion) < READER_PREFS_VERSION;
  if (legacy) state.settings.followAudio = true;

  normalizeSettings();
  applySettingsToUi();

  if (legacy) {
    setSync({
      readerPrefsVersion: READER_PREFS_VERSION,
      followAudio: state.settings.followAudio,
      loopLine: state.settings.loopLine,
    });
  }
}

function applyFontSize() {
  const size = state.settings.fontSize;
  const readerSize = Math.min(42, Math.max(22, size + 6));
  document.documentElement.style.setProperty('--reader-size', `${readerSize}px`);

  if (els.fontSizeRange) els.fontSizeRange.value = String(size);
  if (els.fontSizeOut) els.fontSizeOut.textContent = `${size} px`;
}

function applySettingsToUi() {
  applyFontSize();
  if (els.targetLangSelect) {
    els.targetLangSelect.value = state.settings.targetLang;
  }
  updatePreferenceButtons();
  els.transcript.classList.toggle(
    'hide-translation',
    !state.settings.showTranslation
  );
}

function updatePreferenceButtons() {
  const enabled = state.settings.enabled;
  els.followAudio.setAttribute('aria-pressed', String(state.follow));
  els.powerToggle.setAttribute('aria-pressed', String(enabled));
  els.powerToggle.setAttribute(
    'aria-label',
    enabled ? 'Desativar extensão' : 'Ativar extensão'
  );
  els.powerToggle.title = enabled ? 'Desativar extensão' : 'Ativar extensão';
  els.powerToggle.classList.toggle('is-on', enabled);
  els.seekBack.disabled = !enabled;
  els.rateSelect.disabled = !enabled;
  els.followAudio.disabled = !enabled;
  syncLineToolState();
}

function syncLineToolState() {
  const playing = isCurrentlyPlaying();
  const active = state.activeLine;
  const previous = state.toolActive;

  if (previous >= 0 && previous !== active) {
    const prevPlay = state.linePlayEls[previous];
    if (prevPlay) {
      prevPlay.classList.remove('is-playing');
      const prevLine = state.lines[previous];
      const label = `Reproduzir a partir de ${formatTime(
        prevLine ? prevLine.start : 0
      )}`;
      prevPlay.setAttribute('aria-label', label);
      prevPlay.title = label;
    }

    const prevLoop = state.lineLoopEls[previous];
    if (prevLoop) {
      prevLoop.setAttribute('aria-pressed', 'false');
      prevLoop.setAttribute('aria-label', 'Repetir esta linha');
      prevLoop.title = 'Repetir esta linha';
    }
  }

  const line = state.lines[active];
  const playButton = state.linePlayEls[active];

  if (playButton) {
    playButton.classList.toggle('is-playing', playing);
    const label = playing
      ? 'Pausar'
      : `Reproduzir a partir de ${formatTime(line ? line.start : 0)}`;
    playButton.setAttribute('aria-label', label);
    playButton.title = label;
  }

  const loopButton = state.lineLoopEls[active];
  if (loopButton) {
    const looping = state.settings.loopLine;
    loopButton.setAttribute('aria-pressed', String(looping));
    loopButton.setAttribute(
      'aria-label',
      looping ? 'Deixar de repetir esta linha' : 'Repetir esta linha'
    );
    loopButton.title = loopButton.getAttribute('aria-label');
  }

  state.toolActive = active;
}

function setStatus(text, kind = '') {
  if (!text) {
    els.statusBar.hidden = true;
    els.statusBar.textContent = '';
    delete els.statusBar.dataset.kind;
    return;
  }

  els.statusBar.hidden = false;
  els.statusBar.textContent = text;
  els.statusBar.dataset.kind = kind;
}

function showToast(text, duration = 3600) {
  if (!text) return;
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, duration);
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function lineKey(line) {
  return `${line.start}|${line.id != null ? line.id : line.text}`;
}

function lineSpeechEnd(line) {
  const words = Array.isArray(line.words) ? line.words : [];
  const lastWord = words.length ? words[words.length - 1] : null;
  const end =
    lastWord && Number.isFinite(lastWord.end)
      ? lastWord.end
      : Number(line.end);
  const fallback = Number(line.start) + 0.25;
  return Math.max(Number(line.start) + 0.2, Number.isFinite(end) ? end : fallback);
}

function cachedLineTranslation(line) {
  if (line.translation) return line.translation;
  const key = translateCacheKey(state.settings.targetLang, line.text);
  return state.translationCache.get(key) || '';
}

function clearFollowSuspension() {
  state.followSuspended = false;
  els.followAudio.title =
    'Acompanhar automaticamente a linha que está a ser falada';
}

function suspendFollowForScroll() {
  if (!state.follow || state.followSuspended) return;
  state.followSuspended = true;
  els.followAudio.title = 'Seguir áudio: retoma na próxima linha';
}

function isReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isFormTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, select, textarea, button, [contenteditable="true"]');
}

function blocksLineArrow(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'select, textarea, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"])'
  );
}

function isCurrentlyPlaying() {
  return !!(
    state.light &&
    !state.light.paused &&
    !state.light.ad &&
    !state.light.ended
  );
}

function describeError(code) {
  switch (code) {
    case 'disabled':
      return 'A extensão está desativada. Clica no botão de energia no controlbar para a ativar.';
    case 'not-watch':
      return 'Abre um vídeo do YouTube para usar o modo leitura.';
    case 'tab-unavailable':
      return 'A aba do YouTube foi fechada. Reabre o vídeo no YouTube e volta a abrir o leitor.';
    case 'timeout':
      return 'A aba do YouTube não respondeu. Clica em Tentar novamente ou recarrega a página do YouTube.';
    case 'play-blocked':
      return 'O Chrome bloqueou a reprodução vinda desta janela. Carrega no play da aba do YouTube.';
    case 'sem-video':
      return 'Não há um vídeo associado a esta janela. Abre o modo leitura a partir de um vídeo do YouTube.';
    default:
      return `Não foi possível controlar o vídeo (${code || 'erro desconhecido'}).`;
  }
}

function getEstimatedTime() {
  if (!state.base) return 0;
  if (state.base.paused || state.base.ad || state.base.ended) {
    return state.base.time;
  }

  const elapsed = ((performance.now() - state.base.at) / 1000) * state.base.rate;
  const next = state.base.time + Math.max(0, elapsed);
  return state.base.duration > 0
    ? Math.min(state.base.duration, next)
    : next;
}

function updateTimeDisplay(force = false) {
  const time = getEstimatedTime();
  const second = Math.floor(time);
  if (!force && second === state.lastDisplayedSecond) return;
  state.lastDisplayedSecond = second;
  const duration = state.light && state.light.duration ? state.light.duration : 0;
  els.timeCurrent.textContent = formatTime(time);
  els.timeTotal.textContent = formatTime(duration);
}

function updateDocumentTitle(data) {
  const title = data.title || 'Vídeo do YouTube';
  const next = `${title} — SubIngles`;
  if (document.title !== next) document.title = next;
}

function updateStatus(data) {
  if (state.connectionError) {
    setStatus(state.connectionError, 'error');
    return;
  }

  if (data.ad) {
    setStatus(
      'Anúncio em curso. A transcrição e o áudio do vídeo voltam a seguir.',
      'warn'
    );
    return;
  }

  if (data.error && !data.loading) {
    setStatus(
      data.error === 'empty-cues'
        ? 'O YouTube devolveu uma legenda vazia. Tenta novamente.'
        : `Não foi possível carregar as legendas (${data.error}).`,
      'error'
    );
    return;
  }

  if (data.fallback) {
    setStatus(
      'Não foi possível montar a transcrição completa. A usar a legenda nativa do YouTube.',
      'warn'
    );
    return;
  }

  setStatus('');
}

function updateControls(data) {
  if (data) {
    const rate = Number(data.rate) || 1;
    const option = Array.from(els.rateSelect.options).find(
      (item) => Number(item.value) === rate
    );
    if (option) els.rateSelect.value = option.value;
  }

  syncLineToolState();
}

function updateEmptyState(data) {
  if (state.lines.length) {
    els.emptyState.hidden = true;
    els.transcript.hidden = false;
    return;
  }

  els.emptyState.hidden = false;
  els.transcript.hidden = true;
  els.retryButton.hidden = false;

  const heading = els.emptyState.querySelector('h2');
  let title = 'A preparar a transcrição';
  let text = 'Aguarda enquanto as legendas do vídeo são carregadas.';

  if (state.connectionError) {
    title = 'Vídeo indisponível';
    text = state.connectionError;
  } else if (!data) {
    title = 'A ligar ao vídeo';
    text = 'Aguarda enquanto a janela encontra o player do YouTube.';
  } else if (data.ad) {
    title = 'Anúncio em curso';
    text = 'A transcrição aparece quando o vídeo do YouTube continuar.';
  } else if (data.loading) {
    title = 'A carregar as legendas';
    text = 'A extensão está a preparar as cues em inglês e a tradução.';
  } else if (data.error) {
    title = 'Não foi possível carregar a transcrição';
    text =
      data.error === 'empty-cues'
        ? 'O YouTube devolveu uma resposta vazia para as legendas. Tenta novamente.'
        : `O leitor recebeu este erro: ${data.error}`;
  } else if (data.fallback) {
    title = 'Legendas nativas';
    text =
      'Não foi possível obter a transcrição completa. Podes continuar a ver a legenda nativa na barra do YouTube ou tentar novamente.';
  } else if (data.ready) {
    title = 'Sem legendas em inglês';
    text =
      'Este vídeo não tem uma faixa de legendas em inglês (manual ou automática).';
  } else {
    title = 'À espera das legendas';
    text =
      'O player ainda não devolveu uma faixa de legendas. Tenta novamente ou recarrega o vídeo.';
  }

  if (heading.textContent !== title) heading.textContent = title;
  if (els.emptyText.textContent !== text) els.emptyText.textContent = text;
}

function showDisabledState() {
  setStatus(state.connectionError, 'error');
  els.emptyState.hidden = false;
  els.transcript.hidden = true;
  els.retryButton.hidden = false;
  els.retryButton.textContent = 'Ativar extensão';

  const heading = els.emptyState.querySelector('h2');
  if (heading) heading.textContent = 'Extensão desativada';

  els.emptyText.textContent =
    'A transcrição está em pausa. Clica no botão de energia no controlbar ou em Ativar extensão.';
}

function resetDisabledState() {
  if (!state.disabled) return;
  state.disabled = false;
  els.retryButton.textContent = 'Tentar novamente';
}

function renderTranscript() {
  state.lineEls = [];
  state.wordEls = [];
  state.linePlayEls = [];
  state.lineLoopEls = [];
  state.toolActive = -1;
  state.activeLine = -1;
  state.activeWord = -1;
  resetLoopState();

  const fragment = document.createDocumentFragment();

  state.lines.forEach((line, lineIndex) => {
    const key = lineKey(line);
    const translationText = cachedLineTranslation(line);
    const translationOpen = state.openLineTranslations.has(key);

    const lineEl = document.createElement('article');
    lineEl.className = 'line';
    lineEl.dataset.lineIndex = String(lineIndex);
    lineEl.classList.toggle('is-translation-open', translationOpen);

    const body = document.createElement('div');
    body.className = 'line-body';

    const textEl = document.createElement('p');
    textEl.className = 'line-text';

    const wordEls = [];
    if (Array.isArray(line.words) && line.words.length) {
      line.words.forEach((word, wordIndex) => {
        const wordEl = document.createElement('span');
        wordEl.className = word.query ? 'word' : 'word word-punctuation';
        wordEl.dataset.lineIndex = String(lineIndex);
        wordEl.dataset.wordIndex = String(wordIndex);
        wordEl.textContent = word.text;
        textEl.append(wordEl);
        textEl.append(document.createTextNode(' '));
        if (word.query) wordEls[wordIndex] = wordEl;
      });
    } else {
      textEl.textContent = line.text;
    }

    body.append(textEl);

    if (translationText || translationOpen) {
      const translationEl = document.createElement('div');
      translationEl.className = 'line-translation';
      translationEl.classList.toggle('is-pending', !translationText);
      translationEl.textContent = translationText || 'A traduzir…';
      body.append(translationEl);
    }

    const tools = document.createElement('div');
    tools.className = 'line-tools';

    const translateButton = document.createElement('button');
    translateButton.type = 'button';
    translateButton.className = 'line-translate';
    translateButton.dataset.lineIndex = String(lineIndex);
    translateButton.title = 'Traduzir linha inteira';
    translateButton.setAttribute('aria-label', 'Traduzir linha inteira');
    translateButton.setAttribute('aria-expanded', String(translationOpen));
    translateButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M4 5h10M9 3v2c0 4.6-2.3 8-6 10M5.5 9.5c1.8 3.2 4.5 5.6 8.1 7.2M14 20l4.2-10L22 20M15.7 16.5h5.1" />' +
      '</svg>';
    const loopButton = document.createElement('button');
    loopButton.type = 'button';
    loopButton.className = 'line-loop';
    loopButton.dataset.lineIndex = String(lineIndex);
    loopButton.setAttribute('aria-pressed', 'false');
    loopButton.setAttribute('aria-label', 'Repetir esta linha');
    loopButton.title = 'Repetir esta linha';
    loopButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" />' +
      '<path d="M20.5 3.5V9H15" />' +
      '</svg>';

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'line-play';
    playButton.dataset.lineIndex = String(lineIndex);
    playButton.setAttribute(
      'aria-label',
      `Reproduzir a partir de ${formatTime(line.start)}`
    );
    playButton.title = `Reproduzir a partir de ${formatTime(line.start)}`;
    playButton.innerHTML =
      '<svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M8 5.1v13.8L19.2 12Z" />' +
      '</svg>' +
      '<svg class="icon-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M9.5 5.5v13M14.5 5.5v13" />' +
      '</svg>';

    tools.append(playButton, loopButton, translateButton);

    lineEl.append(body, tools);
    fragment.append(lineEl);
    state.lineEls[lineIndex] = lineEl;
    state.wordEls[lineIndex] = wordEls;
    state.linePlayEls[lineIndex] = playButton;
    state.lineLoopEls[lineIndex] = loopButton;
  });

  els.transcript.replaceChildren(fragment);
  els.transcript.classList.toggle(
    'hide-translation',
    !state.settings.showTranslation
  );
  els.transcript.hidden = state.lines.length === 0;
  els.emptyState.hidden = state.lines.length > 0;

  state.lines.forEach((line, lineIndex) => {
    if (
      state.openLineTranslations.has(lineKey(line)) &&
      !cachedLineTranslation(line)
    ) {
      ensureLineTranslation(lineIndex);
    }
  });
}

function lineIndexForTime(time) {
  const lines = state.lines;
  if (!lines.length) return -1;

  let low = 0;
  let high = lines.length - 1;
  let position = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start <= time) {
      position = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return position;
}

function wordIndexForTime(words, time) {
  if (!Array.isArray(words) || !words.length) return -1;

  let low = 0;
  let high = words.length - 1;
  let position = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle].start <= time) {
      position = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (position < 0) return -1;

  const word = words[position];
  if (time <= word.end || position === words.length - 1) {
    let index = position;
    while (index >= 0 && !words[index].query) index -= 1;
    return index;
  }

  return -1;
}

function setActive(lineIndex, wordIndex) {
  const lineChanged = lineIndex !== state.activeLine;
  const oldLine = state.activeLine;

  if (lineChanged) {
    clearFollowSuspension();

    if (oldLine >= 0 && state.lineEls[oldLine]) {
      state.lineEls[oldLine].classList.remove('is-active');
      if (state.activeWord >= 0 && state.wordEls[oldLine]) {
        const oldWord = state.wordEls[oldLine][state.activeWord];
        if (oldWord) oldWord.classList.remove('is-current');
      }
    }

    state.activeLine = lineIndex;
    state.activeWord = -1;

    if (lineIndex >= 0 && state.lineEls[lineIndex]) {
      state.lineEls[lineIndex].classList.add('is-active');
    }

    syncLineToolState();
  }

  if (wordIndex !== state.activeWord) {
    const lineWords = state.wordEls[state.activeLine] || [];
    const oldWord = lineWords[state.activeWord];
    if (oldWord) oldWord.classList.remove('is-current');

    state.activeWord = wordIndex;
    const newWord = lineWords[wordIndex];
    if (newWord) newWord.classList.add('is-current');
  }

  if (lineChanged && lineIndex >= 0) scrollToActive();
}

function resetLoopState() {
  state.loop.index = -1;
  state.loop.seeking = false;
  state.loop.retryAt = 0;
  state.loop.endedRetryAt = 0;
}

function armLoopTarget() {
  if (!state.settings.loopLine) {
    resetLoopState();
    return;
  }

  const index =
    state.activeLine >= 0
      ? state.activeLine
      : lineIndexForTime(getEstimatedTime());
  state.loop.index = index;
  state.loop.seeking = false;
  state.loop.retryAt = 0;
  state.loop.endedRetryAt = 0;
}

function setLoopEnabled(enabled, persistChange = true) {
  state.settings.loopLine = !!enabled;
  armLoopTarget();
  syncLineToolState();
  if (persistChange) persist('loopLine', state.settings.loopLine);
  updatePlaybackUi(true);
}

function updatePlaybackUi(force = false) {
  updateTimeDisplay(force);

  if (!state.lines.length) return;

  const time = getEstimatedTime();
  const now = performance.now();
  const playing = !!(
    state.base &&
    !state.base.paused &&
    !state.base.ad &&
    !state.base.ended
  );

  if (!state.settings.loopLine) {
    state.loop.index = -1;
  } else if (state.loop.index >= state.lines.length) {
    resetLoopState();
  } else if (state.loop.index < 0 && state.activeLine >= 0) {
    state.loop.index = state.activeLine;
  }

  const loopIndex = state.loop.index;
  const loopLine = loopIndex >= 0 ? state.lines[loopIndex] : null;

  if (loopLine) {
    if (state.loop.seeking) {
      if (state.activeLine !== loopIndex) setActive(loopIndex, -1);
      return;
    }

    if (now < state.loop.retryAt) {
      if (state.activeLine !== loopIndex) setActive(loopIndex, -1);
      return;
    }

    if (playing && time >= lineSpeechEnd(loopLine) - LOOP_LEAD) {
      restartLoopLine(loopIndex);
      return;
    }

    if (
      state.base &&
      state.base.ended &&
      !state.base.ad &&
      now >= state.loop.endedRetryAt
    ) {
      state.loop.endedRetryAt = now + 1500;
      restartLoopLine(loopIndex, true);
      return;
    }
  }

  let lineIndex = lineIndexForTime(time);

  if (
    loopLine &&
    lineIndex > loopIndex &&
    time <= lineSpeechEnd(loopLine) + 0.25
  ) {
    lineIndex = loopIndex;
  }

  let wordIndex = -1;

  if (lineIndex >= 0) {
    const line = state.lines[lineIndex];
    wordIndex = wordIndexForTime(line.words, time);
  }

  setActive(lineIndex, wordIndex);
}

function restartLoopLine(index, fromEnded = false) {
  if (!state.base) return;
  const line = state.lines[index];
  if (!line) return;

  state.loop.index = index;
  state.loop.seeking = true;
  state.base.time = Math.max(0, Number(line.start) || 0);
  state.base.at = performance.now();
  state.base.paused = false;
  state.base.ended = false;
  state.lastDisplayedSecond = -1;
  updateTimeDisplay(true);
  setActive(index, -1);

  const finish = (result) => {
    if (state.destroyed || state.loop.index !== index) return;
    state.loop.seeking = false;

    const actual = result ? Number(result.currentTime) : NaN;
    const seeked = !!(
      result &&
      result.ok !== false &&
      Number.isFinite(actual) &&
      actual <= line.start + 1
    );

    if (!seeked) {
      state.loop.retryAt = performance.now() + 450;
      return;
    }

    if (fromEnded) {
      runCommand('play', undefined, { silent: true }).then((played) => {
        if (!played || played.ok === false) {
          state.loop.retryAt = performance.now() + 1200;
          state.loop.endedRetryAt = performance.now() + 1200;
        }
      });
    }
  };

  runCommand('seek', line.start, { silent: true }).then(finish, () => finish(null));

  setTimeout(() => {
    if (state.destroyed) return;
    if (state.loop.index === index && state.loop.seeking) {
      state.loop.seeking = false;
      state.loop.retryAt = performance.now() + 450;
    }
  }, 2000);
}

function scrollToActive(force = false) {
  if (!state.follow || state.followSuspended || state.popover.open) return;
  if (state.activeLine < 0) return;

  const lineEl = state.lineEls[state.activeLine];
  if (!lineEl) return;

  const areaRect = els.scrollArea.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();
  const relativeTop = lineRect.top - areaRect.top + els.scrollArea.scrollTop;
  const relativeBottom = relativeTop + lineRect.height;
  const viewTop = els.scrollArea.scrollTop;
  const viewBottom = viewTop + els.scrollArea.clientHeight;
  const margin = Math.min(130, els.scrollArea.clientHeight * 0.24);

  if (
    !force &&
    relativeTop >= viewTop + margin &&
    relativeBottom <= viewBottom - margin
  ) {
    return;
  }

  const target = Math.max(
    0,
    relativeTop - els.scrollArea.clientHeight * 0.09
  );

  const distance = Math.abs(target - els.scrollArea.scrollTop);
  const instant =
    isReducedMotion() || distance > els.scrollArea.clientHeight * 1.5;

  state.programmaticScrollUntil = performance.now() + (instant ? 500 : 1600);
  els.scrollArea.scrollTo({
    top: target,
    behavior: instant ? 'auto' : 'smooth',
  });
}

function applyPlayback(data) {
  if (!data) return;
  if (data.ok === false) {
    applyFailure(data);
    return;
  }

  if (state.videoId && data.videoId && state.videoId !== data.videoId) {
    closePopover({ resume: false });
    state.lines = [];
    state.revision = -1;
    state.pendingFull = null;
    state.openLineTranslations.clear();
    state.lineTranslationRequests.clear();
    state.videoId = data.videoId;
    renderTranscript();
  } else if (data.videoId) {
    state.videoId = data.videoId;
  }

  state.light = data;
  state.connected = true;
  state.connectionError = '';
  resetDisabledState();

  const playing = !data.paused && !data.ad && !data.ended;
  state.base = {
    time: Math.max(0, Number(data.currentTime) || 0),
    paused: !playing,
    rate: Math.max(0.25, Number(data.rate) || 1),
    at: performance.now(),
    duration: Math.max(0, Number(data.duration) || 0),
    ad: !!data.ad,
    ended: !!data.ended,
  };

  if (
    state.settings.loopLine &&
    !state.loop.seeking &&
    performance.now() >= state.loop.retryAt
  ) {
    const loopLine =
      state.loop.index >= 0 ? state.lines[state.loop.index] : null;
    if (!loopLine) {
      state.loop.index = -1;
    } else if (
      state.base.time > lineSpeechEnd(loopLine) + 2 ||
      state.base.time < loopLine.start - 2
    ) {
      state.loop.index = lineIndexForTime(state.base.time);
    }
  }

  updateDocumentTitle(data);
  updateControls(data);
  updateStatus(data);
  updateEmptyState(data);
  updatePlaybackUi(true);
}

function applyFull(data, force = false) {
  if (!data) return;
  if (data.ok === false) {
    applyFailure(data);
    return;
  }

  if (
    state.popover.open &&
    (force || data.revision !== state.revision)
  ) {
    state.pendingFull = data;
    applyPlayback(data);
    return;
  }

  state.pendingFull = null;
  state.lines = Array.isArray(data.lines) ? data.lines : [];
  state.revision = data.revision;
  if (data.videoId) state.videoId = data.videoId;

  renderTranscript();
  applyPlayback(data);
}

function applyFailure(result) {
  const code = (result && result.error) || 'tab-unavailable';

  if (code === 'disabled') {
    state.disabled = true;
    state.connected = false;
    state.connectionError = describeError('disabled');
    state.pendingFull = null;

    if (state.base) {
      state.base.time = getEstimatedTime();
      state.base.paused = true;
      state.base.at = performance.now();
    }

    showDisabledState();
    return;
  }

  resetDisabledState();

  state.connected = false;
  state.connectionError = describeError(code);
  state.pendingFull = null;

  if (state.base) {
    state.base.time = getEstimatedTime();
    state.base.paused = true;
    state.base.at = performance.now();
  }

  setStatus(state.connectionError, 'error');

  if (!state.lines.length) {
    updateEmptyState({
      ok: false,
      error: code,
      ready: false,
      loading: false,
      fallback: false,
      ad: false,
    });
  }
}

function flushPendingFull() {
  if (!state.pendingFull) return;
  const data = state.pendingFull;
  state.pendingFull = null;
  applyFull(data);
}

async function requestFull(force = false) {
  if (state.fullLoading) return;
  state.fullLoading = true;
  const generation = state.stateGeneration;

  const result = await sendBackground(
    'legrendas:reader-state',
    { tabId: state.tabId, full: true },
    7000
  );

  if (generation !== state.stateGeneration) return;
  state.fullLoading = false;

  if (!result || result.ok === false) {
    applyFailure(result);
    return;
  }

  applyFull(result, force);
}

function schedulePoll(delay = 650) {
  clearTimeout(state.pollTimer);
  if (state.destroyed) return;
  state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  if (state.destroyed) return;
  if (state.pollBusy) {
    schedulePoll(500);
    return;
  }

  state.pollBusy = true;
  const generation = state.stateGeneration;
  const result = await sendBackground(
    'legrendas:reader-state',
    { tabId: state.tabId, full: false },
    5000
  );

  if (generation !== state.stateGeneration) return;
  state.pollBusy = false;

  if (!result || result.ok === false) {
    applyFailure(result);
    schedulePoll(1600);
    return;
  }

  applyPlayback(result);

  if (
    !state.pendingFull &&
    (result.revision !== state.revision ||
      (result.ready && state.lines.length !== result.lineCount))
  ) {
    await requestFull(false);
  }

  schedulePoll(650);
}

function startPolling() {
  schedulePoll(350);
}

function startRenderLoop() {
  cancelAnimationFrame(state.rafId);
  const tick = () => {
    if (state.destroyed) return;
    updatePlaybackUi();
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

async function runCommand(action, value, options = {}) {
  const generation = state.stateGeneration;
  const result = await sendBackground(
    'legrendas:reader-command',
    { tabId: state.tabId, action, value },
    6000
  );

  if (generation !== state.stateGeneration) {
    return result || { ok: false, error: 'stale' };
  }

  if (!result || result.ok === false) {
    if (!options.silent) {
      showToast(describeError(result && result.error));
    }
    return result || { ok: false, error: 'timeout' };
  }

  applyPlayback(result);
  return result;
}

function optimisticPause() {
  if (!state.base) return;
  state.base.time = getEstimatedTime();
  state.base.paused = true;
  state.base.at = performance.now();
  if (state.light) state.light.paused = true;
  updateControls(state.light);
  updatePlaybackUi(true);
}

function optimisticPlay() {
  if (!state.base) return;
  state.base.paused = false;
  state.base.at = performance.now();
  if (state.light) {
    state.light.paused = false;
    state.light.ended = false;
  }
  updateControls(state.light);
  updatePlaybackUi(true);
}

async function controlPlayback(play) {
  if (state.lookupSession) state.lookupSession.pausedByLookup = false;

  if (play) optimisticPlay();
  else optimisticPause();

  await runCommand(play ? 'play' : 'pause');

  if (play && state.follow && !state.followSuspended && !state.popover.open) {
    scrollToActive(true);
  }
}

async function seekBy(delta) {
  if (!state.base) return;
  const target = Math.max(0, getEstimatedTime() + delta);
  const next = Math.min(
    target,
    state.base.duration > 0 ? state.base.duration : target
  );
  state.base.time = next;
  state.base.at = performance.now();
  if (state.settings.loopLine) {
    state.loop.index = lineIndexForTime(next);
    state.loop.seeking = false;
    state.loop.retryAt = 0;
    state.loop.endedRetryAt = 0;
  }
  updatePlaybackUi(true);
  await runCommand('seek-by', delta, { silent: true });
}

async function seekTo(seconds) {
  if (!state.base) return;
  const target = Math.max(0, Number(seconds) || 0);
  state.base.time = target;
  state.base.at = performance.now();
  if (state.settings.loopLine) {
    state.loop.index = lineIndexForTime(target);
    state.loop.seeking = false;
    state.loop.retryAt = 0;
    state.loop.endedRetryAt = 0;
  }
  updatePlaybackUi(true);
  await runCommand('seek', state.base.time, { silent: true });
}

async function jumpLine(direction) {
  if (!state.lines.length) return;

  const time = getEstimatedTime();
  let index = state.activeLine >= 0 ? state.activeLine : lineIndexForTime(time);

  if (index < 0) {
    index = direction > 0 ? 0 : state.lines.length - 1;
  } else {
    index += direction;
  }

  index = Math.min(state.lines.length - 1, Math.max(0, index));
  clearFollowSuspension();
  state.loop.index = state.settings.loopLine ? index : -1;

  const target = state.lines[index];
  await seekTo(target.start);

  if (
    state.settings.loopLine &&
    state.light &&
    state.light.paused &&
    !state.light.ended
  ) {
    await controlPlayback(true);
  }
}

async function playLine(index) {
  const line = state.lines[index];
  if (!line) return;

  if (state.activeLine === index) {
    await controlPlayback(!isCurrentlyPlaying());
    return;
  }

  if (state.popover.open) closePopover({ resume: false });
  state.lookupSession = null;
  clearFollowSuspension();
  state.loop.index = state.settings.loopLine ? index : -1;

  await seekTo(line.start);
  await controlPlayback(true);
}

function toggleLineLoop(index) {
  if (state.activeLine !== index) return;
  setLoopEnabled(!state.settings.loopLine);
}

function maybePauseForLookup() {
  if (!state.settings.pauseOnLookup) return;

  if (!state.lookupSession) {
    state.lookupSession = {
      wasPlaying: isCurrentlyPlaying(),
      pausedByLookup: false,
    };
  }

  if (!isCurrentlyPlaying()) return;

  state.lookupSession.wasPlaying = true;
  state.lookupSession.pausedByLookup = true;
  optimisticPause();
  runCommand('pause', undefined, { silent: true });
}

function resumeAfterLookup() {
  const session = state.lookupSession;
  state.lookupSession = null;
  if (!session || !session.pausedByLookup || !session.wasPlaying) return;
  if (state.light && state.light.ended) return;

  optimisticPlay();
  runCommand('play').then((result) => {
    if (!result || result.ok === false) {
      // runCommand already showed the toast.
    }
  });
}

function cancelHoverTimers() {
  clearTimeout(state.hover.timer);
  clearTimeout(state.hover.closeTimer);
  state.hover.timer = 0;
  state.hover.closeTimer = 0;
  state.hover.wordEl = null;
}

function scheduleHoverClose() {
  if (state.popover.open && state.popover.pinned) return;

  clearTimeout(state.hover.timer);
  state.hover.timer = 0;
  clearTimeout(state.hover.closeTimer);
  state.hover.closeTimer = setTimeout(() => {
    state.hover.closeTimer = 0;
    if (state.popover.open && !state.popover.pinned) {
      closePopover();
    }
  }, 170);
}

function scheduleHoverOpen(wordEl) {
  const lineIndex = Number(wordEl.dataset.lineIndex);
  const wordIndex = Number(wordEl.dataset.wordIndex);
  if (!Number.isInteger(lineIndex) || !Number.isInteger(wordIndex)) return;

  cancelHoverTimers();
  state.hover.wordEl = wordEl;
  state.hover.timer = setTimeout(() => {
    state.hover.timer = 0;
    if (!wordEl.isConnected) return;
    openWord(lineIndex, wordIndex, wordEl, { source: 'hover' });
  }, 240);
}

function hidePopoverVisual() {
  cancelHoverTimers();
  state.popover.open = false;
  state.popover.pinned = false;
  state.popover.anchor = null;
  state.popover.key = '';
  state.popover.requestId += 1;
  els.wordPopover.hidden = true;
  els.wordPopover.classList.remove('is-hover');
}

function closePopover(options = {}) {
  cancelHoverTimers();
  if (!state.popover.open) return;
  hidePopoverVisual();

  if (options.resume !== false) {
    resumeAfterLookup();
  } else {
    state.lookupSession = null;
  }

  flushPendingFull();

  if (options.resume !== false && state.follow) {
    setTimeout(() => scrollToActive(), 80);
  }
}

function positionPopover(anchor) {
  if (!anchor || !anchor.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  els.wordPopover.hidden = false;

  const width = els.wordPopover.offsetWidth;
  const height = els.wordPopover.offsetHeight;
  const margin = 12;

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) {
    top = rect.top - height - 8;
  }
  top = Math.max(margin, top);

  els.wordPopover.style.left = `${Math.round(left)}px`;
  els.wordPopover.style.top = `${Math.round(top)}px`;
}

function translateCacheKey(target, query) {
  return `${target}\u0000${query}`;
}

function trimTranslationCache() {
  if (state.translationCache.size <= 1200) return;
  const excess = state.translationCache.size - 1200;
  let removed = 0;
  for (const key of state.translationCache.keys()) {
    state.translationCache.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

async function openWord(lineIndex, wordIndex, wordEl, options = {}) {
  const line = state.lines[lineIndex];
  const word = line && line.words && line.words[wordIndex];
  if (!line || !word || !word.query) return;

  const pinned = options.source !== 'hover';
  const target = state.settings.targetLang;
  const key = translateCacheKey(target, word.query);

  if (state.popover.open) {
    if (state.popover.pinned && !pinned) return;

    if (state.popover.anchor === wordEl && state.popover.key === key) {
      if (pinned && !state.popover.pinned) {
        state.popover.pinned = true;
        els.wordPopover.classList.remove('is-hover');
        maybePauseForLookup();
        requestAnimationFrame(() => positionPopover(wordEl));
      }
      return;
    }

    hidePopoverVisual();
  }

  state.popover.open = true;
  state.popover.pinned = pinned;
  state.popover.anchor = wordEl;
  state.popover.lineIndex = lineIndex;
  state.popover.lineStart = line.start;
  state.popover.key = key;
  const requestId = ++state.popover.requestId;

  els.popWord.textContent = word.text;
  els.popContext.textContent = line.text;
  els.popTranslation.classList.remove('is-error');
  els.popTranslation.textContent = 'A traduzir…';
  els.wordPopover.classList.toggle('is-hover', !pinned);
  els.wordPopover.hidden = false;
  positionPopover(wordEl);

  if (pinned) maybePauseForLookup();

  const cached = state.translationCache.get(key);

  if (cached) {
    els.popTranslation.textContent = cached;
    requestAnimationFrame(() => positionPopover(wordEl));
    return;
  }

  const result = await sendBackground(
    'translate',
    { texts: [word.query], target },
    8000
  );

  if (
    !state.popover.open ||
    requestId !== state.popover.requestId ||
    state.popover.key !== key
  ) {
    return;
  }

  const translation =
    result &&
    Array.isArray(result.translations) &&
    result.translations.length
      ? String(result.translations[0] || '').trim()
      : '';

  if (translation) {
    state.translationCache.set(key, translation);
    trimTranslationCache();
    els.popTranslation.textContent = translation;
  } else {
    els.popTranslation.textContent = 'Não foi possível traduzir esta palavra.';
    els.popTranslation.classList.add('is-error');
  }

  requestAnimationFrame(() => positionPopover(wordEl));
}

async function repeatLine() {
  const start = state.popover.lineStart;
  closePopover({ resume: false });
  state.lookupSession = null;
  await seekTo(start);
  await runCommand('play');
}

function updateLineTranslationDom(lineIndex) {
  const line = state.lines[lineIndex];
  const lineEl = state.lineEls[lineIndex];
  if (!line || !lineEl) return;

  const key = lineKey(line);
  const open = state.openLineTranslations.has(key);
  const text = cachedLineTranslation(line);
  const button = lineEl.querySelector('.line-translate');
  lineEl.classList.toggle('is-translation-open', open);
  if (button) button.setAttribute('aria-expanded', String(open));

  let panel = lineEl.querySelector('.line-translation');
  if (!open && !text) {
    if (panel) panel.remove();
    return;
  }

  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'line-translation';
    const body = lineEl.querySelector('.line-body');
    if (!body) return;
    body.append(panel);
  }

  panel.classList.toggle('is-pending', !text);
  panel.classList.remove('is-error');
  panel.textContent = text || 'A traduzir…';
}

async function ensureLineTranslation(lineIndex) {
  const line = state.lines[lineIndex];
  if (!line) return;

  const key = lineKey(line);
  const cached = cachedLineTranslation(line);
  if (cached) {
    if (!line.translation) line.translation = cached;
    updateLineTranslationDom(lineIndex);
    return;
  }

  const target = state.settings.targetLang;
  const requestKey = `${target}\u0000${key}`;
  if (state.lineTranslationRequests.has(requestKey)) return;
  state.lineTranslationRequests.add(requestKey);

  let result = null;

  try {
    result = await sendBackground(
      'translate',
      { texts: [line.text], target },
      8000
    );
  } finally {
    state.lineTranslationRequests.delete(requestKey);
  }

  if (state.settings.targetLang !== target) return;

  const currentIndex = state.lines.findIndex((item) => lineKey(item) === key);
  if (currentIndex < 0) return;
  if (!state.openLineTranslations.has(key)) return;

  const translation =
    result &&
    Array.isArray(result.translations) &&
    result.translations.length
      ? String(result.translations[0] || '').trim()
      : '';

  if (!translation) {
    const panel = state.lineEls[currentIndex]?.querySelector('.line-translation');
    if (panel) {
      panel.classList.remove('is-pending');
      panel.classList.add('is-error');
      panel.textContent = 'Não foi possível traduzir esta linha.';
    }
    return;
  }

  state.lines[currentIndex].translation = translation;
  state.translationCache.set(translateCacheKey(target, line.text), translation);
  trimTranslationCache();
  updateLineTranslationDom(currentIndex);
}

function toggleLineTranslation(lineIndex) {
  const line = state.lines[lineIndex];
  if (!line) return;

  const key = lineKey(line);
  const open = !state.openLineTranslations.has(key);

  if (open) state.openLineTranslations.add(key);
  else state.openLineTranslations.delete(key);

  updateLineTranslationDom(lineIndex);
  if (open) ensureLineTranslation(lineIndex);
}

function persist(key, value) {
  setSync({ [key]: value });
}

function onTranscriptClick(event) {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && String(selection).trim()) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  const linePlay = target.closest('.line-play');
  if (linePlay) {
    event.preventDefault();
    const lineIndex = Number(linePlay.dataset.lineIndex);
    if (Number.isInteger(lineIndex)) playLine(lineIndex);
    return;
  }

  const lineLoop = target.closest('.line-loop');
  if (lineLoop) {
    event.preventDefault();
    const lineIndex = Number(lineLoop.dataset.lineIndex);
    if (Number.isInteger(lineIndex)) toggleLineLoop(lineIndex);
    return;
  }

  const lineTranslate = target.closest('.line-translate');
  if (lineTranslate) {
    event.preventDefault();
    const lineIndex = Number(lineTranslate.dataset.lineIndex);
    if (Number.isInteger(lineIndex)) toggleLineTranslation(lineIndex);
    return;
  }

  const wordEl = target.closest('.word');
  if (!wordEl || wordEl.classList.contains('word-punctuation')) return;

  const lineIndex = Number(wordEl.dataset.lineIndex);
  const wordIndex = Number(wordEl.dataset.wordIndex);
  if (!Number.isInteger(lineIndex) || !Number.isInteger(wordIndex)) return;

  cancelHoverTimers();
  openWord(lineIndex, wordIndex, wordEl, { source: 'click' });
}

function onTranscriptPointerOver(event) {
  if (event.pointerType === 'touch' || event.buttons !== 0) return;
  if (!(event.target instanceof Element)) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && String(selection).trim()) return;
  const wordEl = event.target.closest('.word');
  if (!wordEl || wordEl.classList.contains('word-punctuation')) return;
  if (state.popover.open && state.popover.pinned) return;
  if (
    event.relatedTarget instanceof Node &&
    wordEl.contains(event.relatedTarget)
  ) {
    return;
  }
  scheduleHoverOpen(wordEl);
}

function onTranscriptPointerOut(event) {
  if (!(event.target instanceof Element)) return;
  const wordEl = event.target.closest('.word');
  if (!wordEl || state.popover.pinned) return;
  if (
    event.relatedTarget instanceof Node &&
    (wordEl.contains(event.relatedTarget) ||
      els.wordPopover.contains(event.relatedTarget))
  ) {
    return;
  }
  if (state.popover.open && state.popover.anchor === wordEl) {
    scheduleHoverClose();
  } else if (state.hover.wordEl === wordEl) {
    clearTimeout(state.hover.timer);
    state.hover.timer = 0;
    state.hover.wordEl = null;
  }
}

function onTranscriptPointerDown(event) {
  cancelHoverTimers();
  if (event.target instanceof Element && event.target.closest('.word')) return;
  if (state.popover.open && !state.popover.pinned) hidePopoverVisual();
}

function onPopoverPointerEnter() {
  clearTimeout(state.hover.closeTimer);
  state.hover.closeTimer = 0;
}

function onPopoverPointerLeave(event) {
  if (!state.popover.open || state.popover.pinned) return;
  if (
    event.relatedTarget instanceof Node &&
    els.wordPopover.contains(event.relatedTarget)
  ) {
    return;
  }
  scheduleHoverClose();
}

function onDocumentClick(event) {
  cancelHoverTimers();

  if (
    !els.fontSizePanel.hidden &&
    (!(event.target instanceof Element) ||
      !event.target.closest('.font-size'))
  ) {
    closeFontPanel();
  }

  if (!state.popover.open) return;
  const target = event.target;
  if (!(target instanceof Element)) {
    closePopover();
    return;
  }
  if (target.closest('#wordPopover')) return;
  if (target.closest('.word')) return;
  closePopover();
}

function setFontPanel(open) {
  els.fontSizePanel.hidden = !open;
  els.fontSizeButton.setAttribute('aria-expanded', String(open));
}

function closeFontPanel() {
  setFontPanel(false);
}

function toggleFontPanel() {
  setFontPanel(els.fontSizePanel.hidden);
}

function onFontSizeInput() {
  const size = Math.min(
    28,
    Math.max(16, Number(els.fontSizeRange.value) || 20)
  );
  state.settings.fontSize = size;
  applyFontSize();
  clearTimeout(state.fontSaveTimer);
  state.fontSaveTimer = setTimeout(() => persist('fontSize', size), 220);
}

function onFontSizeChange() {
  clearTimeout(state.fontSaveTimer);
  persist('fontSize', state.settings.fontSize);
}

function setTargetLang(value) {
  const next = value === 'es' ? 'es' : 'pt-BR';
  if (next === state.settings.targetLang) return;

  state.settings.targetLang = next;
  if (els.targetLangSelect) els.targetLangSelect.value = next;
  state.openLineTranslations.clear();
  state.lineTranslationRequests.clear();
  closePopover({ resume: false });
  persist('targetLang', next);
  requestFull(true);
}

function setExtensionEnabled(next) {
  const value = !!next;
  if (value === state.settings.enabled) return;

  state.settings.enabled = value;
  updatePreferenceButtons();
  persist('enabled', value);

  if (value) {
    setStatus('A ativar a extensão…', 'ok');
    setTimeout(() => {
      if (state.destroyed) return;
      requestFull(true);
      schedulePoll(400);
    }, 300);
  } else {
    applyFailure({ ok: false, error: 'disabled' });
  }
}

async function retryReader() {
  if (!state.settings.enabled) {
    setExtensionEnabled(true);
    return;
  }

  els.emptyState.hidden = false;
  setStatus('A tentar novamente…', 'ok');
  const result = await runCommand('retry', undefined, { silent: true });
  if (!result || result.ok === false) {
    showToast(describeError(result && result.error));
  }
  setTimeout(() => requestFull(true), 900);
  schedulePoll(1300);
}

function togglePlayPause() {
  const paused = state.light ? !!state.light.paused : true;
  controlPlayback(paused);
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    if (!els.fontSizePanel.hidden) {
      event.preventDefault();
      closeFontPanel();
      return;
    }
    if (state.popover.open) {
      event.preventDefault();
      closePopover();
    }
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'ArrowUp' && !blocksLineArrow(event.target)) {
    if (event.repeat) return;
    event.preventDefault();
    jumpLine(-1);
    return;
  }

  if (event.key === 'ArrowDown' && !blocksLineArrow(event.target)) {
    if (event.repeat) return;
    event.preventDefault();
    jumpLine(1);
    return;
  }

  if (isFormTarget(event.target)) return;

  if (event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'Home' || event.key === 'End') {
    suspendFollowForScroll();
    return;
  }

  if (event.code === 'Space') {
    if (event.repeat) return;
    event.preventDefault();
    togglePlayPause();
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    seekBy(-5);
    return;
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    seekBy(5);
    return;
  }

  if (event.key === '[') {
    event.preventDefault();
    jumpLine(-1);
    return;
  }

  if (event.key === ']') {
    event.preventDefault();
    jumpLine(1);
  }
}

function onScroll() {
  if (performance.now() < state.programmaticScrollUntil) return;

  cancelHoverTimers();
  if (state.popover.open) closePopover();
}

function onTranscriptWheel() {
  suspendFollowForScroll();
  cancelHoverTimers();
  if (state.popover.open && !state.popover.pinned) hidePopoverVisual();
}

function onTranscriptPointerDownScroll(event) {
  const rect = els.scrollArea.getBoundingClientRect();
  if (event.clientX >= rect.right - 18) suspendFollowForScroll();
}

function onStorageChanged(changes, area) {
  if (area !== 'sync') return;
  let changed = false;
  let targetChanged = false;

  if (changes.enabled) {
    const next = changes.enabled.newValue !== false;
    if (next !== state.settings.enabled) {
      state.settings.enabled = next;
      changed = true;

      if (next) {
        setStatus('A ativar a extensão…', 'ok');
        setTimeout(() => {
          if (state.destroyed) return;
          requestFull(true);
          schedulePoll(400);
        }, 300);
      } else {
        applyFailure({ ok: false, error: 'disabled' });
      }
    }
  }

  if (changes.targetLang) {
    const next = changes.targetLang.newValue === 'es' ? 'es' : 'pt-BR';
    if (next !== state.settings.targetLang) {
      state.settings.targetLang = next;
      state.openLineTranslations.clear();
      state.lineTranslationRequests.clear();
      targetChanged = true;
      changed = true;
    }
  }

  if (changes.fontSize) {
    const next = Math.min(
      28,
      Math.max(16, Number(changes.fontSize.newValue) || 20)
    );

    if (next !== state.settings.fontSize) {
      state.settings.fontSize = next;
      applyFontSize();
      changed = true;
    }
  }

  if (changes.followAudio) {
    const next = changes.followAudio.newValue !== false;
    state.follow = next;
    state.settings.followAudio = next;
    clearFollowSuspension();
    if (next) requestAnimationFrame(() => scrollToActive(true));
    changed = true;
  }

  if (changes.loopLine) {
    const next = changes.loopLine.newValue === true;
    if (next !== state.settings.loopLine) {
      setLoopEnabled(next, false);
    }
    changed = true;
  }

  if (changed) updatePreferenceButtons();

  if (targetChanged) {
    closePopover();
    requestFull(true);
  }
}

function bindEvents() {
  els.seekBack.addEventListener('click', () => {
    seekBy(-5);
  });

  els.rateSelect.addEventListener('change', () => {
    runCommand('rate', Number(els.rateSelect.value) || 1);
  });

  els.targetLangSelect.addEventListener('change', () => {
    setTargetLang(els.targetLangSelect.value);
  });

  els.fontSizeButton.addEventListener('click', () => {
    toggleFontPanel();
  });

  els.fontSizeRange.addEventListener('input', onFontSizeInput);
  els.fontSizeRange.addEventListener('change', onFontSizeChange);

  els.powerToggle.addEventListener('click', () => {
    setExtensionEnabled(!state.settings.enabled);
  });

  els.followAudio.addEventListener('click', () => {
    state.follow = !state.follow;
    state.settings.followAudio = state.follow;
    clearFollowSuspension();
    updatePreferenceButtons();
    persist('followAudio', state.follow);
    if (state.follow) scrollToActive(true);
  });

  els.retryButton.addEventListener('click', retryReader);
  els.transcript.addEventListener('click', onTranscriptClick);
  els.transcript.addEventListener('pointerover', onTranscriptPointerOver);
  els.transcript.addEventListener('pointerout', onTranscriptPointerOut);
  els.transcript.addEventListener('pointerdown', onTranscriptPointerDown);
  els.wordPopover.addEventListener('pointerenter', onPopoverPointerEnter);
  els.wordPopover.addEventListener('pointerleave', onPopoverPointerLeave);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  els.scrollArea.addEventListener('scroll', onScroll, { passive: true });
  els.scrollArea.addEventListener('wheel', onTranscriptWheel, { passive: true });
  els.scrollArea.addEventListener('touchmove', onTranscriptWheel, { passive: true });
  els.scrollArea.addEventListener('pointerdown', onTranscriptPointerDownScroll, {
    passive: true,
  });
  window.addEventListener('resize', () => {
    if (state.popover.open && state.popover.anchor) {
      positionPopover(state.popover.anchor);
    }
  });

  window.addEventListener('beforeunload', () => {
    state.destroyed = true;
    clearTimeout(state.pollTimer);
    clearTimeout(state.fontSaveTimer);
    cancelAnimationFrame(state.rafId);
    cancelHoverTimers();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    schedulePoll(80);
  });

  chrome.storage.onChanged.addListener(onStorageChanged);

  els.popClose.addEventListener('click', (event) => {
    event.stopPropagation();
    closePopover();
  });

  els.wordPopover.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  els.popRepeat.addEventListener('click', (event) => {
    event.stopPropagation();
    repeatLine();
  });
}

async function init() {
  const params = new URL(location.href).searchParams;
  state.tabId = Number(params.get('tabId'));

  await loadSettings();
  bindEvents();
  updatePreferenceButtons();
  updateEmptyState(null);
  startRenderLoop();

  if (!Number.isInteger(state.tabId) || state.tabId <= 0) {
    state.connectionError = describeError('not-watch');
    setStatus(state.connectionError, 'error');
    updateEmptyState({
      ok: false,
      error: 'not-watch',
      ready: false,
      loading: false,
      fallback: false,
      ad: false,
    });
    els.retryButton.hidden = true;
    return;
  }

  const ready = await sendBackground(
    'legrendas:reader-ready',
    { tabId: state.tabId },
    6000
  );

  if (ready && ready.state) applyPlayback(ready.state);
  if (!ready || ready.ok === false) applyFailure(ready);

  await requestFull(true);
  startPolling();
}

init().catch((error) => {
  state.connectionError = `Não foi possível iniciar o leitor: ${error.message || error}`;
  setStatus(state.connectionError, 'error');
  updateEmptyState({
    ok: false,
    error: 'init',
    ready: false,
    loading: false,
    fallback: false,
    ad: false,
  });
});
