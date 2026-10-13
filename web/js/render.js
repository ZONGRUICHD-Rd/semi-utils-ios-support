// 水印样式：对应桌面版 config/templates 中的模板
import { makeCanvas } from './decode.js';

export const FONT_STACK = '"PuHuiTi", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';

export const STYLES = [
  { id: 'classic', name: '经典白底', desc: '型号、镜头、参数、日期与品牌 Logo' },
  { id: 'card', name: '圆角卡片', desc: '圆角、阴影与留白，适合社交媒体' },
  { id: 'blur', name: '背景模糊', desc: '模糊背景，型号与参数居中' },
  { id: 'corner', name: '右下角参数', desc: '极简，不改变画幅' },
  { id: 'stamp', name: '文字 + 日期', desc: '橙色时间戳，可自定义文字' },
  { id: 'logo', name: '居中 Logo', desc: '白边相框与居中品牌 Logo' },
  { id: 'plain', name: '仅转换格式', desc: '不加水印，只转换格式' },
];

// ---------- 文字 ----------

const pad = (n) => String(n).padStart(2, '0');

export function formatDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shutter(t) {
  if (!t) return '';
  return t >= 1 ? `${Number(t.toFixed(1))}` : `1/${Math.round(1 / t)}`;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

export function formatParams(exif) {
  const fl35 = first(exif.FocalLengthIn35mmFormat);
  const fl = fl35 || (exif.FocalLength ? Math.round(first(exif.FocalLength)) : null);
  const f = first(exif.FNumber);
  const t = first(exif.ExposureTime);
  const iso = first(exif.ISO ?? exif.PhotographicSensitivity);
  return [
    fl && `${fl}mm`,
    f && `f/${Number(f).toFixed(1)}`,
    t && `${shutter(t)}s`,
    iso && `ISO${iso}`,
  ].filter(Boolean).join(' ');
}

// iPhone 镜头名去掉重复的机型前缀：「iPhone 18 Pro back triple camera 6.765mm f/1.78」→「Back Triple Camera 6.765mm f/1.78」
export function shortenLens(lens, model, make) {
  if (!lens || !/apple/i.test(make || '')) return lens;
  let s = lens;
  if (model && s.toLowerCase().startsWith(model.toLowerCase())) s = s.slice(model.length).trim();
  return s.split(' ').map((w) => (/^[a-z]+$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export function autoTexts(exif, file, { shortLens = true, relPath = '' } = {}) {
  const model = String(exif.Model || '').replace(/_/g, '').trim();
  const lensRaw = String(exif.LensModel || '').trim();
  const date = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || new Date(file.lastModified);
  const folder = (relPath || file.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '';
  return {
    model: model || '-',
    lens: (shortLens ? shortenLens(lensRaw, model, exif.Make) : lensRaw) || '-',
    params: formatParams(exif) || '-',
    date: formatDate(date) || '-',
    custom: folder || model || '',
  };
}

// ---------- Logo ----------

const LOGO_RULES = [
  [/apple|iphone/i, 'apple.png'], [/pentax/i, 'pentax.png'], [/ricoh/i, 'ricoh.png'], [/canon/i, 'canon.png'],
  [/nikon/i, 'nikon.png'], [/sony/i, 'sony.png'], [/fuji/i, 'fujifilm.png'], [/hasselblad/i, 'hasselblad.png'],
  [/leica/i, 'leica_logo.png'], [/olympus|om digital/i, 'olympus_blue_gold.png'], [/panasonic|lumix/i, 'panasonic.png'],
  [/dji/i, 'DJI.jpg'], [/huawei|xmage/i, 'xmage.png'],
];

export const LOGO_FILES = [
  'apple.png', 'canon.png', 'DJI.jpg', 'fujifilm.png', 'hasselblad.png', 'leica_logo.png', 'nikon.png',
  'olympus_blue_gold.png', 'olympus_white_gold.png', 'panasonic.png', 'panasonic2.png', 'pentax.png', 'ricoh.png',
  'sony.png', 'sony_dark.png', 'xmage.png',
];

export function autoLogo(exif) {
  const brand = `${exif.Make || ''} ${exif.Model || ''}`;
  return LOGO_RULES.find(([re]) => re.test(brand))?.[1] || null;
}

const logoCache = new Map();
export function loadLogo(name) {
  if (!name) return Promise.resolve(null);
  if (!logoCache.has(name)) {
    logoCache.set(name, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `assets/logos/${name}`;
    }));
  }
  return logoCache.get(name);
}

// ---------- 绘制工具 ----------

function setFont(ctx, weight, px) {
  ctx.font = `${weight} ${Math.max(1, px)}px ${FONT_STACK}`;
}

function capHeight(ctx) {
  const m = ctx.measureText('H');
  return m.actualBoundingBoxAscent || parseFloat(ctx.font) * 0.7;
}

// 以大写字母高度垂直居中绘制
function drawTextCentered(ctx, text, x, cy) {
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, cy + capHeight(ctx) / 2);
}

// 文字超出宽度时先等比缩小（不小于 minScale），仍放不下则截断
function fitLines(ctx, lines, maxW, minScale = 0.6) {
  const widths = lines.map((l) => { setFont(ctx, l.weight, l.px); return ctx.measureText(l.text).width; });
  const k = Math.min(1, Math.max(minScale, maxW / Math.max(1, ...widths)));
  return lines.map((l) => {
    const px = l.px * k;
    setFont(ctx, l.weight, px);
    let { text } = l;
    if (ctx.measureText(text).width > maxW) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > maxW) text = text.slice(0, -1);
      text = `${text}…`;
    }
    return { ...l, px, text, width: ctx.measureText(text).width };
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function drawRoundedPhoto(ctx, src, x, y, w, h, radius, shadowBlur, shadowAlpha = 0.45) {
  if (shadowBlur > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${shadowAlpha})`;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowBlur * 0.25;
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(src, x, y, w, h);
  ctx.restore();
}

// 逐级减半缩放，避免一次性大比例缩小产生锯齿
export function scaleSource(src, sw, sh, tw, th) {
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));
  if (tw === sw && th === sh) return src;
  let cur = src;
  let cw = sw;
  let ch = sh;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const [c, x] = makeCanvas(Math.round(cw / 2), Math.round(ch / 2));
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
    cw = c.width;
    ch = c.height;
  }
  const [c, x] = makeCanvas(tw, th);
  x.drawImage(cur, 0, 0, tw, th);
  return c;
}

const supportsCanvasFilter = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.filter = 'blur(2px)';
    return ctx.filter === 'blur(2px)';
  } catch {
    return false;
  }
})();

// 模糊背景：缩小到极小尺寸再放大，所有浏览器都可用且速度快
function drawBlurCover(ctx, src, sw, sh, W, H, radius) {
  const k = Math.max(2, radius / 2.5);
  const tw = Math.max(8, Math.round(W / k));
  const th = Math.max(8, Math.round(H / k));
  const cover = Math.max(tw / sw, th / sh);
  const small = scaleSource(src, sw, sh, sw * cover, sh * cover);
  const [tiny, tctx] = makeCanvas(tw, th);
  tctx.drawImage(small, (tw - small.width) / 2, (th - small.height) / 2);
  const [mid, mctx] = makeCanvas(tw * 4, th * 4);
  if (supportsCanvasFilter) mctx.filter = 'blur(6px)';
  mctx.drawImage(tiny, -2, -2, mid.width + 4, mid.height + 4);
  ctx.drawImage(mid, 0, 0, W, H);
}

// 底部信息栏：左侧型号 / 镜头，右侧 Logo | 参数 / 日期
function drawInfoBar(ctx, bar, t, logo, { divider }) {
  const fs = bar.h * 0.2;
  const gap = fs * 0.55;
  const blockH = fs * 2 + gap;
  const cy = bar.y + bar.h / 2;
  const y1 = cy - (fs + gap) / 2;
  const y2 = cy + (fs + gap) / 2;

  const right = fitLines(ctx, [
    { text: t.params, weight: 700, px: fs, color: '#242424', y: y1 },
    { text: t.date, weight: 300, px: fs, color: '#242424', y: y2 },
  ], bar.w * 0.45);
  const rw = Math.max(...right.map((l) => l.width));
  const rx = bar.x + bar.w - bar.side - rw;
  let leftLimit = rx - bar.side;

  if (divider) {
    const dw = Math.max(1, Math.round(bar.canvasW * 0.003));
    const dx = rx - bar.side - dw;
    ctx.fillStyle = divider;
    ctx.fillRect(dx, cy - blockH * 0.55, dw, blockH * 1.1);
    leftLimit = dx - bar.side;
  }
  if (logo) {
    const lh = blockH * 1.05;
    const lw = Math.min(lh * (logo.naturalWidth / logo.naturalHeight), lh * 3.2);
    const lx = leftLimit - lw;
    ctx.drawImage(logo, lx, cy - lh / 2, lw, lh);
    leftLimit = lx - bar.side;
  }

  const lx = bar.x + bar.side;
  const left = fitLines(ctx, [
    { text: t.model, weight: 700, px: fs, color: '#000', y: y1 },
    { text: t.lens, weight: 300, px: fs, color: '#242424', y: y2 },
  ], Math.max(fs * 2, leftLimit - lx));

  ctx.textAlign = 'left';
  for (const l of [...left.map((l) => ({ ...l, x: lx })), ...right.map((l) => ({ ...l, x: rx }))]) {
    setFont(ctx, l.weight, l.px);
    ctx.fillStyle = l.color;
    drawTextCentered(ctx, l.text, l.x, l.y);
  }
}

// ---------- 样式 ----------

/** 各样式输出尺寸（用于导出前计算缩放） */
export function outputSize(styleId, W, H) {
  const u = Math.min(W, H) / 100;
  switch (styleId) {
    case 'classic': return [W, H + Math.round(H * 0.12)];
    case 'card': {
      const m = Math.round(u * 2.5);
      return [W + 2 * m, m + H + Math.round(H * 0.12) + Math.round(u * 2)];
    }
    case 'blur': return [Math.round(W * 1.35), Math.round(H * 1.35)];
    case 'logo': {
      const m = Math.round(u * 2);
      return [W + 2 * m, m + H + Math.round(H * 0.1)];
    }
    default: return [W, H];
  }
}

/**
 * 绘制带水印的图片
 * @param {string} styleId
 * @param {{source: CanvasImageSource, width: number, height: number}} img
 * @param {{model,lens,params,date,custom}} t 文字
 * @param {HTMLImageElement|null} logo
 */
export function renderStyle(styleId, img, t, logo) {
  const { source: src, width: W, height: H } = img;
  const u = Math.min(W, H) / 100;
  const [Wc, Hc] = outputSize(styleId, W, H);
  const [canvas, ctx] = makeCanvas(Wc, Hc);

  switch (styleId) {
    case 'classic': {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, Wc, Hc);
      ctx.drawImage(src, 0, 0, W, H);
      drawInfoBar(ctx, { x: 0, y: H, w: W, h: Hc - H, side: Wc * 0.02, canvasW: Wc }, t, logo, { divider: '#D8D8D6' });
      break;
    }
    case 'card': {
      const m = Math.round(u * 2.5);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, Wc, Hc);
      drawRoundedPhoto(ctx, src, m, m, W, H, u, u * 2.2, 0.35);
      const footer = Math.round(H * 0.12);
      drawInfoBar(ctx, { x: m, y: m + H, w: W, h: footer, side: Wc * 0.02, canvasW: Wc }, t, logo, { divider: null });
      break;
    }
    case 'blur': {
      drawBlurCover(ctx, src, W, H, Wc, Hc, u * 3);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, 0, Wc, Hc);
      const px = (Wc - W) / 2;
      const py = (Hc - H) / 2 - u * 3;
      drawRoundedPhoto(ctx, src, px, py, W, H, u * 2, u * 3);
      // 竖幅照片下方空间更大，文字按长宽几何平均缩放，避免过小
      const ut = Math.sqrt(W * H) / 100;
      const [l1, l2] = fitLines(ctx, [
        { text: t.model, weight: 700, px: ut * 3.4 },
        { text: t.params, weight: 300, px: ut * 2.7 },
      ], Wc * 0.9);
      const top = py + H;
      const cy = top + (Hc - top) / 2;
      const gap = ut * 1.6;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      setFont(ctx, l1.weight, l1.px);
      drawTextCentered(ctx, l1.text, Wc / 2, cy - (l1.px * 0.35 + gap / 2));
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      setFont(ctx, l2.weight, l2.px);
      drawTextCentered(ctx, l2.text, Wc / 2, cy + (l2.px * 0.35 + gap / 2));
      break;
    }
    case 'corner': {
      ctx.drawImage(src, 0, 0, W, H);
      const [l] = fitLines(ctx, [{ text: t.params, weight: 700, px: u * 3.4 }], W * 0.8);
      setFont(ctx, l.weight, l.px);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = u * 0.8;
      ctx.fillStyle = '#fff';
      ctx.fillText(l.text, W - u * 5, H - u * 5);
      break;
    }
    case 'stamp': {
      ctx.drawImage(src, 0, 0, W, H);
      const text = [t.custom, t.date].filter((s) => s && s !== '-').join('    ');
      const [l] = fitLines(ctx, [{ text, weight: 300, px: u * 2.8 }], W * 0.85);
      setFont(ctx, l.weight, l.px);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgb(232,141,52)';
      ctx.fillText(l.text, W * 0.93, Math.min(H * 0.95 + l.px * 0.8, H - u));
      break;
    }
    case 'logo': {
      const m = Math.round(u * 2);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, Wc, Hc);
      ctx.drawImage(src, m, m, W, H);
      const top = m + H;
      const cy = top + (Hc - top) / 2;
      if (logo) {
        const lh = Math.max(u * 2.6, (Hc - top) * 0.3);
        const lw = Math.min(lh * (logo.naturalWidth / logo.naturalHeight), W * 0.5);
        ctx.drawImage(logo, (Wc - lw) / 2, cy - lh / 2, lw, lh);
      } else {
        const [l] = fitLines(ctx, [{ text: t.model, weight: 700, px: u * 2.6 }], W * 0.8);
        setFont(ctx, l.weight, l.px);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#141413';
        drawTextCentered(ctx, l.text, Wc / 2, cy);
      }
      break;
    }
    default:
      ctx.drawImage(src, 0, 0, W, H);
  }
  return canvas;
}
