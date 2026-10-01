// ===========================================================
// Multi-resume editor: picker, duplicate, per-resume undo/redo,
// formatting toolbar, PDF fit-to-page
// ===========================================================

const DOCS_KEY = 'irisResumeDocsV3';
const DOCS_KEY_V2 = 'irisResumeDocsV2';
const LEGACY_STORE_KEY = 'irisResumeEditsV1';
const LEGACY_STYLE_KEY = 'irisResumePageStyleV1';
const HISTORY_LIMIT = 80;

const LINE_HEIGHT_DEFAULT = 1.45;
const LINE_HEIGHT_STEP = 0.05;
const LINE_HEIGHT_MIN = 1.0;
const LINE_HEIGHT_MAX = 2.5;

/** @type {DocsState} */
let docsState = null;
/** In-memory undo stacks keyed by document id */
const historyById = {};
let historySuspended = false;
let historyDebounceTimer = null;
let persistTimer = null;
let lineHeightState = LINE_HEIGHT_DEFAULT;
let applyToWholePage = false;
let savedSelection = null;
let defaultResumeHtml = '';
let defaultCoverHtml = '';

/**
 * @typedef {{ id: string, name: string, type: 'resume'|'cover', html: string, pageStyle: object }} Doc
 * @typedef {{
 *   mode: 'resume'|'cover',
 *   activeByMode: { resume: string, cover: string|null },
 *   order: { resume: string[], cover: string[] },
 *   docs: Record<string, Doc>
 * }} DocsState
 */

function uid(prefix = 'd') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/([^\w-])/g, '\\$1');
}

function loadDocsRaw() {
  try {
    return JSON.parse(localStorage.getItem(DOCS_KEY));
  } catch (e) {
    return null;
  }
}

function saveDocs() {
  localStorage.setItem(DOCS_KEY, JSON.stringify(docsState));
}

function getActiveId() {
  return docsState.activeByMode[docsState.mode];
}

function getActiveDoc() {
  const id = getActiveId();
  return id ? docsState.docs[id] : null;
}

function getModeOrder() {
  return docsState.order[docsState.mode] || [];
}

function modeLabel(mode = docsState.mode) {
  return mode === 'cover' ? 'Cover Letter' : 'Resume';
}

function readPageStyleFromDom() {
  const page = document.getElementById('resume');
  const style = {};
  if (page.style.fontFamily) style.fontFamily = page.style.fontFamily;
  const scale = page.style.getPropertyValue('--size-scale').trim();
  if (scale) {
    style.sizeScale = Number(scale);
    style.fontSize = `${Math.round(Number(scale) * 13)}px`;
  }
  const lh = page.style.getPropertyValue('--line-height').trim();
  if (lh) style.lineHeight = Number(lh);
  return style;
}

function applyPageStyle(style) {
  const page = document.getElementById('resume');
  style = style || {};
  if (style.fontFamily) page.style.fontFamily = style.fontFamily;
  else page.style.fontFamily = '';
  if (style.sizeScale) page.style.setProperty('--size-scale', String(style.sizeScale));
  else page.style.removeProperty('--size-scale');
  if (style.lineHeight) page.style.setProperty('--line-height', String(style.lineHeight));
  else page.style.removeProperty('--line-height');
  syncLineHeightDisplay(style.lineHeight || LINE_HEIGHT_DEFAULT);

  const fontSelect = document.getElementById('fmtFont');
  const sizeSelect = document.getElementById('fmtSize');
  if (fontSelect) {
    const match = Array.from(fontSelect.options).find((o) => o.value === style.fontFamily);
    fontSelect.value = match ? style.fontFamily : fontSelect.options[0].value;
  }
  if (sizeSelect) sizeSelect.value = style.fontSize || '';
}

function saveActiveFromDom() {
  if (!docsState || historySuspended) return;
  const doc = getActiveDoc();
  if (!doc) return;
  doc.html = document.getElementById('resume').innerHTML;
  doc.pageStyle = readPageStyleFromDom();
  saveDocs();
}

function schedulePersistActive() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveActiveFromDom, 200);
}

// Kept for call sites that still pass an element
function persistElement() {
  schedulePersistActive();
}

function persistAllEditable() {
  saveActiveFromDom();
}

function loadPageStyle() {
  const doc = getActiveDoc();
  return (doc && doc.pageStyle) ? { ...doc.pageStyle } : {};
}

function savePageStyle(style) {
  const doc = getActiveDoc();
  if (!doc) return;
  doc.pageStyle = style;
  applyPageStyle(style);
  saveDocs();
}

