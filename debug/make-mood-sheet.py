# 把 ?snap=mood 落的 8 张情绪截图拼成一张对比表（上半身版 + 头部特写版）。
#
# 用途：EMOTION 表里的正负号只能靠这一步校准 —— "眉高低 +0.45 是上扬还是下压"
# "BODY_Y +2.5 是前倾还是后仰" 推不出来，只能看图。
#
# 跑法：<venv>/python.exe debug/make-mood-sheet.py
#   输入 debug/pet-mood-<情绪>.png（PET_SNAPSHOT=mood 产出）
#   输出 debug/mood-sheet.png / debug/mood-heads.png

import os
from PIL import Image, ImageDraw

NAMES = ['calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy']
HERE = os.path.dirname(os.path.abspath(__file__))
COLS, ROWS = 4, 2
LABEL_H = 26
GAP = 6


def load(name):
    p = os.path.join(HERE, f'pet-mood-{name}.png')
    if not os.path.exists(p):
        raise SystemExit(f'缺图：{p}（先跑 PET_SNAPSHOT=mood 启动一次）')
    # capturePage 出来的是 RGBA（透明窗）。直接 convert('RGB') 透明处会变黑，
    # 先铺一层浅底再合成，不然拼出来一片黑什么都看不见。
    im = Image.open(p).convert('RGBA')
    bg = Image.new('RGBA', im.size, (248, 248, 250, 255))
    return Image.alpha_composite(bg, im).convert('RGB')


def build(images, box, scale, out):
    """box = (l, t, r, b) 归一化裁剪；scale 缩放倍率。"""
    crops = []
    for im in images:
        w, h = im.size
        crops.append(im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h))))
    cw, ch = crops[0].size
    tw, th = int(cw * scale), int(ch * scale)
    sheet = Image.new('RGB', (COLS * tw + (COLS + 1) * GAP, ROWS * (th + LABEL_H) + (ROWS + 1) * GAP),
                      (238, 238, 242))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(zip(NAMES, crops)):
        r, c = divmod(i, COLS)
        x = GAP + c * (tw + GAP)
        y = GAP + r * (th + LABEL_H + GAP)
        sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y))
        d.rectangle([x, y, x + tw - 1, y + th - 1], outline=(190, 190, 197))
        d.text((x + 3, y + th + 6), name, fill=(28, 28, 32))
    sheet.save(out)
    print('写入', out, sheet.size)


imgs = [load(n) for n in NAMES]
# 全身（窗口就是半身取景，全部有用）
build(imgs, (0.0, 0.0, 1.0, 1.0), 0.62, os.path.join(HERE, 'mood-sheet.png'))
# 头部特写 —— 头顶实测在窗口高的 ~40%（measureHead 量过 123~137 逻辑 px / 342），
# 脸在 0.40~0.75 之间；不裁到这一段，眉眼的差别根本看不出来。
build(imgs, (0.06, 0.38, 0.94, 0.76), 1.60, os.path.join(HERE, 'mood-heads.png'))
