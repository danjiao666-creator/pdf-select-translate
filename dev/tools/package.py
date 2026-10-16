"""把扩展目录打包成 zip（正斜杠路径，跨平台可解压）。

用法：python dev/tools/package.py
输出：<扩展目录的上一级>/pdf-translate-extension-<version>.zip
"""

import json
import os
import zipfile

EXT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root = extension root
WS = os.path.dirname(EXT)

SKIP_DIRS = {".git", "__pycache__", "node_modules", "dev"}
SKIP_FILES = {".DS_Store", "Thumbs.db", "config.local.json", ".gitignore", ".gitattributes"}


def main():
    with open(os.path.join(EXT, "manifest.json"), "r", encoding="utf-8") as fh:
        version = json.load(fh)["version"]
    out = os.path.join(WS, f"pdf-translate-extension-{version}.zip")

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(EXT):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in sorted(files):
                if name in SKIP_FILES:
                    continue
                full = os.path.join(root, name)
                rel = os.path.relpath(full, EXT).replace(os.sep, "/")
                zf.write(full, rel)
                count += 1

    size_kb = os.path.getsize(out) / 1024
    print(f"wrote {out} ({count} files, {size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
