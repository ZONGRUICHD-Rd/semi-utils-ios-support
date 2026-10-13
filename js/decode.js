// 照片解码：在浏览器中读取 iPhone 拍摄 / 导出的全部格式
// HEIC/HEIF/HIF、JPEG、ProRAW DNG（JPEG 或 JPEG-XL 压缩）、PNG、JPEG XL、AVIF、WebP、TIFF

const CDN = {
  libheif: 'https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.mjs',
  jxl: 'https://cdn.jsdelivr.net/npm/@jsquash/jxl@1.3.0/decode.js',
  exifr: 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs',
  pako: 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js',
  utif: 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js',
};

// ---------- 通用工具 ----------

const once = (fn) => { let p; return () => (p ??= fn().catch((e) => { p = undefined; throw e; })); };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error(`无法加载 ${src}`));
    document.head.appendChild(s);
  });
}

const getExifr = once(async () => (await import(CDN.exifr)).default);
const getLibheif = once(async () => {
  const factory = (await import(CDN.libheif)).default;
  const lib = factory();
  return lib.then ? await lib : lib;
});
const getJxl = once(async () => (await import(CDN.jxl)).default);
const getUtif = once(async () => {
  await loadScript(CDN.pako);
  await loadScript(CDN.utif);
  return self.UTIF;
});

const ascii = (u8, off, len) => String.fromCharCode(...u8.subarray(off, off + len));

// 工作画布色彩空间：支持时使用 Display P3，保留 iPhone 照片的广色域
export const WORK_COLOR_SPACE = (() => {
  try {
    const ctx = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    return ctx?.getContextAttributes?.().colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
  } catch {
    return 'srgb';
  }
})();

export function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d', { colorSpace: WORK_COLOR_SPACE });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [canvas, ctx];
}

// ---------- 格式识别 ----------

const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2', 'miaf'];

export function sniff(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'jpeg';
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG') return 'png';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return 'webp';
  if (ascii(u8, 0, 3) === 'GIF') return 'gif';
  if (u8[0] === 0x42 && u8[1] === 0x4d) return 'bmp';
  if ((u8[0] === 0xff && u8[1] === 0x0a) || ascii(u8, 4, 4) === 'JXL ') return 'jxl';
  if (ascii(u8, 4, 4) === 'ftyp') {
    const size = new DataView(u8.buffer, u8.byteOffset).getUint32(0);
    const brands = [ascii(u8, 8, 4)];
    for (let o = 16; o + 4 <= Math.min(size, 256); o += 4) brands.push(ascii(u8, o, 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (brands.some((b) => HEIF_BRANDS.includes(b))) return 'heif';
  }
  if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2a) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[3] === 0x2a)) {
    return 'tiff';
  }
  return null;
}

// ---------- TIFF / DNG 结构解析 ----------

const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };

function parseTiff(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = u8[0] === 0x49;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const readValues = (type, count, off) => {
    const out = [];
    for (let i = 0; i < count && i < 4096; i++) {
      if (type === 3) out.push(u16(off + i * 2));
      else if (type === 4 || type === 13) out.push(u32(off + i * 4));
      else out.push(u8[off + i]);
    }
    return out;
  };
  const ifds = [];
  const seen = new Set();
  const queue = [{ off: u32(4), chain: true }];
  while (queue.length && ifds.length < 64) {
    const { off, chain } = queue.shift();
    if (!off || seen.has(off) || off + 2 > u8.length) continue;
    seen.add(off);
    const n = u16(off);
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > u8.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TIFF_TYPE_SIZE[type] || 1) * count;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      if (valOff + Math.min(size, 4096 * 4) > u8.length) continue;
      tags[tag] = readValues(type, count, valOff);
    }
    ifds.push(tags);
    for (const sub of tags[330] || []) queue.push({ off: sub, chain: false }); // SubIFDs
    if (chain) {
      const next = u32(off + 2 + n * 12);
      if (next) queue.push({ off: next, chain: true });
    }
  }
  return ifds;
}

