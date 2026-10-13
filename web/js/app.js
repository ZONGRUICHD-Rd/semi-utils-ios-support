import { ACCEPT, FORMAT_LABELS, WORK_COLOR_SPACE, decodePhoto, isSupportedName } from './decode.js';
import {
  FONT_STACK, LOGO_FILES, STYLES, autoLogo, autoTexts, loadLogo, outputSize, renderStyle, scaleSource,
} from './render.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_EDGE = 1800;
const THUMB_EDGE = 160;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// iOS Safari 单个画布面积上限约 1677 万像素
const MAX_CANVAS_AREA = IS_IOS ? 16_000_000 : 120_000_000;
const TEXT_KEYS = ['model', 'lens', 'params', 'date', 'custom'];
const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: '.jpg' },
  png: { mime: 'image/png', ext: '.png' },
  webp: { mime: 'image/webp', ext: '.webp' },
};

// ---------- 设置（仅本机浏览器记住） ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`semi-utils:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`semi-utils:${key}`, JSON.stringify(value)); } catch { /* 隐私模式等 */ }
  },
};

const settings = {
  style: store.get('style', 'classic'),
  format: store.get('format', 'jpeg'),
  quality: store.get('quality', 92),
  maxEdge: store.get('maxEdge', 0),
  shortLens: store.get('shortLens', true),
  logo: store.get('logo', 'auto'),
};
if (!STYLES.some((s) => s.id === settings.style)) settings.style = 'classic';
if (!FORMATS[settings.format]) settings.format = 'jpeg';

function saveSetting(key, value) {
  settings[key] = value;
  store.set(key, value);
}

// ---------- 状态 ----------

let nextId = 1;
const items = [];
let selectedId = null;
const previewCache = new Map(); // id -> {source,width,height}，最近使用的少量预览图
let lastShareFiles = null;

function selected() {
  return items.find((i) => i.id === selectedId) || null;
}

function texts(item) {
  const auto = autoTexts(item.exif || {}, item.file, { shortLens: settings.shortLens, relPath: item.relPath });
  const out = { ...auto };
  for (const k of TEXT_KEYS) if (item.overrides[k]) out[k] = item.overrides[k];
  return { auto, final: out };
}

function logoName(item) {
  if (settings.logo === 'none') return null;
  if (settings.logo !== 'auto') return settings.logo;
  return autoLogo(item.exif || {});
}

// ---------- 提示 ----------

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- 主题 ----------

function initTheme() {
  const saved = store.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  $('themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
  });
}

// ---------- 添加文件 ----------

function pick(kind) {
  (kind === 'folder' ? $('folderInput') : $('fileInput')).click();
}

function addFiles(entries) {
  const accepted = entries.filter(({ file }) => isSupportedName(file.name) || file.type.startsWith('image/'));
  const skipped = entries.length - accepted.length;
  if (!accepted.length) {
    toast(skipped ? '没有可处理的照片（支持 HEIC、DNG、JPEG、JPEG XL、AVIF、PNG、WebP、TIFF）' : '没有选择照片');
    return;
  }
  accepted.sort((a, b) => (a.relPath || a.file.name).localeCompare(b.relPath || b.file.name, 'zh-CN', { numeric: true }));
  for (const { file, relPath } of accepted) {
    items.push({ id: nextId++, file, relPath: relPath || '', status: 'pending', overrides: {}, exif: null, thumb: null });
  }
  if (skipped) toast(`已跳过 ${skipped} 个不支持的文件`);
  showWorkspace();
  if (!selected()) select(items[items.length - accepted.length].id);
  renderList();
  analyzeQueue();
}

async function collectDropped(dataTransfer) {
  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, relPath: path + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, `${path}${entry.name}/`);
      } while (batch.length);
    }
  };
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const e of entries) await walk(e, '');
  } else {
    for (const file of dataTransfer.files) out.push({ file, relPath: '' });
  }
  return out;
}

