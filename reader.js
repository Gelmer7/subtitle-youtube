'use strict';

const SETTINGS_DEFAULTS = {
  targetLang: 'pt-BR',
  showTranslation: true,
  fontSize: 20,
  pauseOnLookup: false,
  followAudio: true,
};

const els = {
  connection: document.getElementById('connection'),
  videoTitle: document.getElementById('videoTitle'),
  videoMeta: document.getElementById('videoMeta'),
  statusBar: document.getElementById('statusBar'),
  scrollArea: document.getElementById('scrollArea'),
  transcript: document.getElementById('transcript'),
  emptyState: document.getElementById('emptyState'),
  emptyText: document.getElementById('emptyText'),
  retryButton: document.getElementById('retryButton'),
  playButton: document.getElementById('playButton'),
  backButton: document.getElementById('backButton'),
  forwardButton: document.getElementById('forwardButton'),
  timeDisplay: document.getElementById('timeDisplay'),
  prevLineButton: document.getElementById('prevLineButton'),
  nextLineButton: document.getElementById('nextLineButton'),
  rateSelect: document.getElementById('rateSelect'),
  muteButton: document.getElementById('muteButton'),
  showTranslation: document.getElementById('showTranslation'),
  pauseOnLookup: document.getElementById('pauseOnLookup'),
  followAudio: document.getElementById('followAudio'),
  fullscreenButton: document.getElementById('fullscreenButton'),
  closeButton: document.getElementById('closeButton'),
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
  lines: [],
  revision: -1,
  fullLoading: false,
  pendingFull: null,
  light: null,
  base: null,
  connected: false,
  connectionError: '',
  lineEls: [],
  wordEls: [],
  activeLine: -1,
  activeWord: -1,
  lastDisplayedSecond: -1,
  pollTimer: 0,
  pollBusy: false,
  rafId: 0,
  programmaticScrollUntil: 0,
  translationCache: new Map(),
  lookupSession: null,
  popover: {
    open: false,
    requestId: 0,
    anchor: null,
    key: '',
    lineIndex: -1,
    lineStart: 0,
  },
  toastTimer: 0,
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
  state.settings.targetLang = state.settings.targetLang === 'es' ? 'es' : 'pt-BR';
  state.settings.showTranslation = state.settings.showTranslation !== false;
  state.settings.pauseOnLookup = state.settings.pauseOnLookup === true;
  state.settings.followAudio = state.settings.followAudio !== false;
  state.settings.fontSize = Math.min(
    28,
    Math.max(16, Number(state.settings.fontSize) || 20)
  );
  state.follow = state.settings.followAudio;
}

async function loadSettings() {
  const stored = await getSync(SETTINGS_DEFAULTS);
  state.settings = { ...SETTINGS_DEFAULTS, ...stored };
  normalizeSettings();
  applySettingsToUi();
}

function applySettingsToUi() {
  const readerSize = Math.min(42, Math.max(22, state.settings.fontSize + 6));
  document.documentElement.style.setProperty('--reader-size', `${readerSize}px`);
  els.showTranslation.checked = state.settings.showTranslation;
  els.pauseOnLookup.checked = state.settings.pauseOnLookup;
  els.followAudio.checked = state.follow;
  els.transcript.classList.toggle(
    'hide-translation',
    !state.settings.showTranslation
  );
}

function setConnection(text, kind = '') {
  els.connection.textContent = text;
  if (kind) els.connection.dataset.state = kind;
  else delete els.connection.dataset.state;
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

function isReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isFormTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, select, textarea, button, [contenteditable="true"]');
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
      return 'A extensão está desativada. Ativa-a no ícone da barra do Chrome.';
    case 'not-watch':
      return 'Abre um vídeo do YouTube para usar o modo leitura.';
    case 'tab-unavailable':
    case 'timeout':
      return 'A aba do YouTube foi fechada ou deixou de responder. O texto que já foi carregado continua disponível.';
    case 'play-blocked':
      return 'O Chrome bloqueou a reprodução vinda desta janela. Carrega no play da aba do YouTube.';
    case 'sem-video':
      return 'Não há um vídeo associado a esta janela. Abre o modo leitura a partir de um vídeo do YouTube.';
    default:
      return `Não foi possível controlar o vídeo (${code || 'erro desconhecido'}).`;
  }
}

