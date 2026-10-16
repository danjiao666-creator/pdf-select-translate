"""生成一个带文字层的示例 PDF，用于自动化测试（无需第三方库）。"""

import os

LINES = [
    "PDF Select and Translate - sample document",
    "",
    "The quick brown fox jumps over the lazy dog.",
    "This sentence exists so the extension has something to translate.",
    "Machine translation quality depends on the engine you choose.",
    "",
    "Second paragraph: select any sentence with the mouse and the",
    "translation card should appear immediately next to your selection.",
]


def esc(text):
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def build_pdf(path, lines):
    content_lines = ["BT", "/F1 14 Tf", "20 TL", "72 720 Td"]
    for line in lines:
        content_lines.append(f"({esc(line)}) Tj T*")
    content_lines.append("ET")
    stream = "\n".join(content_lines).encode("latin-1", "replace")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ).encode()

    with open(path, "wb") as fh:
        fh.write(bytes(out))
    return len(out)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    tests = os.path.join(os.path.dirname(here), "tests")
    os.makedirs(tests, exist_ok=True)
    target = os.path.join(tests, "sample.pdf")
    size = build_pdf(target, LINES)
    print("wrote", target, size, "bytes")