const COMPRESSION_JPEG = [6, 7];
const COMPRESSION_JXL = 52546;
const PHOTOMETRIC_PREVIEW = [2, 6]; // RGB / YCbCr，排除 CFA、Linear Raw、语义蒙版、深度图

// ProRAW 内嵌预览图（苹果官方渲染效果，与「照片」App 中观感一致）
function findDngPreview(u8) {
  const ifds = parseTiff(u8);
  const ifd0 = ifds[0] || {};
  const candidates = [];
  for (const t of ifds) {
    const w = t[256]?.[0] || 0;
    const h = t[257]?.[0] || 0;
    const compression = t[259]?.[0];
    const photometric = t[262]?.[0];
    let off;
    let len;
    if (t[513] && t[514]) {
      [off, len] = [t[513][0], t[514][0]];
    } else if (t[273]?.length === 1 && t[279]?.length === 1) {
      [off, len] = [t[273][0], t[279][0]];
    } else if (t[324]?.length === 1 && t[325]?.length === 1) {
      [off, len] = [t[324][0], t[325][0]];
    } else {
      continue;
    }
    if (!len || off + len > u8.length) continue;
    const isJpeg = COMPRESSION_JPEG.includes(compression) && u8[off] === 0xff && u8[off + 1] === 0xd8;
    const isJxl = compression === COMPRESSION_JXL;
    if (!isJpeg && !isJxl) continue;
    if (photometric !== undefined && !PHOTOMETRIC_PREVIEW.includes(photometric)) continue;
    candidates.push({ bytes: u8.subarray(off, off + len), kind: isJpeg ? 'jpeg' : 'jxl', w, h });
  }
  candidates.sort((a, b) => b.w * b.h - a.w * a.h || b.bytes.length - a.bytes.length);
  return {
    preview: candidates[0] || null,
    isDng: !!ifd0[50706],
    orientation: ifd0[274]?.[0] || 1,
    rawSize: ifds.reduce((m, t) => Math.max(m, (t[256]?.[0] || 0) * (t[257]?.[0] || 0)), 0),
  };
}

// ---------- 容器内 EXIF / 色彩信息 ----------