// ---------- History (per active resume) ----------

function getHistory() {
  const id = getActiveId();
  if (!id) return { stack: [], index: -1 };
  if (!historyById[id]) {
    historyById[id] = { stack: [], index: -1 };
  }
  return historyById[id];
}

function captureSnapshot() {
  return {
    html: document.getElementById('resume').innerHTML,
    pageStyle: readPageStyleFromDom(),
  };
}

function updateHistoryButtons() {
  const hist = getHistory();
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (!undoBtn || !redoBtn) return;
  undoBtn.disabled = hist.index <= 0;
  redoBtn.disabled = hist.index < 0 || hist.index >= hist.stack.length - 1;
}

function pushHistory() {
  if (historySuspended) return;
  const snap = captureSnapshot();
  const hist = getHistory();
  hist.stack.splice(hist.index + 1);
  const last = hist.stack[hist.stack.length - 1];
  if (
    last &&
    last.html === snap.html &&
    JSON.stringify(last.pageStyle) === JSON.stringify(snap.pageStyle)
  ) {
    updateHistoryButtons();
    return;
  }
  hist.stack.push(snap);
  if (hist.stack.length > HISTORY_LIMIT) hist.stack.shift();
  hist.index = hist.stack.length - 1;
  saveActiveFromDom();
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
  applyPageStyle(snap.pageStyle || {});
  const doc = getActiveDoc();
  if (doc) {
    doc.html = snap.html;
    doc.pageStyle = snap.pageStyle || {};
    saveDocs();
  }
  enhanceBulletLists();
  wireAddBulletButtons();
  historySuspended = false;
  updateHistoryButtons();
}

function undo() {
  const hist = getHistory();
  if (hist.index <= 0) return;
  clearTimeout(historyDebounceTimer);
  hist.index -= 1;
  applySnapshot(hist.stack[hist.index]);
}

function redo() {
  const hist = getHistory();
  if (hist.index >= hist.stack.length - 1) return;
  clearTimeout(historyDebounceTimer);
  hist.index += 1;
  applySnapshot(hist.stack[hist.index]);
}

function resetHistoryForActive(baseline) {
  const hist = getHistory();
  hist.stack = [baseline || captureSnapshot()];
  hist.index = 0;
  updateHistoryButtons();
}

// ---------- Document picker / mode / add ----------

function getCoverTemplateHtml() {
  const tpl = document.getElementById('tplCover');
  return tpl ? tpl.innerHTML.trim() : '';
}

function updateModeChrome() {
  const isCover = docsState.mode === 'cover';
  const selectPrompt = isCover ? 'Select Cover Letter' : 'Select Resume';
  document.getElementById('modeResume').classList.toggle('active', !isCover);
  document.getElementById('modeCover').classList.toggle('active', isCover);
  document.getElementById('modeResume').setAttribute('aria-selected', String(!isCover));
  document.getElementById('modeCover').setAttribute('aria-selected', String(isCover));
  const select = document.getElementById('docSelect');
  const face = document.getElementById('docSelectFace');
  if (select) {
    select.setAttribute('aria-label', selectPrompt);
    select.title = selectPrompt;
  }
  if (face) face.textContent = selectPrompt;
  document.getElementById('newDocBtn').textContent = isCover ? '＋ Add Cover Letter' : '＋ Add Resume';
  document.getElementById('docName').placeholder = isCover ? 'Untitled cover letter' : 'Untitled resume';
}

function renderDocSelect() {
  const select = document.getElementById('docSelect');
  const nameInput = document.getElementById('docName');
  if (!select) return;
  select.innerHTML = '';

  const selectPrompt = docsState.mode === 'cover' ? 'Select Cover Letter' : 'Select Resume';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = selectPrompt;
  select.appendChild(placeholder);

  getModeOrder().forEach((id) => {
    const doc = docsState.docs[id];
    if (!doc) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = doc.name;
    select.appendChild(opt);
  });

  select.value = '';
  updateModeChrome();

  if (nameInput) {
    const active = getActiveDoc();
    nameInput.disabled = false;
    nameInput.value = active ? active.name : '';
  }
}

function loadDocIntoDom(id) {
  const doc = docsState.docs[id];
  if (!doc) return;
  historySuspended = true;
  docsState.mode = doc.type;
  docsState.activeByMode[doc.type] = id;
  const page = document.getElementById('resume');
  page.innerHTML = doc.html;
  page.dataset.docType = doc.type;
  applyPageStyle(doc.pageStyle || {});
  enhanceBulletLists();
  wireAddBulletButtons();
  historySuspended = false;
  renderDocSelect();
  if (!historyById[id] || !historyById[id].stack.length) {
    resetHistoryForActive(captureSnapshot());
  } else {
    updateHistoryButtons();
  }
  document.title = `${doc.name} — ${modeLabel(doc.type)}`;
}

