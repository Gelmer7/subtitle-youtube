'use strict';

const DEFAULTS = {
  enabled: true,
  targetLang: 'pt-BR',
  fontSize: 20,
};

const $ = (id) => document.getElementById(id);
const enabled = $('enabled');
const targetLang = $('targetLang');
const fontSize = $('fontSize');
const fontSizeOut = $('fontSizeOut');
const readerButton = $('openReader');
const readerStatus = $('readerStatus');

let saveTimer = 0;
let readerTabId = null;
let readerBusy = false;
let autoOpenDone = false;

function setReaderStatus(text, isError = false) {
  if (!readerStatus) return;
  readerStatus.textContent = text;
  readerStatus.dataset.error = isError ? 'true' : 'false';
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function isWatchUrl(url) {
  return (
    typeof url === 'string' &&
    /^https:\/\/(?:www\.|m\.)youtube\.com\/(?:watch|live)(?:[/?#]|$)/.test(
      url
    )
  );
}

async function refreshReaderAvailability() {
  if (!readerButton) return;

  readerTabId = null;

  if (!enabled.checked) {
    readerButton.disabled = true;
    setReaderStatus('Ativa a extensão primeiro.');
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    readerButton.disabled = true;
    setReaderStatus('Não foi possível identificar a aba ativa.');
    return;
  }

  // Host permission normally exposes the YouTube URL. If the browser hides
  // the URL, let the background validate the tab instead of blocking the UI.
  if (typeof tab.url === 'string' && tab.url && !isWatchUrl(tab.url)) {
    readerButton.disabled = true;
    readerTabId = null;
    setReaderStatus('Abre um vídeo do YouTube com legendas.');
    return;
  }

  readerTabId = tab.id;
  readerButton.disabled = false;
  setReaderStatus('Abre o leitor com a transcrição; o vídeo continua no YouTube.');
}

function openReaderWindow() {
  if (readerBusy || !readerTabId) return;
  readerBusy = true;
  readerButton.disabled = true;
  setReaderStatus('A abrir o leitor…');

  try {
    chrome.runtime.sendMessage(
      { type: 'legrendas:open-reader', tabId: readerTabId },
      (response) => {
        readerBusy = false;

        if (chrome.runtime.lastError) {
          setReaderStatus(
            chrome.runtime.lastError.message || 'Não foi possível abrir o leitor.',
            true
          );
          readerButton.disabled = false;
          return;
        }

        if (!response || !response.ok) {
          setReaderStatus(
            (response && response.error) || 'Não foi possível abrir o leitor.',
            true
          );
          readerButton.disabled = false;
          return;
        }

        const surface =
          response.surface === 'tab' ? 'numa aba' : 'numa janela';
        setReaderStatus(
          response.existing
            ? `O leitor já estava aberto ${surface}.`
            : `Leitor aberto ${surface}. O vídeo continua no YouTube.`
        );
        setTimeout(() => window.close(), 550);
      }
    );
  } catch (error) {
    readerBusy = false;
    setReaderStatus(String(error), true);
    readerButton.disabled = false;
  }
}

function maybeAutoOpenReader() {
  if (autoOpenDone || readerBusy) return;
  if (!enabled.checked || !readerTabId) return;

  autoOpenDone = true;
  openReaderWindow();
}

function renderFontSize() {
  const size = Number(fontSize.value) || 20;
  fontSizeOut.textContent = `${size} px`;
}

function snapshot() {
  return {
    enabled: enabled.checked,
    targetLang: targetLang.value,
    fontSize: Number(fontSize.value),
  };
}

function save() {
  chrome.storage.sync.set(snapshot()).catch(() => {});
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 220);
}

async function load() {
  let settings = DEFAULTS;
  try {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    // Use defaults.
  }

  enabled.checked = !!settings.enabled;
  targetLang.value = settings.targetLang === 'es' ? 'es' : 'pt-BR';
  fontSize.value = String(
    Math.min(28, Math.max(16, Number(settings.fontSize) || 20))
  );
  renderFontSize();
}

enabled.addEventListener('change', () => {
  save();
  autoOpenDone = false;
  refreshReaderAvailability().then(maybeAutoOpenReader);
});
targetLang.addEventListener('change', save);
fontSize.addEventListener('input', () => {
  renderFontSize();
  scheduleSave();
});
fontSize.addEventListener('change', save);
readerButton.addEventListener('click', openReaderWindow);

load().then(refreshReaderAvailability).then(maybeAutoOpenReader);
