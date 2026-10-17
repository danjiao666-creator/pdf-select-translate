"""生成扩展图标：墨绿书签 + 白色「译」字。需要 Pillow。"""
from PIL import Image, ImageDraw, ImageFont
import os

_DEV = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # <repo>/dev
OUT = os.path.join(os.path.dirname(_DEV), "icons")  # <repo>/icons
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make_icon(size):
    scale = 4
    w = size * scale
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, w - 1], fill=(36, 105, 91, 255))
    # 圆角遮罩
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=int(w * 0.22), fill=255)
    img.putalpha(mask)
    # 文字
    font = load_font(int(w * 0.62))
    text = "译"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((w - tw) / 2 - bbox[0], (w - th) / 2 - bbox[1]), text, font=font, fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    icon = make_icon(s)
    path = os.path.join(OUT, f"icon{s}.png")
    icon.save(path)
    print("wrote", path, os.path.getsize(path))

# Windows 快捷方式用的多尺寸 .ico
ico_path = os.path.join(OUT, "icon.ico")
make_icon(256).save(ico_path, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", ico_path, os.path.getsize(ico_path))
