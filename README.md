# semi-utils

> [![hugo-papermod](https://img.shields.io/badge/Semi--Utils-@LeslieVan-red)](https://github.com/leslievan/semi-utils)
> [![download](https://img.shields.io/github/downloads/leslievan/semi-utils/total.svg)](https://github.com/leslievan/semit-utils/releases)
> [![release](https://img.shields.io/github/v/release/leslievan/semi-utils)](https://github.com/leslievan/semi-utils/releases)
> [![license](https://img.shields.io/github/license/leslievan/semi-utils)](https://github.com/leslievan/semi-utils/blob/master/LICENSE)
> ![language](https://img.shields.io/github/languages/top/leslievan/semi-utils?color=orange)
>
> **这是一个用于给照片批量添加水印、处理照片像素比、图像色彩和质量的工具。**

如果您觉得程序对您有所帮助的话，可以点击 [Sponsor](https:/su/cdn.lsvm.xyz/wechat.jpg) 按钮请作者喝杯咖啡，谢谢！


## 开发文档

**[Wiki](../../wiki)**

## 效果展示

| 模板                                     | 描述                                      | 效果                                      |
|----------------------------------------|-----------------------------------------|-----------------------------------------|
| [standard1](./static/standard1.json)   | 经典 EXIF 水印，包含相机型号、镜头、焦距、光圈、快门、ISO、拍摄时间和相机品牌 Logo | ![standard1](./static/standard1.jpeg)   |
| [standard2](./static/standard2.json)   | 在 standard1 基础上添加圆角、阴影效果和留白，适合社交媒体分享 | ![standard2](./static/standard2.jpeg)   |
| [nikon_blur](./static/nikon_blur.json) | 尼康风格水印，相机型号中的红色「Z」字高亮，配合模糊背景效果 | ![nikon_blur](./static/nikon_blur.jpeg) |
| [blur](./static/blur.json)             | 简洁风格，相机型号+参数垂直居中展示，配合模糊背景效果 | ![blur](./static/blur.jpeg)             |
| [normal1](./static/normal1.json)       | 极简风格，右下角显示拍摄参数，低调不抢眼 | ![normal1](./static/normal1.jpeg)       |
| [normal2](./static/normal2.json)       | 文件夹名称+拍摄时间，橙色文字，简洁实用 | ![normal2](./static/normal2.jpeg)       |
| [center_logo](./static/center_logo.json) | 中心 Logo 水印，可自定义四周文字内容 | ![center_logo](./static/center_logo.jpeg)       |


## iPhone 照片格式支持

支持 iPhone（含 iPhone 18 Pro）相机与系统产出的全部照片格式：

| 格式 | 后缀 | 说明 |
|------|------|------|
| HEIF / HEIF Max | `.heic` `.heif` `.hif` | 含 48MP、10bit HDR、带增益图的 HDR 照片、空间照片（取主图） |
| JPEG（兼容性最佳） | `.jpg` `.jpeg` | |
| ProRAW / ProRAW Max | `.dng` | JPEG 无损、JPEG-XL 无损、JPEG-XL 有损压缩；输出为 `.jpg` |
| 导出 / 截图 | `.png` `.jxl` `.avif` `.webp` `.tif` `.tiff` | |

- 照片的 Display P3 色彩配置文件会写入输出文件，颜色与「照片」App 中一致，不会发灰。
- ProRAW 的解码方式由 `config/config.ini` 中的 `raw_decode_mode` 控制：
  - `auto`（默认）：有全尺寸内嵌预览图时直接使用（即 iPhone 相册中看到的苹果官方渲染效果，速度快），否则用 LibRaw 解码 RAW 数据；
  - `preview`：优先使用内嵌预览图；
  - `raw`：优先用 LibRaw 解码 RAW 数据。
  - LibRaw 无法解码时（例如 JPEG-XL 压缩的 ProRAW），会自动回退到内嵌预览图（由 rawpy 或 exiftool 提取）。
- 新增依赖 `rawpy`（ProRAW）与 `pillow-jxl-plugin`（JPEG XL），已加入 `requirements.txt`。

## 许可证

Semi-Utils 的发布基于 [Apache License 2.0](LICENSE).

### exiftool

Semi-Utils 引用了 [exiftool](https://exiftool.org/)，其发布基于 [GPL v1 + Artistic License 2.0](https://exiftool.org/#license)。


## 关于

[![Stargazers over time](https://starchart.cc/leslievan/semi-utils.svg)](https://starchart.cc/leslievan/semi-utils)