function switchDoc(id) {
  if (!id || id === getActiveId()) return;
  saveActiveFromDom();
  loadDocIntoDom(id);
  saveDocs();
}

function ensureDocForMode(mode) {
  let id = docsState.activeByMode[mode];
  if (id && docsState.docs[id] && docsState.docs[id].type === mode) return id;

  id = (docsState.order[mode] || []).find((d) => docsState.docs[d]);
  if (id) {
    docsState.activeByMode[mode] = id;
    return id;
  }

  const isCover = mode === 'cover';
  id = uid(isCover ? 'c' : 'r');
  const doc = {
    id,
    name: isCover ? 'Cover Letter 1' : 'Resume 1',
    type: mode,
    html: isCover ? defaultCoverHtml : defaultResumeHtml,
    pageStyle: {},
  };
  docsState.docs[id] = doc;
  if (!docsState.order[mode]) docsState.order[mode] = [];
  docsState.order[mode].push(id);
  docsState.activeByMode[mode] = id;
  historyById[id] = { stack: [], index: -1 };
  return id;
}

function setMode(mode) {
  if (mode !== 'resume' && mode !== 'cover') return;
  if (mode === docsState.mode) return;
  saveActiveFromDom();
  docsState.mode = mode;
  const id = ensureDocForMode(mode);
  loadDocIntoDom(id);
  saveDocs();
}

function renameActiveDoc(name) {
  const doc = getActiveDoc();
  if (!doc) return;
  const fallback = docsState.mode === 'cover' ? 'Untitled cover letter' : 'Untitled resume';
  doc.name = (name || '').trim() || fallback;
  saveDocs();
  renderDocSelect();
  document.title = `${doc.name} — ${modeLabel(doc.type)}`;
}

function addDocument() {
  const isCover = docsState.mode === 'cover';
  const kind = isCover ? 'cover letter' : 'resume';
  const suggested = isCover
    ? `Cover Letter ${(docsState.order.cover.length || 0) + 1}`
    : `Resume ${(docsState.order.resume.length || 0) + 1}`;

  const entered = window.prompt(`Name for the new ${kind}?`, suggested);
  if (entered === null) return; // cancelled

  saveActiveFromDom();

  const src = getActiveDoc();
  const id = uid(isCover ? 'c' : 'r');
  const html = src
    ? src.html
    : (isCover ? defaultCoverHtml : defaultResumeHtml);
  const pageStyle = src
    ? JSON.parse(JSON.stringify(src.pageStyle || {}))
    : {};

  const doc = {
    id,
    name: entered.trim() || suggested,
    type: isCover ? 'cover' : 'resume',
    html,
    pageStyle,
  };

  docsState.docs[id] = doc;
  docsState.order[doc.type].push(id);
  docsState.activeByMode[doc.type] = id;
  historyById[id] = { stack: [], index: -1 };
  saveDocs();
  loadDocIntoDom(id);
  resetHistoryForActive();

  const nameInput = document.getElementById('docName');
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }
}

function migrateFromV2(v2) {
  const orderResume = [];
  const docs = {};
  (v2.order || Object.keys(v2.docs || {})).forEach((id) => {
    const d = v2.docs[id];
    if (!d) return;
    docs[id] = {
      id,
      name: d.name || 'Resume',
      type: 'resume',
      html: d.html,
      pageStyle: d.pageStyle || {},
    };
    orderResume.push(id);
  });
  const active = v2.activeId && docs[v2.activeId] ? v2.activeId : orderResume[0];
  return {
    mode: 'resume',
    activeByMode: { resume: active, cover: null },
    order: { resume: orderResume, cover: [] },
    docs,
  };
}

