"""逐像素比较两组截图。用法: python3 diff.py <目录 A> <目录 B> [阈值=1]"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 1
print(f"{'画面':<26}{'尺寸':<14}{'最大差值':>8}{'有差异':>10}{'超过阈值':>10}  超过阈值的范围")
for a_path in sorted(a_dir.glob('*.png')):
    b_path = b_dir / a_path.name
    if not b_path.exists():
        print(f'{a_path.stem:<26}缺少对照')
        continue
    a = np.asarray(Image.open(a_path).convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(b_path).convert('RGB'), dtype=np.int16)
    if a.shape != b.shape:
        print(f'{a_path.stem:<26}尺寸不同 {a.shape} {b.shape}')
        continue
    delta = np.abs(a - b).max(axis=2)
    over = np.argwhere(delta > limit)
    box = ''
    if len(over):
        (top, left), (bottom, right) = over.min(axis=0), over.max(axis=0)
        box = f'x {left}–{right}, y {top}–{bottom}'
    size = f'{a.shape[1]}x{a.shape[0]}'
    print(f'{a_path.stem:<26}{size:<14}{int(delta.max()):>8}{int((delta > 0).sum()):>10}{len(over):>10}  {box}')
