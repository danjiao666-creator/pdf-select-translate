"""测量 DeepSeek 真实延迟：不同输入长度下的「首字时间(TTFT)」与总时长。

用流式(stream=true)看首字延迟 —— 这决定「能不能更早看到译文」。
"""

import http.client
import json
import os
import ssl
import sys
import time

KEY = os.environ.get("DS_KEY", "")
if not KEY:
    print("no key")
    sys.exit(2)

SHORT = "The quick brown fox jumps over the lazy dog."
MEDIUM = (
    "Machine translation quality depends heavily on the engine you choose. "
    "Free endpoints are fast but they often lose nuance, while a large language model "
    "can follow instructions about tone, terminology and formatting. For reading PDF "
    "papers, what matters most is that the first version of the translation appears "
    "quickly enough that you never lose your place in the document."
)
LONG = (MEDIUM + " ") * 4

SYSTEM = (
    "You are a professional translator. Translate the user text into Simplified Chinese "
    "(简体中文). Output ONLY the translation without quotes or explanations. "
    "Keep numbers, formulas, code and proper nouns accurate."
)


def measure(text, label):
    payload = json.dumps(
        {
            "model": "deepseek-chat",
            "temperature": 0.2,
            "stream": True,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": text},
            ],
        }
    ).encode()

    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection("api.deepseek.com", 443, timeout=120, context=ctx)
    t0 = time.time()
    conn.request(
        "POST",
        "/v1/chat/completions",
        body=payload,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    resp = conn.getresponse()
    if resp.status != 200:
        body = resp.read().decode("utf-8", "ignore")[:200]
        print(f"{label}: HTTP {resp.status} {body}")
        return

    ttft = None
    chars = 0
    buf = b""
    while True:
        chunk = resp.read(1)
        if not chunk:
            break
        buf += chunk
        if not buf.endswith(b"\n"):
            continue
        line = buf.decode("utf-8", "ignore").strip()
        buf = b""
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            obj = json.loads(data)
            delta = obj.get("choices", [{}])[0].get("delta", {})
            piece = delta.get("content") or ""
        except Exception:
            piece = ""
        if piece:
            if ttft is None:
                ttft = time.time() - t0
            chars += len(piece)
    total = time.time() - t0
    conn.close()
    print(
        f"{label}: 输入 {len(text)} 字符 → 首字 {ttft*1000 if ttft else -1:.0f} ms, "
        f"总时长 {total*1000:.0f} ms, 输出 {chars} 字符"
    )


for label, text in (("短句", SHORT), ("段落", MEDIUM), ("长段", LONG)):
    try:
        measure(text, label)
    except Exception as exc:
        print(f"{label}: 失败 {exc}")
    time.sleep(1)
