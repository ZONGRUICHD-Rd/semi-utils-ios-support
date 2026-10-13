"""
统一的图片读取入口

覆盖 iPhone（含 iPhone 18 Pro）相机与系统会产出的全部照片格式:
- HEIC / HEIF / HIF: HEIF、HEIF Max(48MP)、10bit HDR、带增益图的 HDR 照片、空间照片(取主图) —— pillow-heif
- JPEG: 「兼容性最佳」模式 —— Pillow
- DNG: ProRAW / ProRAW Max，支持 JPEG 无损、JPEG-XL 无损、JPEG-XL 有损压缩 —— rawpy(LibRaw)，内嵌预览图 + exiftool 兜底
- PNG(截图)、JPEG XL、AVIF、WebP、TIFF: 导出 / 分享时常见的格式

所有读取到的图片都会:
- 按 EXIF / RAW 方向信息旋转为正确方向
- 统一为 RGB 或 RGBA 模式
- 在 info['icc_profile'] 中保留色彩配置文件（iPhone 照片为 Display P3），保存时写回，避免颜色发灰
"""
import io
import json
import os
import subprocess
from functools import lru_cache
from pathlib import Path

import pillow_heif
from PIL import Image, ImageCms, ImageOps

from core.configs import EXIFTOOL_PATH, load_config
from core.logger import logger

# 注册 HEIC / HEIF 支持
pillow_heif.register_heif_opener()
logger.debug("Registered plugin: pillow_heif")

# 注册 JPEG XL 支持（可选依赖）
try:
    import pillow_jxl  # noqa: F401

    logger.debug("Registered plugin: pillow_jxl")
except ImportError:
    pillow_jxl = None

# RAW 解码（可选依赖）
try:
    import rawpy
except ImportError:
    rawpy = None

RAW_SUFFIXES = {'.dng'}
# 浏览器可直接预览的格式，其余格式预览时转为 JPEG
BROWSER_PREVIEWABLE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
# 无法写回原格式时（如 DNG）使用的输出格式
FALLBACK_OUTPUT_SUFFIX = '.jpg'
RAW_DECODE_MODES = ('auto', 'preview', 'raw')

# 内嵌预览图长边达到 RAW 长边的该比例时，视为全尺寸预览
_FULL_SIZE_PREVIEW_RATIO = 0.9

# EXIF Orientation -> 旋转/翻转操作（与 ImageOps.exif_transpose 一致）
_ORIENTATION_TRANSPOSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}
# LibRaw flip -> EXIF Orientation
_FLIP_TO_ORIENTATION = {0: 1, 1: 2, 2: 4, 3: 3, 4: 5, 5: 8, 6: 6, 7: 7}
_EXIF_ORIENTATION_TAG = 0x0112


def is_raw(path) -> bool:
    return Path(path).suffix.lower() in RAW_SUFFIXES


def open_image(path) -> Image.Image:
    """
    读取图片，返回方向已校正、模式为 RGB / RGBA 的图片，色彩配置文件保留在 info['icc_profile']
    """
    if is_raw(path):
        img = _open_raw(str(path))
    else:
        if Path(path).suffix.lower() == '.jxl' and pillow_jxl is None:
            raise RuntimeError('读取 JPEG XL 需要安装 pillow-jxl-plugin: pip install pillow-jxl-plugin')
        with Image.open(path) as f:
            f.load()
            img = ImageOps.exif_transpose(f)
    return _normalize_mode(img)


def probe_size(path) -> tuple[int, int] | None:
    """
    RAW 文件实际会被解码出的尺寸（未旋转方向，与 EXIF 中 ImageWidth/ImageHeight 的含义一致）

    RAW 的 EXIF 尺寸不一定等于最终解码使用的图像（例如只能使用内嵌预览图时），
    模板中的 vw()/vh() 依赖该尺寸，因此需要以实际解码结果为准。非 RAW 文件返回 None。
    """
    if not is_raw(path):
        return None
    _, width, height = _raw_decision(str(path), os.stat(path).st_mtime_ns, _raw_decode_mode())
    return width, height


def output_suffix(path) -> str:
    """输出文件后缀: Pillow 能写出的格式保持原格式，RAW 等无法写出的格式输出 JPEG"""
    suffix = Path(path).suffix
    if suffix.lower() in RAW_SUFFIXES:
        return FALLBACK_OUTPUT_SUFFIX
    fmt = Image.registered_extensions().get(suffix.lower())
    if fmt is None or fmt not in Image.SAVE:
        return FALLBACK_OUTPUT_SUFFIX
    return suffix


