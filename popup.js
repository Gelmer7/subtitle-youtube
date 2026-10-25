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

let saveTimer = 0;

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

enabled.addEventListener('change', save);
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

load();