function* boxes(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = ascii(u8, o + 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}

function tiffFrom(u8, from, to) {
  for (let i = from; i < Math.min(to, from + 32) - 4; i++) {
    if ((u8[i] === 0x49 && u8[i + 1] === 0x49 && u8[i + 2] === 0x2a) ||
        (u8[i] === 0x4d && u8[i + 1] === 0x4d && u8[i + 3] === 0x2a)) {
      return u8.subarray(i, to);
    }
  }
  return null;
}

function isP3Icc(icc) {
  const text = new TextDecoder('latin1').decode(icc.subarray(0, Math.min(icc.length, 4096)));
  return text.includes('Display P3') || text.includes('D\0i\0s\0p\0l\0a\0y\0 \0P\x003');
}

// HEIF / AVIF：从 meta 盒中取出 Exif 项与 colr 色彩信息
function parseHeifMeta(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const meta = [...boxes(u8, 0, u8.length)].find((b) => b.type === 'meta');
  const result = { exif: null, p3: false };
  if (!meta) return result;
  const children = [...boxes(u8, meta.start + 4, meta.end)];
  let exifId = null;
  const iinf = children.find((b) => b.type === 'iinf');
  if (iinf) {
    const v = u8[iinf.start];
    const first = iinf.start + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxes(u8, first, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const iv = u8[infe.start];
      if (iv < 2) continue;
      const id = iv === 2 ? dv.getUint16(infe.start + 4) : dv.getUint32(infe.start + 4);
      const typeOff = infe.start + 4 + (iv === 2 ? 2 : 4) + 2;
      if (ascii(u8, typeOff, 4) === 'Exif') exifId = id;
    }
  }
  const iloc = children.find((b) => b.type === 'iloc');
  if (iloc && exifId !== null) {
    const v = u8[iloc.start];
    let o = iloc.start + 4;
    const offsetSize = u8[o] >> 4;
    const lengthSize = u8[o] & 15;
    const baseSize = u8[o + 1] >> 4;
    const indexSize = v === 1 || v === 2 ? u8[o + 1] & 15 : 0;
    o += 2;
    const readN = (n) => {
      let val = 0;
      for (let i = 0; i < n; i++) val = val * 256 + u8[o + i];
      o += n;
      return val;
    };
    const count = v < 2 ? readN(2) : readN(4);
    for (let i = 0; i < count && o < iloc.end; i++) {
      const id = v < 2 ? readN(2) : readN(4);
      if (v === 1 || v === 2) readN(2);
      readN(2);
      const base = readN(baseSize);
      const extents = readN(2);
      let first = null;
      for (let e = 0; e < extents; e++) {
        if (indexSize) readN(indexSize);
        const off = readN(offsetSize);
        const len = readN(lengthSize);
        first ??= { off: base + off, len };
      }
      if (id === exifId && first && first.off + first.len <= u8.length) {
        const skip = dv.getUint32(first.off);
        result.exif = tiffFrom(u8, first.off + 4 + Math.min(skip, 64), first.off + first.len)
          || tiffFrom(u8, first.off + 4, first.off + first.len);
      }
    }
  }
  const iprp = children.find((b) => b.type === 'iprp');
  if (iprp) {
    for (const ipco of boxes(u8, iprp.start, iprp.end)) {
      if (ipco.type !== 'ipco') continue;
      for (const prop of boxes(u8, ipco.start, ipco.end)) {
        if (prop.type !== 'colr') continue;
        const kind = ascii(u8, prop.start, 4);
        if ((kind === 'prof' || kind === 'rICC') && isP3Icc(u8.subarray(prop.start + 4, prop.end))) result.p3 = true;
        if (kind === 'nclx' && dv.getUint16(prop.start + 4) === 12) result.p3 = true;
      }
    }
  }
  return result;
}

function jxlExif(u8) {
  if (ascii(u8, 4, 4) !== 'JXL ') return null;
  for (const b of boxes(u8, 0, u8.length)) {
    // 规范要求前 4 字节为 TIFF 头偏移，但部分编码器直接写入 TIFF 数据，统一按特征查找
    if (b.type === 'Exif') return tiffFrom(u8, b.start, b.end);
  }
  return null;
}

function webpExif(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 12; o + 8 <= u8.length;) {
    const type = ascii(u8, o, 4);
    const size = dv.getUint32(o + 4, true);
    if (type === 'EXIF') return tiffFrom(u8, o + 8, o + 8 + size);
    o += 8 + size + (size & 1);
  }
  return null;
}

const EXIFR_OPTIONS = {
  tiff: true, exif: true, gps: false, interop: false, ifd1: false, xmp: false, icc: false, iptc: false,
  jfif: false, ihdr: false, makerNote: false, userComment: false, translateValues: false, reviveValues: true,
  mergeOutput: true,
};

async function readExif(u8, kind, heifMeta) {
  let source = u8;
  if (kind === 'heif' || kind === 'avif') source = heifMeta?.exif;
  else if (kind === 'jxl') source = jxlExif(u8);
  else if (kind === 'webp') source = webpExif(u8);
  if (!source) return {};
  try {
    const exifr = await getExifr();
    return (await exifr.parse(source, EXIFR_OPTIONS)) || {};
  } catch (e) {
    console.warn('EXIF 解析失败', e);
    return {};
  }
}

// ---------- 方向 ----------