def to_jpeg_buffer(path, quality: int = 90) -> io.BytesIO:
    """将任意支持的格式转为 JPEG 字节流（用于浏览器预览）"""
    img = open_image(path)
    buffer = io.BytesIO()
    img.convert('RGB').save(buffer, format='JPEG', quality=quality, icc_profile=img.info.get('icc_profile'))
    buffer.seek(0)
    return buffer


# ==================== 内部实现 ====================

def _normalize_mode(img: Image.Image) -> Image.Image:
    if img.mode in ('RGB', 'RGBA'):
        return img
    icc_profile = img.info.get('icc_profile')
    has_alpha = img.mode in ('LA', 'La', 'PA', 'RGBa') or 'transparency' in img.info
    if img.mode.startswith('I;16') or img.mode == 'I':
        # 16bit 灰度（部分 PNG / JPEG XL），缩放到 8bit
        img = img.convert('I').point(lambda v: v * (1 / 257)).convert('L')
    img = img.convert('RGBA' if has_alpha else 'RGB')
    # 灰度 / CMYK 等色彩空间的配置文件不能用于 RGB 图像
    img.info.pop('icc_profile', None)
    if icc_profile and _icc_color_space(icc_profile) == 'RGB':
        img.info['icc_profile'] = icc_profile
    return img


def _icc_color_space(icc_profile: bytes) -> str | None:
    # ICC 头部 16~20 字节为数据色彩空间签名，如 'RGB '、'GRAY'、'CMYK'
    if len(icc_profile) < 20:
        return None
    return icc_profile[16:20].decode('ascii', errors='ignore').strip()


@lru_cache(maxsize=1)
def _srgb_icc() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()


def _raw_decode_mode() -> str:
    mode = load_config().get('DEFAULT', 'raw_decode_mode', fallback='auto').strip().lower()
    return mode if mode in RAW_DECODE_MODES else 'auto'


def _apply_orientation(img: Image.Image, orientation: int) -> Image.Image:
    method = _ORIENTATION_TRANSPOSE.get(orientation)
    if method is None:
        return img
    transposed = img.transpose(method)
    transposed.info = img.info.copy()
    return transposed


def _stored_size(size: tuple[int, int], orientation: int) -> tuple[int, int]:
    """方向校正后的尺寸 -> 未旋转时的尺寸"""
    return (size[1], size[0]) if orientation in (5, 6, 7, 8) else size


def _orient_preview(preview: Image.Image, raw_orientation: int, raw_size: tuple[int, int] | None) -> Image.Image:
    """
    校正内嵌预览图方向:
    - 预览图自带 EXIF 方向时以其为准（iPhone ProRAW 即是如此）
    - 否则使用 RAW 的方向；若预览图已经是旋转后的尺寸，则不再旋转
    """
    preview.load()
    if preview.getexif().get(_EXIF_ORIENTATION_TAG):
        return ImageOps.exif_transpose(preview)
    if raw_size and raw_orientation in (5, 6, 7, 8) and _is_swapped(preview.size, raw_size):
        return preview
    return _apply_orientation(preview, raw_orientation)


def _is_swapped(size: tuple[int, int], raw_size: tuple[int, int]) -> bool:
    return (size[0] > size[1]) != (raw_size[0] > raw_size[1]) and size[0] != size[1]


def _preview_stored_size(preview: Image.Image, raw_orientation: int, raw_size: tuple[int, int] | None):
    orientation = preview.getexif().get(_EXIF_ORIENTATION_TAG)
    if orientation:
        return preview.size
    if raw_size and raw_orientation in (5, 6, 7, 8) and _is_swapped(preview.size, raw_size):
        return preview.size[1], preview.size[0]
    return preview.size


def _rawpy_preview(raw) -> Image.Image | None:
    """LibRaw 选出的最大内嵌预览图（惰性打开，未校正方向）"""
    try:
        thumb = raw.extract_thumb()
    except Exception as e:
        logger.debug(f'rawpy 无法提取内嵌预览图: {e}')
        return None
    if thumb.format == rawpy.ThumbFormat.JPEG:
        try:
            return Image.open(io.BytesIO(thumb.data))
        except Exception as e:
            logger.debug(f'内嵌预览图无法识别: {e}')
            return None
    if thumb.format == rawpy.ThumbFormat.BITMAP:
        return Image.fromarray(thumb.data)
    return None


def _rawpy_develop(raw) -> Image.Image:
    rgb = raw.postprocess(use_camera_wb=True, output_bps=8, output_color=rawpy.ColorSpace.sRGB)
    img = Image.fromarray(rgb)
    img.info['icc_profile'] = _srgb_icc()
    return img