function shortConnectionLabel(code) {
  switch (code) {
    case 'disabled':
      return 'Desativada';
    case 'not-watch':
      return 'Sem vídeo';
    case 'tab-unavailable':
    case 'timeout':
      return 'Vídeo fechado';
    default:
      return 'Sem ligação';
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
  els.timeDisplay.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
}

function updateHeader(data) {
  const title = data.title || 'Vídeo do YouTube';
  if (els.videoTitle.textContent !== title) els.videoTitle.textContent = title;
  document.title = `${title} — legrendas`;

  const parts = [];
  if (data.channel) parts.push(data.channel);
  if (data.lineCount) {
    parts.push(`${data.lineCount} ${data.lineCount === 1 ? 'linha' : 'linhas'}`);
  }
  const meta = parts.join('  ·  ');
  if (els.videoMeta.textContent !== meta) els.videoMeta.textContent = meta;
  els.videoMeta.hidden = !meta;

  if (state.connectionError) return;

  if (data.ad) setConnection('Anúncio', 'warn');
  else if (data.loading) setConnection('A carregar', 'warn');
  else if (data.ready) setConnection('Ligado', 'ok');
  else if (data.fallback) setConnection('Legenda nativa', 'warn');
  else setConnection('Sem legendas', 'warn');
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
  const paused = data ? !!data.paused : true;
  els.playButton.textContent = paused ? '▶' : '❚❚';
  els.playButton.setAttribute(
    'aria-label',
    paused ? 'Reproduzir' : 'Pausar'
  );
  els.playButton.title = paused ? 'Reproduzir' : 'Pausar';
  els.playButton.classList.toggle('is-playing', !paused);

  if (data) {
    const rate = Number(data.rate) || 1;
    const option = Array.from(els.rateSelect.options).find(
      (item) => Number(item.value) === rate
    );
    if (option) els.rateSelect.value = option.value;

    const isMuted = !!data.muted || Number(data.volume) === 0;
    els.muteButton.textContent = isMuted ? 'Mudo' : 'Som';
    els.muteButton.classList.toggle('is-on', isMuted);
    els.muteButton.setAttribute(
      'aria-label',
      isMuted ? 'Ativar som' : 'Silenciar'
    );
    els.muteButton.title = isMuted ? 'Ativar som' : 'Silenciar';
  }

  els.showTranslation.checked = state.settings.showTranslation;
  els.pauseOnLookup.checked = state.settings.pauseOnLookup;
  els.followAudio.checked = state.follow;
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

function renderTranscript() {
  state.lineEls = [];
  state.wordEls = [];
  state.activeLine = -1;
  state.activeWord = -1;

  const fragment = document.createDocumentFragment();

  state.lines.forEach((line, lineIndex) => {
    const lineEl = document.createElement('article');
    lineEl.className = 'line';
    lineEl.dataset.lineIndex = String(lineIndex);

    const timeButton = document.createElement('button');
    timeButton.type = 'button';
    timeButton.className = 'line-time';
    timeButton.dataset.time = String(line.start);
    timeButton.textContent = formatTime(line.start);
    timeButton.title = `Ir para ${formatTime(line.start)}`;

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

    if (line.translation) {
      const translationEl = document.createElement('p');
      translationEl.className = 'line-translation';
      translationEl.textContent = line.translation;
      body.append(translationEl);
    }

    lineEl.append(timeButton, body);
    fragment.append(lineEl);
    state.lineEls[lineIndex] = lineEl;
    state.wordEls[lineIndex] = wordEls;
  });

  els.transcript.replaceChildren(fragment);
  els.transcript.classList.toggle(
    'hide-translation',
    !state.settings.showTranslation
  );
  els.transcript.hidden = state.lines.length === 0;
  els.emptyState.hidden = state.lines.length > 0;
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

function updatePlaybackUi(force = false) {
  updateTimeDisplay(force);

  if (!state.lines.length) return;

  const time = getEstimatedTime();
  const lineIndex = lineIndexForTime(time);
  let wordIndex = -1;

  if (lineIndex >= 0) {
    const line = state.lines[lineIndex];
    wordIndex = wordIndexForTime(line.words, time);
  }

  setActive(lineIndex, wordIndex);
}

function scrollToActive(force = false) {
  if (!state.follow || state.popover.open) return;
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
    relativeTop - els.scrollArea.clientHeight * 0.36
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
    state.videoId = data.videoId;
    renderTranscript();
  } else if (data.videoId) {
    state.videoId = data.videoId;
  }

  state.light = data;
  state.connected = true;
  state.connectionError = '';

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

  updateHeader(data);
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
  state.connected = false;
  state.connectionError = describeError(code);
  state.pendingFull = null;

  if (state.base) {
    state.base.time = getEstimatedTime();
    state.base.paused = true;
    state.base.at = performance.now();
  }

  setConnection(shortConnectionLabel(code), 'error');
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

  const result = await sendBackground(
    'legrendas:reader-state',
    { tabId: state.tabId, full: true },
    7000
  );

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
  const result = await sendBackground(
    'legrendas:reader-state',
    { tabId: state.tabId, full: false },
    5000
  );
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
  const result = await sendBackground(
    'legrendas:reader-command',
    { tabId: state.tabId, action, value },
    6000
  );

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

  if (play && state.follow && !state.popover.open) scrollToActive(true);
}

async function seekBy(delta) {
  if (!state.base) return;
  const target = Math.max(0, getEstimatedTime() + delta);
  state.base.time = Math.min(
    target,
    state.base.duration > 0 ? state.base.duration : target
  );
  state.base.at = performance.now();
  updatePlaybackUi(true);
  await runCommand('seek-by', delta, { silent: true });
}

async function seekTo(seconds) {
  if (!state.base) return;
  state.base.time = Math.max(0, Number(seconds) || 0);
  state.base.at = performance.now();
  updatePlaybackUi(true);
  await runCommand('seek', state.base.time, { silent: true });
}

function jumpLine(direction) {
  if (!state.lines.length) return;
  const time = getEstimatedTime();
  let index = lineIndexForTime(time);

  if (index < 0) {
    index = direction > 0 ? 0 : state.lines.length - 1;
  } else if (direction < 0) {
    if (time - state.lines[index].start < 1.2) index -= 1;
  } else {
    index += 1;
  }

  index = Math.min(state.lines.length - 1, Math.max(0, index));
  seekTo(state.lines[index].start);
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

function hidePopoverVisual() {
  state.popover.open = false;
  state.popover.anchor = null;
  state.popover.key = '';
  state.popover.requestId += 1;
  els.wordPopover.hidden = true;
}

function closePopover(options = {}) {
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

async function openWord(lineIndex, wordIndex, wordEl) {
  const line = state.lines[lineIndex];
  const word = line && line.words && line.words[wordIndex];
  if (!line || !word || !word.query) return;

  if (state.popover.open) hidePopoverVisual();

  state.popover.open = true;
  state.popover.anchor = wordEl;
  state.popover.lineIndex = lineIndex;
  state.popover.lineStart = line.start;
  state.popover.key = `${state.settings.targetLang}\u0000${word.query}`;
  const requestId = ++state.popover.requestId;

  els.popWord.textContent = word.text;
  els.popContext.textContent = line.text;
  els.popTranslation.classList.remove('is-error');
  els.popTranslation.textContent = 'A traduzir…';
  els.wordPopover.hidden = false;
  positionPopover(wordEl);

  maybePauseForLookup();

  const target = state.settings.targetLang;
  const key = translateCacheKey(target, word.query);
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
    state.popover.key !== `${target}\u0000${word.query}`
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
  await runCommand('seek', start, { silent: true });
  await runCommand('play');
}

function updateCheckboxSettings() {
  els.showTranslation.checked = state.settings.showTranslation;
  els.pauseOnLookup.checked = state.settings.pauseOnLookup;
  els.followAudio.checked = state.follow;
}

function persist(key, value) {
  setSync({ [key]: value });
}

function onTranscriptClick(event) {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && String(selection).trim()) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  const timeButton = target.closest('.line-time');
  if (timeButton) {
    closePopover();
    seekTo(Number(timeButton.dataset.time) || 0);
    return;
  }

  const wordEl = target.closest('.word');
  if (!wordEl || wordEl.classList.contains('word-punctuation')) return;

  const lineIndex = Number(wordEl.dataset.lineIndex);
  const wordIndex = Number(wordEl.dataset.wordIndex);
  if (!Number.isInteger(lineIndex) || !Number.isInteger(wordIndex)) return;

  openWord(lineIndex, wordIndex, wordEl);
}

function onDocumentClick(event) {
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

async function retryReader() {
  els.emptyState.hidden = false;
  setStatus('A tentar novamente…', 'ok');
  const result = await runCommand('retry', undefined, { silent: true });
  if (!result || result.ok === false) {
    showToast(describeError(result && result.error));
  }
  setTimeout(() => requestFull(true), 900);
  schedulePoll(1300);
}

async function closeReader() {
  const result = await sendBackground('legrendas:close-reader', {
    tabId: state.tabId,
  });
  if (!result || result.ok === false) {
    try {
      window.close();
    } catch {
      // ignore
    }
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {
      showToast('O Chrome não permitiu entrar em ecrã inteiro.');
    });
  }
}

function updateFullscreenButton() {
  els.fullscreenButton.textContent = document.fullscreenElement
    ? 'Sair de ecrã inteiro'
    : 'Ecrã inteiro';
}

function togglePlayPause() {
  const paused = state.light ? !!state.light.paused : true;
  controlPlayback(paused);
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    if (state.popover.open) {
      event.preventDefault();
      closePopover();
    }
    return;
  }

  if (isFormTarget(event.target)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

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
  if (state.popover.open) {
    closePopover();
    return;
  }

  if (state.follow) {
    state.follow = false;
    state.settings.followAudio = false;
    updateControls(state.light);
    persist('followAudio', false);
  }
}

function onStorageChanged(changes, area) {
  if (area !== 'sync') return;
  let changed = false;
  let targetChanged = false;

  if (changes.targetLang) {
    const next = changes.targetLang.newValue === 'es' ? 'es' : 'pt-BR';
    if (next !== state.settings.targetLang) {
      state.settings.targetLang = next;
      targetChanged = true;
      changed = true;
    }
  }

  if (changes.showTranslation) {
    state.settings.showTranslation = changes.showTranslation.newValue !== false;
    els.transcript.classList.toggle(
      'hide-translation',
      !state.settings.showTranslation
    );
    changed = true;
  }

  if (changes.fontSize) {
    state.settings.fontSize = Math.min(
      28,
      Math.max(16, Number(changes.fontSize.newValue) || 20)
    );
    applySettingsToUi();
    changed = true;
  }

  if (changes.pauseOnLookup) {
    state.settings.pauseOnLookup = changes.pauseOnLookup.newValue === true;
    changed = true;
  }

  if (changes.followAudio) {
    const next = changes.followAudio.newValue !== false;
    state.follow = next;
    state.settings.followAudio = next;
    if (next) requestAnimationFrame(() => scrollToActive(true));
    changed = true;
  }

  if (changed) updateCheckboxSettings();

  if (targetChanged) {
    closePopover();
    requestFull(true);
  }
}

function bindEvents() {
  els.playButton.addEventListener('click', togglePlayPause);
  els.backButton.addEventListener('click', () => seekBy(-5));
  els.forwardButton.addEventListener('click', () => seekBy(5));
  els.prevLineButton.addEventListener('click', () => jumpLine(-1));
  els.nextLineButton.addEventListener('click', () => jumpLine(1));
  els.rateSelect.addEventListener('change', () => {
    runCommand('rate', Number(els.rateSelect.value) || 1);
  });

  els.muteButton.addEventListener('click', async () => {
    const nextMuted = !(state.light && state.light.muted);
    if (state.light) state.light.muted = nextMuted;
    updateControls(state.light);
    await runCommand('mute', nextMuted, { silent: true });
  });

  els.showTranslation.addEventListener('change', () => {
    state.settings.showTranslation = els.showTranslation.checked;
    els.transcript.classList.toggle(
      'hide-translation',
      !state.settings.showTranslation
    );
    persist('showTranslation', state.settings.showTranslation);
  });

  els.pauseOnLookup.addEventListener('change', () => {
    state.settings.pauseOnLookup = els.pauseOnLookup.checked;
    persist('pauseOnLookup', state.settings.pauseOnLookup);
  });

  els.followAudio.addEventListener('change', () => {
    state.follow = els.followAudio.checked;
    state.settings.followAudio = state.follow;
    persist('followAudio', state.follow);
    if (state.follow) scrollToActive(true);
  });

  els.fullscreenButton.addEventListener('click', toggleFullscreen);
  els.closeButton.addEventListener('click', closeReader);
  els.retryButton.addEventListener('click', retryReader);
  els.transcript.addEventListener('click', onTranscriptClick);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
  els.scrollArea.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (state.popover.open && state.popover.anchor) {
      positionPopover(state.popover.anchor);
    }
  });

  window.addEventListener('beforeunload', () => {
    state.destroyed = true;
    clearTimeout(state.pollTimer);
    cancelAnimationFrame(state.rafId);
  });

  document.addEventListener('fullscreenchange', updateFullscreenButton);
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
  updateCheckboxSettings();
  updateFullscreenButton();
  updateEmptyState(null);
  setConnection('A ligar…', 'warn');
  startRenderLoop();

  if (!Number.isInteger(state.tabId) || state.tabId <= 0) {
    state.connectionError = describeError('not-watch');
    setConnection('Sem vídeo', 'error');
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
  setConnection('Erro', 'error');
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