export function orientCanvas(src, w, h, orientation) {
  if (!orientation || orientation === 1) return null;
  const swap = orientation >= 5;
  const [canvas, ctx] = makeCanvas(swap ? h : w, swap ? w : h);
  const m = {
    2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h], 5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  }[orientation];
  if (!m) return null;
  ctx.setTransform(...m);
  ctx.drawImage(src, 0, 0);
  return canvas;
}

// 不同浏览器是否会按 EXIF 方向旋转 WebP / PNG，运行时实测（3x2 像素，Orientation=6）
const ORIENT_PROBES = {
  webp: 'UklGRlAAAABXRUJQVlA4WAoAAAAIAAAAAgAAAQAAVlA4TA8AAAAvAkAAAAcQ/Y/+ByKi/wEARVhJRhoAAABNTQAqAAAACAABARIAAwAAAAEABgAAAAAAAA==',
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAGmVYSWZNTQAqAAAACAABARIAAwAAAAEABgAAAAAAANZnS2kAAAAQSURBVHicY/zPAAVMMAYDABMpAQPw2AeEAAAAAElFTkSuQmCC',
};
const browserAppliesOrientation = {};
async function appliesOrientation(kind) {
  if (kind === 'jpeg') return true;
  if (!(kind in ORIENT_PROBES)) return true;
  if (!(kind in browserAppliesOrientation)) {
    try {
      const bytes = Uint8Array.from(atob(ORIENT_PROBES[kind]), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes]));
      browserAppliesOrientation[kind] = bmp.width === 2;
      bmp.close?.();
    } catch {
      browserAppliesOrientation[kind] = true;
    }
  }
  return browserAppliesOrientation[kind];
}

// ---------- 各格式解码 ----------

async function decodeNative(bytes, type) {
  return createImageBitmap(new Blob([bytes], type ? { type } : undefined), { imageOrientation: 'from-image' });
}

