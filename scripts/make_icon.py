"""生成应用图标：渐变圆角方块 + OK 字样，输出 build/icon.ico 与 build/icon.png。
运行：python scripts/make_icon.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build")
os.makedirs(OUT_DIR, exist_ok=True)

SIZE = 1024
C1 = (91, 141, 239)    # #5B8DEF
C2 = (124, 108, 240)   # #7C6CF0

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
]


def gradient(size):
    """对角线性渐变"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = (
                round(C1[0] + (C2[0] - C1[0]) * t),
                round(C1[1] + (C2[1] - C1[1]) * t),
                round(C1[2] + (C2[2] - C1[2]) * t),
            )
    return img


def rounded_mask(size, radius_ratio=0.22):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return mask


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def build():
    base = gradient(SIZE)
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), rounded_mask(SIZE))

    draw = ImageDraw.Draw(icon)
    font = load_font(int(SIZE * 0.42))
    text = "OK"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    draw.text(
        ((SIZE - tw) / 2 - box[0], (SIZE - th) / 2 - box[1] - SIZE * 0.01),
        text, font=font, fill=(255, 255, 255, 255)
    )

    png_path = os.path.join(OUT_DIR, "icon.png")
    icon.resize((512, 512), Image.LANCZOS).save(png_path)

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    icon.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return png_path, ico_path


if __name__ == "__main__":
    png, ico = build()
    print("ICON_OK", png, os.path.getsize(png), ico, os.path.getsize(ico))
