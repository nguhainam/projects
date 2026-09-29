// ===========================================================
// Inline editing + autosave (localStorage) + PDF export
// + text formatting toolbar + undo / redo history
// ===========================================================

const STORAGE_KEY = 'irisResumeEditsV1';
const PAGE_STYLE_KEY = 'irisResumePageStyleV1';
const HISTORY_LIMIT = 80;

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function persistElement(el) {
  if (!el || !el.dataset || !el.dataset.editId) return;
  const store = loadStore();
  store[el.dataset.editId] = el.outerHTML;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function persistAllEditable() {
  document.querySelectorAll('#resume [data-edit-id]').forEach(persistElement);
}

function restoreAll() {
  const store = loadStore();
  Object.keys(store).forEach((id) => {
    const el = document.querySelector(`[data-edit-id="${cssEscape(id)}"]`);
    if (!el) return;
    // Parse the tag and its content separately: parsing outerHTML as a whole
    // cuts a <p> short at the first <div> the browser inserts on Enter.
    const match = store[id].match(/^(<[^>]+>)([\s\S]*)<\/[\w-]+>\s*$/);
    if (!match) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = match[1];
    const restored = wrapper.firstElementChild;
    if (!restored) return;
    restored.innerHTML = match[2];
    el.replaceWith(restored);
  });
}

function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/([^\w-])/g, '\\$1');
}

// ---------- Undo / redo history ----------

const historyStack = [];
let historyIndex = -1;
let historySuspended = false;
let historyDebounceTimer = null;

function captureSnapshot() {
  const page = document.getElementById('resume');
  return {
    html: page.innerHTML,
    pageStyle: loadPageStyle(),
    store: loadStore(),
  };
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (!undoBtn || !redoBtn) return;
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex < 0 || historyIndex >= historyStack.length - 1;
}

function pushHistory() {
  if (historySuspended) return;
  const snap = captureSnapshot();
  // Drop any redo branch
  historyStack.splice(historyIndex + 1);
  const last = historyStack[historyStack.length - 1];
  if (
    last &&
    last.html === snap.html &&
    JSON.stringify(last.pageStyle) === JSON.stringify(snap.pageStyle)
  ) {
    return;
  }
  historyStack.push(snap);
  if (historyStack.length > HISTORY_LIMIT) {
    historyStack.shift();
  }
  historyIndex = historyStack.length - 1;
  updateHistoryButtons();
}

function pushHistoryDebounced() {
  clearTimeout(historyDebounceTimer);
  historyDebounceTimer = setTimeout(pushHistory, 400);
}

function applySnapshot(snap) {
  historySuspended = true;
  const page = document.getElementById('resume');
  page.innerHTML = snap.html;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snap.store || {}));
  savePageStyle(snap.pageStyle || {});
  applyPageStyle(snap.pageStyle || {});

  const fontSelect = document.getElementById('fmtFont');
  const sizeSelect = document.getElementById('fmtSize');
  if (fontSelect) {
    fontSelect.value = (snap.pageStyle && snap.pageStyle.fontFamily) || fontSelect.options[0].value;
  }
  if (sizeSelect) {
    sizeSelect.value = (snap.pageStyle && snap.pageStyle.fontSize) || '';
  }

  enhanceBulletLists();
  wireAddBulletButtons();
  historySuspended = false;
  updateHistoryButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  clearTimeout(historyDebounceTimer);
  historyIndex -= 1;
  applySnapshot(historyStack[historyIndex]);
}

function redo() {
  if (historyIndex >= historyStack.length - 1) return;
  clearTimeout(historyDebounceTimer);
  historyIndex += 1;
  applySnapshot(historyStack[historyIndex]);
}

// ---------- Bullet list helpers ----------

function makeDeleteButton() {
  const del = document.createElement('span');
  del.className = 'del-bullet no-print';
  del.title = 'Remove bullet';
  del.textContent = '×';
  del.setAttribute('contenteditable', 'false');
  return del;
}

function enhanceBulletLists() {
  document.querySelectorAll('ul[data-editable-list="true"]').forEach((ul) => {
    Array.from(ul.children).forEach((li) => {
      if (li.tagName !== 'LI') return;
      li.setAttribute('contenteditable', 'true');
      if (!li.querySelector('.del-bullet')) {
        li.appendChild(makeDeleteButton());
      }
    });
  });
}

