"""
生成安卓图标资源 / Generate Android launcher icons.

从仓库根的 build/icon.png（512×512，与桌面端同一份设计）派生：
  1. 各密度传统图标 mipmap-*/ic_launcher.png
  2. 圆形图标 mipmap-*/ic_launcher_round.png
  3. 自适应图标（Android 8+）：前景层 + 背景层 + mipmap-anydpi-v26 XML

为什么用同一份源图：两端图标一致，用户在多设备间能认出是同一个应用。
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ANDROID_RES = os.path.abspath(os.path.join(HERE, "..", "android", "app", "src", "main", "res"))
SRC = os.path.join(REPO, "build", "icon.png")

# 安卓密度 → 传统图标边长（dp 48 基准）
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

# 自适应图标：108dp 画布，其中安全区 72dp（内容须落在中央约 66% 区域内）
ADAPTIVE = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}

SAFE_RATIO = 72 / 108  # 前景内容占画布的比例


def load_source():
    if not os.path.exists(SRC):
        sys.exit(f"缺少源图: {SRC}")
    im = Image.open(SRC).convert("RGBA")
    return im


def round_mask(size, radius_ratio=0.5):
    """生成圆角/圆形遮罩"""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask


def dominant_bg_color(im):
    """取四角附近的平均色作为自适应图标背景色，保证与图标浑然一体"""
    w, h = im.size
    px = im.convert("RGB").load()
    pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3),
           (w // 2, 3), (3, h // 2), (w - 4, h // 2), (w // 2, h - 4)]
    rs = gs = bs = 0
    for x, y in pts:
        r, g, b = px[x, y]
        rs += r; gs += g; bs += b
    n = len(pts)
    return (rs // n, gs // n, bs // n, 255)


def main():
    src = load_source()
    bg_color = dominant_bg_color(src)
    print(f"源图 {os.path.basename(SRC)} {src.size}，自适应背景色 rgba{bg_color}")

    # ---- 传统图标 + 圆形图标 ----
    for density, size in DENSITIES.items():
        d = os.path.join(ANDROID_RES, f"mipmap-{density}")
        os.makedirs(d, exist_ok=True)

        sq = src.resize((size, size), Image.LANCZOS)
        sq.save(os.path.join(d, "ic_launcher.png"), "PNG")

        rnd = src.resize((size, size), Image.LANCZOS)
        rnd.putalpha(round_mask(size))
        rnd.save(os.path.join(d, "ic_launcher_round.png"), "PNG")

        print(f"  mipmap-{density}: {size}px 传统 + 圆形")

    # ---- 自适应图标 ----
    for density, size in ADAPTIVE.items():
        d = os.path.join(ANDROID_RES, f"mipmap-{density}")
        os.makedirs(d, exist_ok=True)

        # 背景层：纯色铺满
        bg = Image.new("RGBA", (size, size), bg_color)
        bg.save(os.path.join(d, "ic_launcher_background.png"), "PNG")

        # 前景层：源图缩到安全区内，居中，四周透明
        inner = max(1, int(round(size * SAFE_RATIO)))
        fg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        art = src.resize((inner, inner), Image.LANCZOS)
        off = ((size - inner) // 2, (size - inner) // 2)
        fg.paste(art, off, art)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"), "PNG")

        print(f"  mipmap-{density}: {size}px 自适应前景/背景")

    # ---- 自适应图标 XML（Android 8+）----
    anydpi = os.path.join(ANDROID_RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)

    xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(os.path.join(anydpi, name), "w", encoding="utf-8") as f:
            f.write(xml)
    print(f"  mipmap-anydpi-v26: {', '.join(['ic_launcher.xml', 'ic_launcher_round.xml'])}")

    print("图标生成完成")


if __name__ == "__main__":
    main()