function imageDataToCanvas(data, w, h, colorSpace) {
  const [canvas, ctx] = makeCanvas(w, h);
  let img;
  try {
    img = new ImageData(data, w, h, { colorSpace });
  } catch {
    img = new ImageData(data, w, h);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function decodeHeif(u8, p3) {
  try {
    return { source: await decodeNative(u8, 'image/heic'), via: '浏览器原生' };
  } catch { /* Chrome / Firefox 不支持 HEIC，使用 libheif */ }
  const libheif = await getLibheif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(u8);
  if (!images?.length) throw new Error('HEIF 中没有可解码的图像');
  // 空间照片 / 连拍等包含多张顶层图像时取主图（部分 libheif-js 版本的 is_primary 不可用）
  const isPrimary = (i) => { try { return i.is_primary(); } catch { return false; } };
  const image = images.find(isPrimary) || images[0];
  const w = image.get_width();
  const h = image.get_height();
  const colorSpace = p3 && WORK_COLOR_SPACE === 'display-p3' ? 'display-p3' : 'srgb';
  let data;
  try {
    data = new ImageData(w, h, { colorSpace });
  } catch {
    data = new ImageData(w, h);
  }
  await new Promise((resolve, reject) => image.display(data, (d) => (d ? resolve() : reject(new Error('HEIF 解码失败')))));
  images.forEach((i) => i.free?.());
  const [canvas, ctx] = makeCanvas(w, h);
  ctx.putImageData(data, 0, 0);
  return { source: canvas, via: 'libheif' };
}

async function decodeJxl(u8) {
  try {
    return { source: await decodeNative(u8, 'image/jxl'), via: '浏览器原生' };
  } catch { /* 仅 Safari 原生支持 JPEG XL */ }
  const decode = await getJxl();
  const img = await decode(u8.slice().buffer);
  return { source: imageDataToCanvas(img.data, img.width, img.height, img.colorSpace || 'srgb'), via: 'libjxl' };
}

async function decodeTiff(u8, orientation) {
  try {
    return { source: await decodeNative(u8, 'image/tiff'), via: '浏览器原生' };
  } catch { /* 仅 Safari 原生支持 TIFF */ }
  const UTIF = await getUtif();
  const buf = u8.slice().buffer;
  const ifds = UTIF.decode(buf);
  const page = ifds.reduce((a, b) => ((b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a), ifds[0]);
  UTIF.decodeImage(buf, page, ifds);
  const rgba = new Uint8ClampedArray(UTIF.toRGBA8(page).buffer);
  const canvas = imageDataToCanvas(rgba, page.width, page.height, 'srgb');
  return { source: orientCanvas(canvas, page.width, page.height, orientation) || canvas, via: 'UTIF' };
}

async function decodeDng(u8, dng) {
  const { preview, orientation } = dng;
  if (!preview) throw new Error('该 DNG 中没有可用的内嵌预览图（浏览器端暂不支持直接冲洗 RAW 数据，请使用桌面版）');
  let source;
  let selfOriented = false;
  if (preview.kind === 'jpeg') {
    source = await decodeNative(preview.bytes, 'image/jpeg');
    try {
      const exifr = await getExifr();
      const o = await exifr.orientation(preview.bytes);
      selfOriented = !!o && o !== 1;
    } catch { /* 无 EXIF */ }
  } else {
    source = (await decodeJxl(preview.bytes)).source;
  }
  if (!selfOriented) source = orientCanvas(source, source.width, source.height, orientation) || source;
  return { source, via: `ProRAW 内嵌预览图 ${preview.w}×${preview.h}` };
}

// ---------- 对外入口 ----------

export const FORMAT_LABELS = {
  jpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', jxl: 'JPEG XL', avif: 'AVIF', heif: 'HEIF',
  tiff: 'TIFF', dng: 'ProRAW DNG',
};

export const ACCEPT = [
  '.heic', '.heif', '.hif', '.dng', '.jpg', '.jpeg', '.png', '.jxl', '.avif', '.webp', '.tif', '.tiff',
  'image/heic', 'image/heif', 'image/jxl', 'image/avif', 'image/x-adobe-dng', 'image/*',
].join(',');

export function isSupportedName(name) {
  return /\.(heic|heif|hif|dng|jpe?g|png|jxl|avif|webp|tiff?)$/i.test(name);
}

/**
 * 解码照片
 * @returns {{source: CanvasImageSource, width: number, height: number, exif: object, kind: string,
 *            p3: boolean, via: string}}
 */
export async function decodePhoto(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  let kind = sniff(u8);
  if (!kind) throw new Error('无法识别的文件格式');

  let dng = null;
  let heifMeta = null;
  if (kind === 'tiff') {
    dng = findDngPreview(u8);
    if (dng.isDng || /\.dng$/i.test(file.name)) kind = 'dng';
  }
  if (kind === 'heif' || kind === 'avif') heifMeta = parseHeifMeta(u8);

  const exif = await readExif(u8, kind === 'dng' ? 'tiff' : kind, heifMeta);
  const orientation = exif.Orientation || 1;

  let decoded;
  if (kind === 'heif') {
    // iPhone HEIC 均为 Display P3，缺少色彩信息时按 P3 处理
    decoded = await decodeHeif(u8, heifMeta.p3 || /apple/i.test(exif.Make || ''));
  } else if (kind === 'jxl') {
    decoded = await decodeJxl(u8);
  } else if (kind === 'dng') {
    decoded = await decodeDng(u8, dng);
  } else if (kind === 'tiff') {
    decoded = await decodeTiff(u8, orientation);
  } else {
    let source = await decodeNative(u8);
    if (!(await appliesOrientation(kind))) {
      source = orientCanvas(source, source.width, source.height, orientation) || source;
    }
    decoded = { source, via: '浏览器原生' };
  }
  const { source } = decoded;
  return {
    source,
    width: source.width,
    height: source.height,
    exif,
    kind,
    via: decoded.via,
  };
}