function placeCaretAtStart(el) {
  el.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  if (el.firstChild) {
    range.setStart(el.firstChild, 0);
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function wireAddBulletButtons() {
  document.querySelectorAll('.add-bullet').forEach((btn) => {
    if (btn.dataset.wired === 'true') return;
    btn.dataset.wired = 'true';
    btn.addEventListener('click', () => {
      const ul = document.querySelector(`[data-edit-id="${cssEscape(btn.dataset.target)}"]`);
      if (!ul) return;
      const li = document.createElement('li');
      li.setAttribute('contenteditable', 'true');
      li.textContent = 'New bullet point';
      li.appendChild(makeDeleteButton());
      ul.appendChild(li);
      persistElement(ul);
      placeCaretAtStart(li);
      pushHistory();
    });
  });
}

// ---------- Formatting toolbar ----------

let applyToWholePage = false;
let savedSelection = null;

function getResumeSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const page = document.getElementById('resume');
  if (!page.contains(range.commonAncestorContainer)) return null;
  return { sel, range, collapsed: sel.isCollapsed };
}

function saveSelection() {
  const current = getResumeSelection();
  savedSelection = current ? current.range.cloneRange() : null;
}

function restoreSelection() {
  if (!savedSelection) return false;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedSelection);
    return true;
  } catch (e) {
    return false;
  }
}

function selectionInsideResume() {
  const current = getResumeSelection();
  return !!(current && !current.collapsed);
}

function selectAllResumeText() {
  const page = document.getElementById('resume');
  const range = document.createRange();
  range.selectNodeContents(page);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  savedSelection = range.cloneRange();
  applyToWholePage = true;
  document.getElementById('fmtSelectAll').classList.add('active');
}

function clearWholePageMode() {
  applyToWholePage = false;
  document.getElementById('fmtSelectAll').classList.remove('active');
}

