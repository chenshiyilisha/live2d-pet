"""把 ?snap=hit 的 ASCII 命中图转成 SVG（左：矩形判定，右：像素判定）。

只是画图工具，不参与运行时逻辑。格子和窗口同比例（1 格 = 10px 窗口）。
"""
import re

CELL = 6
RAW = open('debug/hit2.log', encoding='utf-8', errors='replace').read()

rows = []
seen = set()
for m in re.finditer(r'\[pet\] hitmap (\d{3}) ([.#+]+)', RAW):
    label = int(m.group(1))
    if label in seen:          # 主进程会把同一条 console 记两遍，按 label 去重
        continue
    seen.add(label)
    rows.append((label, m.group(2)))
rows.sort()

cols = len(rows[0][1])
grid_w = cols * CELL
grid_h = len(rows) * CELL

# petRect [x, y, w, h] = [78, 18, 217, 400]，窗口 368x418 → 1 格 = 10px
PET = (78, 18, 217, 400)

LX, RX, TY = 60, 404, 64          # 左右两图的网格原点
OUT = []

OUT.append(f'<svg width="100%" viewBox="0 0 680 {TY + grid_h + 24 + 20}" role="img" '
           f'xmlns="http://www.w3.org/2000/svg">')
OUT.append('<title>命中判定范围对比</title>')
OUT.append('<desc>左：旧的矩形判定，整块都算她身上，其中三分之一是透明区。'
           '右：新的像素判定，只认真正有像素的地方。</desc>')

# 两个图各自的网格底 + 标题
for ox, label in ((LX, '旧：矩形判定'), (RX, '新：像素判定')):
    OUT.append(f'<text class="th" x="{ox}" y="46">{label}</text>')
    OUT.append(f'<rect x="{ox}" y="{TY}" width="{grid_w}" height="{grid_h}" '
               f'fill="none" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>')

# ---- 左图：矩形判定，整个 petRect 都算命中 ----
bx = LX + PET[0] / 10 * CELL
by = TY + PET[1] / 10 * CELL
bw = PET[2] / 10 * CELL
bh = min(PET[3] / 10 * CELL, grid_h - (PET[1] / 10 * CELL))
OUT.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bw:.1f}" height="{bh:.1f}" '
           f'fill="#E24B4A" fill-opacity="0.55" stroke="#A32D2D" stroke-width="0.5"/>')

# ---- 右图：像素判定，只画真正命中的格子（横向合并成 run）----
for r, (_, line) in enumerate(rows):
    c = 0
    while c < cols:
        if line[c] == '#':
            c0 = c
            while c < cols and line[c] == '#':
                c += 1
            OUT.append(f'<rect x="{RX + c0 * CELL}" y="{TY + r * CELL}" '
                       f'width="{(c - c0) * CELL}" height="{CELL}" fill="#378ADD"/>')
        else:
            c += 1
# 右图也叠一个虚线框，表示同一个 petRect 范围，方便对照
OUT.append(f'<rect x="{RX + PET[0] / 10 * CELL:.1f}" y="{TY + PET[1] / 10 * CELL:.1f}" '
           f'width="{bw:.1f}" height="{bh:.1f}" fill="none" '
           f'stroke="var(--color-text-tertiary)" stroke-width="0.5" stroke-dasharray="3 3"/>')

y_txt = TY + grid_h + 22
OUT.append(f'<text class="ts" x="{LX}" y="{y_txt}">整块都算命中 · 矩形内仅 66.8% 是实体</text>')
OUT.append(f'<text class="ts" x="{RX}" y="{y_txt}">只认有像素的地方 · 误触发归零</text>')
OUT.append('</svg>')

open('debug/hit-compare.svg', 'w', encoding='utf-8').write('\n'.join(OUT))
print('\n'.join(OUT))
