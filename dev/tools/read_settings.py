"""读取浏览器里本扩展当前的 chrome.storage 设置（只读诊断，不回显完整 Key）。

扩展 ID 不写死：未打包扩展的 ID = SHA-256(扩展目录的 UTF-16LE 路径) 前 16 字节，映射到 a-p。

用法：python dev/tools/read_settings.py
"""

import glob
import hashlib
import json
import os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def extension_id(path):
    digest = hashlib.sha256(path.encode("utf-16-le")).digest()[:16]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest.hex())


def json_objects(text):
    """暴力扫描出所有可解析的顶层 JSON 对象（LevelDB 文件里混着二进制）。"""
    out = []
    depth = 0
    start = None
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        obj = json.loads(text[start : i + 1])
                        if isinstance(obj, dict):
                            out.append(obj)
                    except Exception:
                        pass
                    start = None
    return out


def profile_roots():
    local = os.path.expandvars(r"%LOCALAPPDATA%")
    return [
        os.path.join(local, "Microsoft", "Edge", "User Data"),
        os.path.join(local, "Google", "Chrome", "User Data"),
    ]


def main():
    ext_id = extension_id(REPO)
    print(f"扩展目录: {REPO}")
    print(f"扩展 ID  : {ext_id}")

    scanned = 0
    for root in profile_roots():
        if not os.path.isdir(root):
            continue
        store = os.path.join(root, "Default", "Local Extension Settings", ext_id)
        if not os.path.isdir(store):
            continue
        print(f"\n找到存储目录: {store}")
        data = b""
        for path in sorted(glob.glob(os.path.join(store, "*"))):
            try:
                data += open(path, "rb").read()
            except Exception:
                pass
        text = data.decode("utf-8", "ignore")
        objects = json_objects(text)
        scanned += len(objects)

        settings = [o for o in objects if "engine" in o and "custom" in o]
        health = [o for o in objects if "lastGood" in o or ("cooldown" in o and "latency" in o)]
        if settings:
            s = dict(settings[-1])
            custom = dict(s.get("custom") or {})
            key = custom.get("apiKey") or ""
            custom["apiKey"] = f"sk-...{key[-4:]} (len {len(key)})" if key else "(empty)"
            s["custom"] = custom
            print("当前设置:")
            print(json.dumps(s, ensure_ascii=False, indent=2))
        if health:
            print("引擎健康度:", json.dumps(health[-1], ensure_ascii=False)[:400])

    if not scanned:
        print("\n没有找到任何存储（扩展可能还没在这个浏览器里加载过）。")


if __name__ == "__main__":
    main()