function loadPageStyle() {
  try {
    return JSON.parse(localStorage.getItem(PAGE_STYLE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function savePageStyle(style) {
  localStorage.setItem(PAGE_STYLE_KEY, JSON.stringify(style));
}

function applyPageStyle(style) {
  const page = document.getElementById('resume');
  if (style.fontFamily) page.style.fontFamily = style.fontFamily;
  else page.style.fontFamily = '';
  if (style.sizeScale) page.style.setProperty('--size-scale', String(style.sizeScale));
  else page.style.removeProperty('--size-scale');
  if (style.lineHeight) page.style.setProperty('--line-height', String(style.lineHeight));
  else page.style.removeProperty('--line-height');
  syncLineHeightDisplay(style.lineHeight || LINE_HEIGHT_DEFAULT);
}

function persistEditableAfterFormat() {
  persistAllEditable();
  pushHistory();
}

function runFormatCommand(command, value) {
  if (!restoreSelection() && !selectionInsideResume()) {
    if (!applyToWholePage) return false;
  }
  document.execCommand(command, false, value);
  persistEditableAfterFormat();
  saveSelection();
  return true;
}

function wrapSelectionWithStyle(styles) {
  if (!restoreSelection() && !selectionInsideResume()) return false;
  const current = getResumeSelection();
  if (!current) return false;

  const { range } = current;
  const span = document.createElement('span');
  Object.assign(span.style, styles);

  try {
    range.surroundContents(span);
  } catch (e) {
    const fragment = range.extractContents();
    span.appendChild(fragment);
    range.insertNode(span);
  }

  const sel = window.getSelection();
  sel.removeAllRanges();
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.addRange(newRange);
  savedSelection = newRange.cloneRange();
  persistEditableAfterFormat();
  return true;
}

function applyFontFamily(value) {
  if (!value) return;
  if (applyToWholePage) {
    const page = document.getElementById('resume');
    page.style.fontFamily = value;
    const style = loadPageStyle();
    style.fontFamily = value;
    savePageStyle(style);
    pushHistory();
    return;
  }
  if (!wrapSelectionWithStyle({ fontFamily: value })) {
    runFormatCommand('fontName', value.split(',')[0].replace(/['"]/g, '').trim());
  }
}

function applyFontSize(value) {
  if (applyToWholePage) {
    const page = document.getElementById('resume');
    const style = loadPageStyle();
    if (!value) {
      page.style.removeProperty('--size-scale');
      delete style.sizeScale;
      delete style.fontSize;
    } else {
      const scale = parseFloat(value) / 13;
      page.style.setProperty('--size-scale', String(scale));
      style.sizeScale = scale;
      style.fontSize = value;
    }
    savePageStyle(style);
    pushHistory();
    return;
  }
  if (!value) return;
  wrapSelectionWithStyle({ fontSize: value });
}

const LINE_HEIGHT_DEFAULT = 1.45;
const LINE_HEIGHT_STEP = 0.05;
const LINE_HEIGHT_MIN = 1.0;
const LINE_HEIGHT_MAX = 2.5;

// Tracks the value shown in the stepper so +/- always increments from the
// last applied value (not a hardcoded CSS default).
let lineHeightState = LINE_HEIGHT_DEFAULT;

function getEditableRoot(el) {
  if (!el) return null;
  // Prefer the contenteditable host (the actual text box)
  const editable = el.closest('#resume [contenteditable="true"]');
  if (editable) {
    // List items live inside a ul[data-edit-id]; keep the <li> as the target
    // so line-height can be set per bullet, not the whole list.
    if (editable.closest('ul[data-editable-list], ol[data-editable-list]')) {
      return editable.closest('li') || editable;
    }
    return editable.closest('[data-edit-id]') || editable;
  }
  return el.closest('#resume [data-edit-id]') || el;
}

function clearDescendantLineHeights(root) {
  if (!root) return;
  root.querySelectorAll('*').forEach((child) => {
    if (child.style && child.style.lineHeight) {
      child.style.lineHeight = '';
    }
  });
}

function getActiveEditable(restore = true) {
  if (restore) restoreSelection();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    let node = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (node && node.closest) {
      const el = node.closest('#resume [contenteditable="true"], #resume [data-edit-id]');
      if (el) return getEditableRoot(el);
    }
  }
  const active = document.activeElement;
  if (active && active.closest && active.closest('#resume') && active.isContentEditable) {
    return getEditableRoot(active);
  }
  return null;
}

function readLineHeightFromElement(el) {
  if (!el) return null;
  // Prefer an explicit inline style (what we set) over computed px values
  if (el.style.lineHeight) {
    const n = parseFloat(el.style.lineHeight);
    if (!Number.isNaN(n)) return n;
  }
  const computed = getComputedStyle(el);
  const lh = computed.lineHeight;
  const fs = parseFloat(computed.fontSize);
  if (lh === 'normal' || !fs) return null;
  const px = parseFloat(lh);
  if (Number.isNaN(px)) return null;
  return Math.round((px / fs) * 100) / 100;
}

function currentLineHeight() {
  if (!applyToWholePage) {
    const el = getActiveEditable(true);
    const fromEl = readLineHeightFromElement(el);
    if (fromEl != null) return fromEl;
  }
  const style = loadPageStyle();
  if (style.lineHeight) return Number(style.lineHeight);
  return lineHeightState || LINE_HEIGHT_DEFAULT;
}

function syncLineHeightDisplay(value) {
  lineHeightState = Number(value);
  const el = document.getElementById('fmtLineValue');
  if (el) el.textContent = lineHeightState.toFixed(2);
}

function persistEditableRoot(el) {
  if (!el) return;
  const root = el.closest('[data-edit-id]') || (el.dataset && el.dataset.editId ? el : null);
  if (root) persistElement(root);
  else persistAllEditable();
}

function applyLineHeight(value) {
  const rounded = Math.min(
    LINE_HEIGHT_MAX,
    Math.max(LINE_HEIGHT_MIN, Math.round(value * 100) / 100)
  );

  if (applyToWholePage) {
    const page = document.getElementById('resume');
    const style = loadPageStyle();
    page.style.setProperty('--line-height', String(rounded));
    // Clear per-field and nested overrides so the page setting actually shows
    document.querySelectorAll('#resume [style]').forEach((el) => {
      if (el.style.lineHeight) el.style.lineHeight = '';
    });
    style.lineHeight = rounded;
    savePageStyle(style);
    syncLineHeightDisplay(rounded);
    persistAllEditable();
    pushHistory();
    return;
  }

  // Apply on the text-box root (e.g. the profile <p>), not an inner <span>.
  // Nested spans with a larger line-height would otherwise keep the visual
  // stuck at ~1.45 because browsers use the max line-height on a line.
  const el = getActiveEditable(true);
  if (el) {
    clearDescendantLineHeights(el);
    el.style.lineHeight = String(rounded);
    persistEditableRoot(el);
    syncLineHeightDisplay(rounded);
    pushHistory();
    return;
  }

  // Fallback: whole page
  const page = document.getElementById('resume');
  const style = loadPageStyle();
  page.style.setProperty('--line-height', String(rounded));
  style.lineHeight = rounded;
  savePageStyle(style);
  syncLineHeightDisplay(rounded);
  pushHistory();
}

function nudgeLineHeight(delta) {
  saveSelection();
  const base = currentLineHeight();
  applyLineHeight(base + delta);
}

function updateFormatButtonStates() {
  try {
    document.getElementById('fmtBold').classList.toggle('active', document.queryCommandState('bold'));
    document.getElementById('fmtItalic').classList.toggle('active', document.queryCommandState('italic'));
    document.getElementById('fmtUnderline').classList.toggle('active', document.queryCommandState('underline'));
  } catch (e) {
    // ignore when selection is outside editable
  }
}

// ---------- Wire everything up ----------

document.addEventListener('DOMContentLoaded', () => {
  enhanceBulletLists();
  restoreAll();
  enhanceBulletLists();
  wireAddBulletButtons();

  const pageStyle = loadPageStyle();
  applyPageStyle(pageStyle);
  if (pageStyle.fontFamily) {
    const fontSelect = document.getElementById('fmtFont');
    const match = Array.from(fontSelect.options).find((o) => o.value === pageStyle.fontFamily);
    if (match) fontSelect.value = pageStyle.fontFamily;
  }
  if (pageStyle.fontSize) {
    document.getElementById('fmtSize').value = pageStyle.fontSize;
  }

  // Baseline snapshot so the first revert returns to the loaded state
  pushHistory();

  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-edit-id]');
    if (!el) return;
    if (el.classList.contains('placeholder') && el.textContent.trim().length > 0) {
      el.classList.remove('placeholder');
    }
    persistElement(el);
    pushHistoryDebounced();
  });

  document.addEventListener('click', (e) => {
    const del = e.target.closest('.del-bullet');
    if (!del) return;
    const li = del.closest('li');
    const ul = li ? li.closest('[data-edit-id]') : null;
    if (li) li.remove();
    if (ul) persistElement(ul);
    pushHistory();
  });

  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      redo();
    }
  });

  document.getElementById('downloadBtn').addEventListener('click', () => {
    window.print();
  });

  document.getElementById('fmtBold').addEventListener('mousedown', (e) => {
    e.preventDefault();
    runFormatCommand('bold');
    updateFormatButtonStates();
  });
  document.getElementById('fmtItalic').addEventListener('mousedown', (e) => {
    e.preventDefault();
    runFormatCommand('italic');
    updateFormatButtonStates();
  });
  document.getElementById('fmtUnderline').addEventListener('mousedown', (e) => {
    e.preventDefault();
    runFormatCommand('underline');
    updateFormatButtonStates();
  });

  document.getElementById('fmtFont').addEventListener('mousedown', () => saveSelection());
  document.getElementById('fmtFont').addEventListener('change', (e) => {
    applyFontFamily(e.target.value);
  });

  document.getElementById('fmtSize').addEventListener('mousedown', () => saveSelection());
  document.getElementById('fmtSize').addEventListener('change', (e) => {
    applyFontSize(e.target.value);
  });

  document.getElementById('fmtLineDown').addEventListener('mousedown', (e) => {
    e.preventDefault();
    nudgeLineHeight(-LINE_HEIGHT_STEP);
  });
  document.getElementById('fmtLineUp').addEventListener('mousedown', (e) => {
    e.preventDefault();
    nudgeLineHeight(LINE_HEIGHT_STEP);
  });

  document.getElementById('fmtSelectAll').addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (applyToWholePage) {
      clearWholePageMode();
      window.getSelection().removeAllRanges();
      savedSelection = null;
    } else {
      selectAllResumeText();
    }
  });

  document.addEventListener('selectionchange', () => {
    const current = getResumeSelection();
    if (current) {
      savedSelection = current.range.cloneRange();
      if (!current.collapsed) updateFormatButtonStates();
      const el = getActiveEditable(false);
      const lh = readLineHeightFromElement(el);
      if (lh != null) syncLineHeightDisplay(lh);
    }
  });

  document.getElementById('resume').addEventListener('focusin', (e) => {
    const el = e.target.closest('[contenteditable="true"], [data-edit-id]');
    if (!el) return;
    const lh = readLineHeightFromElement(el);
    if (lh != null) syncLineHeightDisplay(lh);
  });

  document.getElementById('resume').addEventListener('mousedown', () => {
    if (applyToWholePage) clearWholePageMode();
  });

  document.title = 'Iris Chu - Resume';
});

// ---------- Fit to exactly one A4 page when printing ----------

const MM_TO_PX = 96 / 25.4;
const A4_WIDTH_PX = 210 * MM_TO_PX;
const A4_HEIGHT_PX = 296.5 * MM_TO_PX;

function fitToPage() {
  const page = document.getElementById('resume');
  document.body.classList.add('print-fit');
  page.style.zoom = '';
  page.style.height = '';
  page.style.minHeight = '0';

  let lo = 0.5;
  let hi = 2;
  for (let i = 0; i < 25; i++) {
    const z = (lo + hi) / 2;
    page.style.width = `${A4_WIDTH_PX / z}px`;
    if (page.scrollHeight * z > A4_HEIGHT_PX) hi = z;
    else lo = z;
  }

  page.style.width = `${A4_WIDTH_PX / lo}px`;
  page.style.height = `${A4_HEIGHT_PX / lo}px`;
  page.style.zoom = lo;
}

function resetFit() {
  const page = document.getElementById('resume');
  document.body.classList.remove('print-fit');
  ['zoom', 'width', 'height', 'minHeight'].forEach((prop) => { page.style[prop] = ''; });
}

window.addEventListener('beforeprint', () => {
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  fitToPage();
});

window.addEventListener('afterprint', resetFit);