def _exiftool_preview(path: str) -> tuple[Image.Image, int] | None:
    """
    使用 exiftool 提取最大的内嵌预览图（LibRaw 无法读取的 DNG，例如未编译 JPEG-XL 支持时）
    返回 (预览图, RAW 方向)
    """
    try:
        output = subprocess.check_output(
            [EXIFTOOL_PATH, '-j', '-a', '-G1', '-n', '-Orientation', '-Preview:all', '-JpgFromRaw', path],
            stderr=subprocess.DEVNULL)
        tags = json.loads(output.decode('utf-8', errors='ignore'))[0]
    except Exception as e:
        logger.debug(f'exiftool 读取预览图信息失败 {path}: {e}')
        return None

    orientation = next((v for k, v in tags.items() if k.endswith(':Orientation') and isinstance(v, int)), 1)

    def binary_length(value) -> int:
        # 形如 "(Binary data 5364435 bytes, use -b option to extract)"
        if isinstance(value, str) and value.startswith('(Binary data'):
            try:
                return int(value.split()[2])
            except (IndexError, ValueError):
                return 0
        return 0

    candidates = sorted(
        ((binary_length(v), k) for k, v in tags.items() if binary_length(v) > 0),
        # OtherImage 一般为语义分割蒙版等辅助图像，仅在没有其他预览时使用
        key=lambda item: (not item[1].endswith(':OtherImage'), item[0]),
        reverse=True,
    )
    for _, tag in candidates:
        try:
            data = subprocess.check_output([EXIFTOOL_PATH, '-b', f'-{tag}', path], stderr=subprocess.DEVNULL)
            preview = Image.open(io.BytesIO(data))
            preview.load()
            return preview, orientation
        except Exception as e:
            logger.debug(f'exiftool 预览图 {tag} 无法解码: {e}')
    return None


@lru_cache(maxsize=256)
def _raw_decision(path: str, mtime_ns: int, mode: str) -> tuple[str, int, int]:
    """
    决定 RAW 的解码方式，返回 (来源, 未旋转宽, 未旋转高)，来源为 preview / raw / exiftool

    auto   : 有全尺寸内嵌预览图时使用预览图（即 iPhone 相册中看到的苹果官方渲染效果，速度也快），否则解码 RAW
    preview: 优先使用内嵌预览图
    raw    : 优先使用 LibRaw 解码 RAW 数据
    无法解码 RAW 数据时（例如 LibRaw 不支持 JPEG-XL 压缩），自动回退到内嵌预览图
    """
    if rawpy is not None:
        try:
            with rawpy.imread(path) as raw:
                raw_size = (raw.sizes.width, raw.sizes.height)
                orientation = _FLIP_TO_ORIENTATION.get(raw.sizes.flip, 1)
                preview = _rawpy_preview(raw)
                preview_size = _preview_stored_size(preview, orientation, raw_size) if preview else None
                full_size_preview = preview_size is not None and \
                    max(preview_size) >= max(raw_size) * _FULL_SIZE_PREVIEW_RATIO
                if preview_size and (mode == 'preview' or (mode == 'auto' and full_size_preview)):
                    return 'preview', *preview_size
                try:
                    # 访问 raw_image 会触发 unpack，以确认 RAW 数据可以被解码
                    _ = raw.raw_image_visible.shape
                    return 'raw', *raw_size
                except Exception as e:
                    logger.warning(f'LibRaw 无法解码 RAW 数据, 使用内嵌预览图 {path}: {e}')
                if preview_size:
                    return 'preview', *preview_size
        except Exception as e:
            logger.warning(f'LibRaw 无法读取 {path}: {e}')
    else:
        logger.warning('未安装 rawpy，RAW 文件将使用内嵌预览图: pip install rawpy')

    result = _exiftool_preview(path)
    if result is None:
        raise RuntimeError(f'无法解码 RAW 文件: {path}')
    preview, orientation = result
    return 'exiftool', *_preview_stored_size(preview, orientation, None)


def _open_raw(path: str) -> Image.Image:
    source, _, _ = _raw_decision(path, os.stat(path).st_mtime_ns, _raw_decode_mode())
    logger.debug(f'RAW 解码方式: {source} {path}')
    if source == 'exiftool':
        preview, orientation = _exiftool_preview(path)
        return _orient_preview(preview, orientation, None)

    with rawpy.imread(path) as raw:
        raw_size = (raw.sizes.width, raw.sizes.height)
        orientation = _FLIP_TO_ORIENTATION.get(raw.sizes.flip, 1)
        if source == 'raw':
            try:
                return _rawpy_develop(raw)
            except Exception as e:
                logger.warning(f'LibRaw 解码失败, 使用内嵌预览图 {path}: {e}')
        preview = _rawpy_preview(raw)
        if preview is None:
            raise RuntimeError(f'无法解码 RAW 文件: {path}')
        return _orient_preview(preview, orientation, raw_size)
