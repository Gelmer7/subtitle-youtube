'use strict';

const DEFAULTS = {
  enabled: true,
  targetLang: 'pt-BR',
  showTranslation: true,
  fontSize: 20,
  fullscreen: 'shrink',
};

const $ = (id) => document.getElementById(id);
const enabled = $('enabled');
const targetLang = $('targetLang');
const showTranslation = $('showTranslation');
const fontSize = $('fontSize');
const fontSizeOut = $('fontSizeOut');
const fullscreen = $('fullscreen');
const previewOriginal = document.querySelector('.preview-original');
const previewTranslation = document.querySelector('.preview-translation');
const readerButton = $('openReader');
const readerStatus = $('readerStatus');

let saveTimer = 0;
let readerTabId = null;
let readerBusy = false;

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
    /^https:\/\/www\.youtube\.com\/(watch|live)([/?#]|$)/.test(url)
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
  setReaderStatus('Abre uma janela só com o texto e o áudio do vídeo.');
}

function openReaderWindow() {
  if (readerBusy || !readerTabId) return;

  readerBusy = true;
  readerButton.disabled = true;
  setReaderStatus('A abrir a janela do leitor…');

  try {
    chrome.runtime.sendMessage(
      { type: 'legrendas:open-reader', tabId: readerTabId },
      (response) => {
        readerBusy = false;

        if (chrome.runtime.lastError) {
          setReaderStatus(
            chrome.runtime.lastError.message || 'Não foi possível abrir a janela.',
            true
          );
          readerButton.disabled = false;
          return;
        }

        if (!response || !response.ok) {
          setReaderStatus(
            (response && response.error) || 'Não foi possível abrir a janela.',
            true
          );
          readerButton.disabled = false;
          return;
        }

        setReaderStatus(
          response.existing
            ? 'A janela do leitor já estava aberta.'
            : 'Janela aberta. Podes minimizar esta aba; o áudio continua.'
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

function renderPreview() {
  const size = Number(fontSize.value) || 20;
  fontSizeOut.textContent = `${size} px`;
  previewOriginal.style.fontSize = `${Math.round(size * 0.7)}px`;
  previewTranslation.style.fontSize = `${Math.round(size * 0.6)}px`;
  previewTranslation.textContent = targetLang.value === 'es'
    ? 'Esta es la línea en español.'
    : 'Esta é a linha em português.';
}

function snapshot() {
  return {
    enabled: enabled.checked,
    targetLang: targetLang.value,
    showTranslation: showTranslation.checked,
    fontSize: Number(fontSize.value),
    fullscreen: fullscreen.value,
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
  showTranslation.checked = !!settings.showTranslation;
  fontSize.value = String(Math.min(28, Math.max(16, Number(settings.fontSize) || 20)));
  fullscreen.value = settings.fullscreen === 'hide' ? 'hide' : 'shrink';
  renderPreview();
}

enabled.addEventListener('change', () => {
  save();
  refreshReaderAvailability();
});
targetLang.addEventListener('change', () => {
  renderPreview();
  save();
});
showTranslation.addEventListener('change', save);
fullscreen.addEventListener('change', save);
fontSize.addEventListener('input', () => {
  renderPreview();
  scheduleSave();
});
fontSize.addEventListener('change', save);
readerButton.addEventListener('click', openReaderWindow);

load().then(refreshReaderAvailability);