function initInputs() {
  $('fileInput').accept = ACCEPT;
  document.querySelectorAll('[data-pick]').forEach((el) => {
    el.addEventListener('click', (e) => { e.stopPropagation(); pick(el.dataset.pick); });
  });
  $('dropzone').addEventListener('click', () => pick('files'));
  $('dropzone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick('files'); }
  });
  for (const id of ['fileInput', 'folderInput']) {
    $(id).addEventListener('change', (e) => {
      addFiles([...e.target.files].map((file) => ({ file, relPath: file.webkitRelativePath || '' })));
      e.target.value = '';
    });
  }

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    $('dropOverlay').hidden = false;
    $('dropzone').classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      $('dropOverlay').hidden = true;
      $('dropzone').classList.remove('dragging');
    }
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('dropOverlay').hidden = true;
    $('dropzone').classList.remove('dragging');
    addFiles(await collectDropped(e.dataTransfer));
  });

  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files.map((file) => ({ file, relPath: '' })));
  });
}

// ---------- 解码与预览 ----------

function fit(w, h, edge) {
  const k = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

function rememberPreview(id, preview) {
  previewCache.delete(id);
  previewCache.set(id, preview);
  while (previewCache.size > 3) {
    const oldest = [...previewCache.keys()].find((k) => k !== selectedId);
    previewCache.delete(oldest);
  }
}

// 解码一张照片，生成缩略图与预览图；同一张照片的并发请求共用一个 Promise
function prepare(item) {
  if (previewCache.has(item.id)) return Promise.resolve(previewCache.get(item.id));
  if (item.preparing) return item.preparing;
  item.status = 'working';
  renderList();
  item.preparing = (async () => {
    try {
      const photo = await decodePhoto(item.file);
      item.exif = photo.exif;
      item.info = { kind: photo.kind, width: photo.width, height: photo.height, via: photo.via };
      const [pw, ph] = fit(photo.width, photo.height, PREVIEW_EDGE);
      const preview = { source: scaleSource(photo.source, photo.width, photo.height, pw, ph), width: pw, height: ph };
      if (!item.thumb) {
        const [tw, th] = fit(pw, ph, THUMB_EDGE);
        item.thumb = scaleSource(preview.source, pw, ph, tw, th).toDataURL('image/jpeg', 0.8);
      }
      if (preview.source !== photo.source) photo.source.close?.();
      item.status = 'ready';
      rememberPreview(item.id, preview);
      return preview;
    } catch (e) {
      console.error(e);
      item.status = 'error';
      item.error = e.message || String(e);
      throw e;
    } finally {
      item.preparing = null;
      renderList();
    }
  })();
  return item.preparing;
}

let analyzing = false;
async function analyzeQueue() {
  if (analyzing) return;
  analyzing = true;
  try {
    let item;
    while ((item = items.find((i) => i.status === 'pending'))) {
      await prepare(item).catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    analyzing = false;
  }
}

let renderToken = 0;
async function renderPreview() {
  const item = selected();
  const wrap = $('canvasWrap');
  const status = $('stageStatus');
  const token = ++renderToken;
  if (!item) {
    wrap.querySelector('canvas')?.remove();
    status.hidden = true;
    $('stageInfo').textContent = '';
    return;
  }
  const hasCanvas = !!wrap.querySelector('canvas');
  status.className = `stage-status${hasCanvas ? ' overlay' : ''}`;
  status.innerHTML = '<span class="spinner"></span><span>正在解码…</span>';
  status.hidden = previewCache.has(item.id);
  let preview;
  try {
    preview = await prepare(item);
  } catch (e) {
    if (token !== renderToken) return;
    wrap.querySelector('canvas')?.remove();
    status.className = 'stage-status error';
    status.textContent = `无法读取 ${item.file.name}：${item.error}`;
    status.hidden = false;
    $('stageInfo').textContent = '';
    return;
  }
  const logo = await loadLogo(logoName(item));
  if (token !== renderToken) return;
  // 首次解码后 EXIF 才可用，刷新输入框中的自动值
  if (!item.fieldsSynced) {
    item.fieldsSynced = true;
    syncFields();
  }
  const canvas = renderStyle(settings.style, preview, texts(item).final, logo);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${item.file.name} 的水印预览`);
  wrap.querySelector('canvas')?.remove();
  wrap.prepend(canvas);
  status.hidden = true;
  updateInfo(item);
}

let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    renderPreview();
  });
}

function updateInfo(item) {
  if (!item?.info) {
    $('stageInfo').textContent = '';
    return;
  }
  const { kind, width, height, via } = item.info;
  const [ow, oh] = exportDims(width, height);
  $('stageInfo').textContent = `${FORMAT_LABELS[kind] || kind} · ${width}×${height} · ${via}  →  导出 ${ow}×${oh}`;
}

// ---------- 列表 ----------

function renderList() {
  const list = $('photoList');
  $('count').textContent = items.length;
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.className = 'photo-item';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(item.id === selectedId));
    li.tabIndex = item.id === selectedId ? 0 : -1;
    li.dataset.id = item.id;

    let thumb;
    if (item.thumb) {
      thumb = document.createElement('img');
      thumb.src = item.thumb;
      thumb.alt = '';
    } else {
      thumb = document.createElement('div');
      thumb.classList.add('thumb-placeholder');
      thumb.textContent = (item.file.name.split('.').pop() || '').toUpperCase().slice(0, 4);
    }
    thumb.classList.add('thumb');

    const meta = document.createElement('div');
    meta.className = 'photo-meta';
    const name = document.createElement('div');
    name.className = 'photo-name';
    name.textContent = item.file.name;
    const sub = document.createElement('div');
    sub.className = `photo-sub${item.status === 'error' ? ' error' : ''}`;
    sub.textContent = item.status === 'error' ? '无法读取'
      : item.info ? [item.exif?.Model, FORMAT_LABELS[item.info.kind]].filter(Boolean).join(' · ')
        : item.status === 'working' ? '解码中…' : '等待中';
    meta.append(name, sub);

    const dot = document.createElement('span');
    dot.className = `dot ${item.status}`;

    const remove = document.createElement('button');
    remove.className = 'remove-btn';
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除 ${item.file.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item.id); });

    li.append(thumb, meta, dot, remove);
    li.addEventListener('click', () => select(item.id));
    return li;
  }));
}

function select(id) {
  selectedId = id;
  renderList();
  syncFields();
  schedulePreview();
  $('photoList').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function removeItem(id) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  items.splice(idx, 1);
  previewCache.delete(id);
  if (!items.length) {
    clearAll();
    return;
  }
  if (selectedId === id) select(items[Math.min(idx, items.length - 1)].id);
  else renderList();
}

function clearAll() {
  items.length = 0;
  previewCache.clear();
  selectedId = null;
  lastShareFiles = null;
  $('shareBtn').hidden = true;
  $('progress').hidden = true;
  $('canvasWrap').querySelector('canvas')?.remove();
  renderList();
  $('workspace').hidden = true;
  $('welcome').hidden = false;
}

function showWorkspace() {
  $('welcome').hidden = true;
  $('workspace').hidden = false;
}

// ---------- 样式与表单 ----------

function renderStyleControls() {
  const gallery = $('gallery');
  gallery.replaceChildren(...STYLES.filter((s) => s.id !== 'plain').map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'style-card';
    b.dataset.style = s.id;
    b.innerHTML = `<img src="assets/styles/${s.id}.webp" alt="" loading="lazy" width="640" height="480"><span></span><small></small>`;
    b.querySelector('span').textContent = s.name;
    b.querySelector('small').textContent = s.desc;
    b.addEventListener('click', () => { setStyle(s.id); pick('files'); });
    return b;
  }));
  const bar = $('styleBar');
  bar.replaceChildren(...STYLES.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'tab');
    b.dataset.style = s.id;
    b.title = s.desc;
    b.textContent = s.name;
    b.addEventListener('click', () => setStyle(s.id));
    return b;
  }));
  syncStyle();
}

function syncStyle() {
  document.querySelectorAll('[data-style]').forEach((el) => {
    const on = el.dataset.style === settings.style;
    el.setAttribute(el.classList.contains('chip') ? 'aria-selected' : 'aria-pressed', String(on));
  });
}

function setStyle(id) {
  saveSetting('style', id);
  syncStyle();
  schedulePreview();
}

function syncFields() {
  const item = selected();
  const t = item ? texts(item).auto : null;
  for (const k of TEXT_KEYS) {
    const input = $(`f-${k}`);
    input.value = item?.overrides[k] || '';
    input.placeholder = t?.[k] && t[k] !== '-' ? t[k] : (k === 'custom' ? '用于「文字 + 日期」样式' : '');
  }
}

function initForm() {
  for (const k of TEXT_KEYS) {
    $(`f-${k}`).addEventListener('input', (e) => {
      const item = selected();
      if (!item) return;
      item.overrides[k] = e.target.value;
      schedulePreview();
    });
  }
  $('resetTexts').addEventListener('click', () => {
    const item = selected();
    if (!item) return;
    item.overrides = {};
    syncFields();
    schedulePreview();
  });
  $('shortLens').checked = settings.shortLens;
  $('shortLens').addEventListener('change', (e) => {
    saveSetting('shortLens', e.target.checked);
    syncFields();
    schedulePreview();
  });

  const logoSelect = $('logoSelect');
  const opt = (value, label) => Object.assign(document.createElement('option'), { value, textContent: label });
  logoSelect.replaceChildren(
    opt('auto', '自动识别品牌'),
    opt('none', '不显示'),
    ...LOGO_FILES.map((f) => opt(f, f.replace(/\.(png|jpg)$/i, '').replace(/_/g, ' '))),
  );
  logoSelect.value = settings.logo;
  logoSelect.addEventListener('change', (e) => { saveSetting('logo', e.target.value); schedulePreview(); });

  const seg = $('formatSeg');
  const syncFormat = () => {
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === settings.format)));
    $('qualityField').hidden = settings.format === 'png';
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    saveSetting('format', b.dataset.value);
    syncFormat();
  });
  syncFormat();

  $('quality').value = settings.quality;
  $('qualityOut').textContent = settings.quality;
  $('quality').addEventListener('input', (e) => {
    saveSetting('quality', Number(e.target.value));
    $('qualityOut').textContent = e.target.value;
  });
  $('maxEdge').value = String(settings.maxEdge);
  $('maxEdge').addEventListener('change', (e) => {
    saveSetting('maxEdge', Number(e.target.value));
    updateInfo(selected());
  });

  $('clearBtn').addEventListener('click', clearAll);
  $('exportOne').addEventListener('click', () => { const i = selected(); if (i) exportItems([i]); });
  $('exportAll').addEventListener('click', () => exportItems(items.filter((i) => i.status !== 'error')));
  $('shareBtn').addEventListener('click', shareLast);

  $('colorNote').textContent = WORK_COLOR_SPACE === 'display-p3'
    ? '以 Display P3 广色域输出，颜色与「照片」App 一致。'
    : '当前浏览器不支持广色域画布，将以 sRGB 输出。';

  document.addEventListener('keydown', (e) => {
    if ($('workspace').hidden || e.target.closest('input, select, textarea')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const idx = items.findIndex((i) => i.id === selectedId);
    const next = items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      select(next.id);
    }
  });
}

// ---------- 导出 ----------

// 导出尺寸：受「最长边」与浏览器画布面积上限约束
function exportScale(w, h) {
  const [ow, oh] = outputSize(settings.style, w, h);
  let k = Math.min(1, Math.sqrt(MAX_CANVAS_AREA / (ow * oh)));
  if (settings.maxEdge) k = Math.min(k, settings.maxEdge / Math.max(ow, oh));
  return k;
}

function exportDims(w, h) {
  const k = exportScale(w, h);
  return outputSize(settings.style, Math.round(w * k), Math.round(h * k));
}

async function renderFull(item) {
  const photo = await decodePhoto(item.file);
  item.exif ??= photo.exif;
  const k = exportScale(photo.width, photo.height);
  const img = k < 1
    ? { source: scaleSource(photo.source, photo.width, photo.height, photo.width * k, photo.height * k),
      width: Math.round(photo.width * k), height: Math.round(photo.height * k) }
    : photo;
  const logo = await loadLogo(logoName(item));
  const canvas = renderStyle(settings.style, img, texts(item).final, logo);
  const { mime, ext } = FORMATS[settings.format];
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('编码失败，图片可能过大'))),
    mime,
    settings.quality / 100,
  ));
  photo.source.close?.();
  canvas.width = canvas.height = 0;
  const stem = item.file.name.replace(/\.[^.]+$/, '');
  return new File([blob], `${stem}${ext}`, { type: mime, lastModified: item.file.lastModified });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

const getJSZip = (() => {
  let p;
  return () => (p ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { p = undefined; reject(new Error('无法加载 ZIP 组件')); };
    document.head.appendChild(s);
  }));
})();

const canShareFiles = (files) => {
  try {
    return !!navigator.canShare?.({ files }) && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

let exporting = false;
async function exportItems(list) {
  if (exporting || !list.length) return;
  exporting = true;
  const buttons = [$('exportOne'), $('exportAll')];
  buttons.forEach((b) => { b.disabled = true; });
  $('shareBtn').hidden = true;
  $('progress').hidden = false;
  const fill = $('progressFill');
  const text = $('progressText');
  const files = [];
  const failed = [];
  try {
    for (const [i, item] of list.entries()) {
      text.textContent = `正在导出 ${i + 1} / ${list.length}：${item.file.name}`;
      fill.style.width = `${(i / list.length) * 100}%`;
      try {
        files.push(await renderFull(item));
      } catch (e) {
        console.error(e);
        failed.push(item.file.name);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    fill.style.width = '100%';
    if (!files.length) {
      text.textContent = '导出失败';
      return;
    }
    lastShareFiles = files;
    if (canShareFiles(files)) {
      text.textContent = `已完成 ${files.length} 张，点击下方按钮存储到相册或分享。`;
      $('shareBtn').hidden = false;
    } else if (files.length === 1) {
      download(files[0], files[0].name);
      text.textContent = `已导出 ${files[0].name}`;
    } else {
      text.textContent = '正在打包 ZIP…';
      const JSZip = await getJSZip();
      const zip = new JSZip();
      const used = new Set();
      for (const f of files) {
        let name = f.name;
        for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]+)$/, `-${n}$1`);
        used.add(name);
        zip.file(name, f, { date: new Date(f.lastModified) });
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      download(blob, `semi-utils-${stamp}.zip`);
      text.textContent = `已导出 ${files.length} 张照片（ZIP）`;
    }
    if (failed.length) toast(`${failed.length} 张导出失败：${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}`, 5000);
  } catch (e) {
    console.error(e);
    text.textContent = `导出失败：${e.message || e}`;
  } finally {
    exporting = false;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

async function shareLast() {
  if (!lastShareFiles) return;
  try {
    await navigator.share({ files: lastShareFiles });
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast('无法分享，已改为下载');
      lastShareFiles.forEach((f) => download(f, f.name));
    }
  }
}

// ---------- 启动 ----------

function init() {
  initTheme();
  initInputs();
  renderStyleControls();
  initForm();
  // 预先加载水印字体，避免首次预览使用后备字体
  Promise.all([document.fonts.load(`300 16px ${FONT_STACK}`), document.fonts.load(`700 16px ${FONT_STACK}`)])
    .then(() => { if (selected()) schedulePreview(); })
    .catch(() => {});
}

init();
