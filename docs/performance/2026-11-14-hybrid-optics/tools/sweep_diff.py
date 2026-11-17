"""比较 sweep.mjs 的两组截图。用法: python3 sweep_diff.py <目录 A> <目录 B> [阈值=2]

间距画面只统计融合的两块玻璃所在的范围，裁剪画面只统计被裁剪的那块玻璃所在的范围。"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 2
REGIONS = {'gap': (0, 1300, 2200, 2300), 'clip': (0, 800, 2200, 1400)}
print(f"{'画面':<14}{'最大差值':>8}{'有差异':>10}{'超过阈值':>10}  超过阈值的范围")
for a_path in sorted(a_dir.glob('*.png')):
    left, top, right, bottom = REGIONS[a_path.stem.split('-')[0]]
    a = np.asarray(Image.open(a_path).convert('RGB'), dtype=np.int16)[top:bottom, left:right]
    b = np.asarray(Image.open(b_dir / a_path.name).convert('RGB'), dtype=np.int16)[top:bottom, left:right]
    delta = np.abs(a - b).max(axis=2)
    over = np.argwhere(delta > limit)
    box = ''
    if len(over):
        (y0, x0), (y1, x1) = over.min(axis=0), over.max(axis=0)
        box = f'x {x0 + left}–{x1 + left}, y {y0 + top}–{y1 + top}'
    print(f'{a_path.stem:<14}{int(delta.max()):>8}{int((delta > 0).sum()):>10}{len(over):>10}  {box}')
