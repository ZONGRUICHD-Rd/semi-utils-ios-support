import configparser
import platform
import shutil
from pathlib import Path

import tomli

from core import CONFIG_PATH, PROJECT_INFO

fonts_dir = Path('config/fonts')
logos_dir = Path('./config/logos')
templates_dir = Path('./config/templates')

if platform.system() == 'Windows':
    EXIFTOOL_PATH = Path('./exiftool/exiftool.exe')
    ENCODING = 'gbk'
elif shutil.which('exiftool') is not None:
    EXIFTOOL_PATH = shutil.which('exiftool')
    ENCODING = 'utf-8'
else:
    EXIFTOOL_PATH = Path('./exiftool/exiftool')
    ENCODING = 'utf-8'

def load_config() -> configparser.ConfigParser:
    config = configparser.ConfigParser()
    config.read(CONFIG_PATH)
    return config


def load_project_info():
    with open(PROJECT_INFO, "rb") as f:  # 注意：tomllib 需要以二进制模式（"rb"）打开文件
        data = tomli.load(f)
    return data
