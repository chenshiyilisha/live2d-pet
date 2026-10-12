"""诊断用：把真实光标在屏幕上挪一圈，验证窗口外的视线跟随 / 窗口内的命中判定。

用 ctypes 直接调 user32.SetCursorPos —— 不走 PowerShell 的 Add-Type
（本机安全策略会拦 Add-Type），也不需要编译任何东西。

用法：python move-cursor.py <起点延时秒> <每个点停留秒>

轨迹刻意设计成「屏幕四角 → 窗口所在区域」：
  - 前面几个点全在窗口外，用来看轮询给的坐标（mousemove 拿不到）
  - 后面几个点钻进窗口内（默认窗口在右下角 (1656,662)-(2024,1080)），
    用来压测鼠标移动时的像素级命中判定开销
"""
import ctypes
import sys
import time

user32 = ctypes.windll.user32
SW, SH = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)

delay = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
dwell = float(sys.argv[2]) if len(sys.argv) > 2 else 1.2

# 直接给物理像素点，省得算比例
POINTS = [
    (102, 57), (1023, 57), (1944, 57),
    (1944, 575), (1023, 575), (102, 575),
    (102, 1093), (1023, 1093),
    # ↓ 进入窗口区域（右下角），会持续触发 mousemove → 压测命中判定
    (1700, 700), (1866, 870), (1990, 1050), (1700, 1050),
    (1770, 760), (1950, 900), (1730, 980),
]

print(f"[move] screen={SW}x{SH} delay={delay}s dwell={dwell}s points={len(POINTS)}", flush=True)
time.sleep(delay)

for i, (x, y) in enumerate(POINTS):
    user32.SetCursorPos(x, y)
    print(f"[move] step {i}: ({x},{y})", flush=True)
    time.sleep(dwell)

print("[move] done", flush=True)