function initDocsState() {
  defaultResumeHtml = document.getElementById('resume').innerHTML;
  defaultCoverHtml = getCoverTemplateHtml();

  let data = loadDocsRaw();
  if (!data) {
    try {
      const v2 = JSON.parse(localStorage.getItem(DOCS_KEY_V2) || 'null');
      if (v2 && v2.docs) data = migrateFromV2(v2);
    } catch (e) { /* ignore */ }
  }

  if (!data || !data.docs || !Object.keys(data.docs).length) {
    try {
      const legacyStore = JSON.parse(localStorage.getItem(LEGACY_STORE_KEY) || '{}');
      Object.keys(legacyStore).forEach((editId) => {
        const el = document.querySelector(`[data-edit-id="${cssEscape(editId)}"]`);
        if (!el) return;
        const match = legacyStore[editId].match(/^(<[^>]+>)([\s\S]*)<\/[\w-]+>\s*$/);
        if (!match) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = match[1];
        const restored = wrapper.firstElementChild;
        if (!restored) return;
        restored.innerHTML = match[2];
        el.replaceWith(restored);
      });
    } catch (e) { /* ignore */ }

    let legacyStyle = {};
    try {
      legacyStyle = JSON.parse(localStorage.getItem(LEGACY_STYLE_KEY) || '{}');
    } catch (e) { /* ignore */ }

    const id = uid('r');
    data = {
      mode: 'resume',
      activeByMode: { resume: id, cover: null },
      order: { resume: [id], cover: [] },
      docs: {
        [id]: {
          id,
          name: 'Resume 1',
          type: 'resume',
          html: document.getElementById('resume').innerHTML,
          pageStyle: legacyStyle,
        },
      },
    };
    localStorage.setItem(DOCS_KEY, JSON.stringify(data));
  }

  // Normalize shape for older/partial saves
  if (!data.order || Array.isArray(data.order)) {
    data = migrateFromV2(data);
  }
  if (!data.activeByMode) {
    data.activeByMode = { resume: null, cover: null };
  }
  if (!data.mode) data.mode = 'resume';
  Object.values(data.docs).forEach((d) => {
    if (!d.type) d.type = 'resume';
  });

  docsState = data;
  if (!docsState.activeByMode.resume && docsState.order.resume[0]) {
    docsState.activeByMode.resume = docsState.order.resume[0];
  }
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
  if (el.firstChild) range.setStart(el.firstChild, 0);
  else range.selectNodeContents(el);
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
      persistElement();
      placeCaretAtStart(li);
      pushHistory();
    });
  });
}

// ---------- Formatting toolbar ----------

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

function getEditableRoot(el) {
  if (!el) return null;
  const editable = el.closest('#resume [contenteditable="true"]');
  if (editable) {
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
    if (child.style && child.style.lineHeight) child.style.lineHeight = '';
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
  persistAllEditable();
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

  const el = getActiveEditable(true);
  if (el) {
    clearDescendantLineHeights(el);
    el.style.lineHeight = String(rounded);
    persistEditableRoot(el);
    syncLineHeightDisplay(rounded);
    pushHistory();
    return;
  }

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
  applyLineHeight(currentLineHeight() + delta);
}

function updateFormatButtonStates() {
  try {
    document.getElementById('fmtBold').classList.toggle('active', document.queryCommandState('bold'));
    document.getElementById('fmtItalic').classList.toggle('active', document.queryCommandState('italic'));
    document.getElementById('fmtUnderline').classList.toggle('active', document.queryCommandState('underline'));
  } catch (e) { /* ignore */ }
}

// ---------- Wire everything up ----------

document.addEventListener('DOMContentLoaded', () => {
  enhanceBulletLists();
  initDocsState();

  const startId = getActiveId() || (docsState.order.resume && docsState.order.resume[0]);
  if (startId) {
    loadDocIntoDom(startId);
  } else {
    renderDocSelect();
  }
  if (getActiveId() && (!historyById[getActiveId()] || historyById[getActiveId()].index < 0)) {
    resetHistoryForActive();
  }

  document.getElementById('modeResume').addEventListener('click', () => setMode('resume'));
  document.getElementById('modeCover').addEventListener('click', () => setMode('cover'));

  document.getElementById('docSelect').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) switchDoc(id);
  });

  const nameInput = document.getElementById('docName');
  nameInput.addEventListener('change', () => renameActiveDoc(nameInput.value));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    }
  });

  document.getElementById('newDocBtn').addEventListener('click', addDocument);

  document.addEventListener('input', (e) => {
    if (!e.target.closest || !e.target.closest('#resume')) return;
    const el = e.target.closest('[data-edit-id], [contenteditable="true"]');
    if (!el) return;
    if (el.classList.contains('placeholder') && el.textContent.trim().length > 0) {
      el.classList.remove('placeholder');
    }
    schedulePersistActive();
    pushHistoryDebounced();
  });

  document.addEventListener('click', (e) => {
    const del = e.target.closest('.del-bullet');
    if (!del) return;
    const li = del.closest('li');
    if (li) li.remove();
    persistAllEditable();
    pushHistory();
  });

  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.target && e.target.id === 'docName') return;
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
