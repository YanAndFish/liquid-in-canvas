#!/usr/bin/env python3
"""测量玻璃边缘的折射剖面：到轮廓的距离 → 采样位移。

画面条件：一条两色分界线（水平或倾斜，不能接近竖直）穿过一块圆角矩形玻璃。
玻璃内每一列像素里，分界线出现的位置 y_obs 与玻璃外延长过来的真实位置 y_true 之差，
就是这一列在 y_obs 处的竖直采样位移。按观察点的轮廓法线换算成“沿内法线的位移”，
再按观察点到轮廓的距离分组，得到剖面曲线。

约定（全部为图像像素，y 向下）：
  d      观察点到玻璃轮廓的距离，轮廓上为 0，向内增大。
  shift  采样点相对观察点沿内法线的位移，正值表示朝玻璃内部取样。
         观察点 p 处看到的是 p − shift·n（n 为观察点处轮廓的外法线）。它落在分界线上，所以
         shift = (y_obs − y_true) / (n_y − k·n_x)，k 是分界线斜率；水平分界线时即 (y_obs − y_true) / n_y。
         法线在分界线法向上的分量太小（轮廓与分界线接近垂直）时换算误差大，留空。

用法：
  python3 -I profile_fit.py measure 截图.png --rect x,y,宽,高 [--radius r] [--scale 2]
         [--boundary auto | y | x,y,角度] [--out samples.csv] [--curve curve.csv]
  python3 -I profile_fit.py measure 截图.png --page 截图.json   # reference-shot.mjs 记下的轮廓与分界线
  python3 -I profile_fit.py synth 输出.png [--truth truth.csv] [--amp 14 --width 40 --power 2.5]
  python3 -I profile_fit.py selftest

只依赖标准库与 Pillow。没有 Pillow 时：python3 -m pip install --user Pillow
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import statistics
import sys
import tempfile

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境提示
    sys.exit('需要 Pillow：python3 -m pip install --user Pillow（或 brew install pillow）')


# ---------------------------------------------------------------------------
# 几何

class RoundRect:
    """圆角矩形轮廓，四角同一半径。"""

    def __init__(self, x: float, y: float, w: float, h: float, r: float | None = None):
        self.x, self.y, self.w, self.h = x, y, w, h
        self.r = min(w, h) / 2 if r is None else min(r, w / 2, h / 2)
        self.cx, self.cy = x + w / 2, y + h / 2
        self.short = min(w, h)

    def sdf(self, px: float, py: float) -> tuple[float, float, float]:
        """返回 (有符号距离, 外法线 x, 外法线 y)，内部距离为负。"""
        dx, dy = px - self.cx, py - self.cy
        sx = 1.0 if dx >= 0 else -1.0
        sy = 1.0 if dy >= 0 else -1.0
        qx = abs(dx) - (self.w / 2 - self.r)
        qy = abs(dy) - (self.h / 2 - self.r)
        if qx > 0 and qy > 0:
            length = math.hypot(qx, qy)
            return length - self.r, sx * qx / length, sy * qy / length
        if qx > qy:
            return qx - self.r, sx, 0.0
        return qy - self.r, 0.0, sy

    def span(self, px: float, inset: float) -> tuple[float, float] | None:
        """内缩 inset 后的轮廓在竖线 x=px 上覆盖的 y 区间。"""
        x0, x1 = self.x + inset, self.x + self.w - inset
        if px <= x0 or px >= x1:
            return None
        r = max(self.r - inset, 0.0)
        top, bottom = self.y + inset, self.y + self.h - inset
        left_c, right_c = x0 + r, x1 - r
        if px < left_c or px > right_c:
            c = left_c if px < left_c else right_c
            reach = r * r - (px - c) ** 2
            if reach <= 0:
                return None
            dy = r - math.sqrt(reach)
            return top + dy, bottom - dy
        return top, bottom


class Line:
    """y = slope · x + offset。"""

    def __init__(self, slope: float, offset: float):
        self.slope, self.offset = slope, offset

    @classmethod
    def through(cls, x: float, y: float, angle_deg: float) -> 'Line':
        slope = math.tan(math.radians(angle_deg))
        return cls(slope, y - slope * x)

    def y(self, x: float) -> float:
        return self.slope * x + self.offset

    def signed(self, px: float, py: float) -> float:
        """点到直线的有符号距离，直线下方为正。"""
        return (py - self.y(px)) / math.hypot(1.0, self.slope)

    def angle(self) -> float:
        return math.degrees(math.atan(self.slope))


# ---------------------------------------------------------------------------
# 图像

def _linear(c: int) -> float:
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


LINEAR = [_linear(i) for i in range(256)]


def _encode(v: float) -> int:
    v = min(max(v, 0.0), 1.0)
    s = v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    return int(round(s * 255))


class Luma:
    """线性光亮度。分界线位置取两侧亮度的中点，与线性空间里的模糊无关。"""

    def __init__(self, path: str):
        image = Image.open(path).convert('RGB')
        self.width, self.height = image.size
        data = image.tobytes()
        self.values = [
            0.2126 * LINEAR[data[i]] + 0.7152 * LINEAR[data[i + 1]] + 0.0722 * LINEAR[data[i + 2]]
            for i in range(0, len(data), 3)
        ]

    def column(self, x: int, y0: int, y1: int) -> list[float]:
        y0, y1 = max(y0, 0), min(y1, self.height)
        return [self.values[y * self.width + x] for y in range(y0, y1)]


def crossings(values: list[float], y0: int, direction: int, threshold: float) -> list[tuple[float, float]]:
    """亮度穿过阈值的位置（像素中心为 y+0.5，线性插值到亚像素）与该处梯度。

    direction 为 -1 表示向下由亮变暗，+1 表示由暗变亮，0 表示不限。
    """
    found = []
    for i in range(len(values) - 1):
        a, b = values[i], values[i + 1]
        if a == b or (a - threshold) * (b - threshold) > 0:
            continue
        if direction and (b - a) * direction < 0:
            continue
        t = (threshold - a) / (b - a)
        found.append((y0 + i + 0.5 + t, abs(b - a)))
    return found


def levels(values: list[float]) -> tuple[float, float]:
    ordered = sorted(values)
    lo = ordered[int(0.1 * (len(ordered) - 1))]
    hi = ordered[int(0.9 * (len(ordered) - 1))]
    return lo, hi


# ---------------------------------------------------------------------------
# 测量

def detect_boundary(luma: Luma, rect: RoundRect, gap: float, band: float) -> tuple[Line, int]:
    """在玻璃左右两侧的背景列里找分界线，拟合成直线。返回直线与亮度变化方向。"""
    xs = []
    for start, end in ((rect.x - gap - band, rect.x - gap), (rect.x + rect.w + gap, rect.x + rect.w + gap + band)):
        xs.extend(x for x in range(int(start), int(end)) if 0 <= x < luma.width)
    if len(xs) < 4:
        raise SystemExit('玻璃两侧没有足够的背景列，请用 --boundary 指定分界线')
    y0 = int(rect.y - rect.h)
    y1 = int(rect.y + 2 * rect.h)
    points = []
    directions = []
    for x in xs:
        values = luma.column(x, y0, y1)
        lo, hi = levels(values)
        if hi - lo < 0.02:
            continue
        found = crossings(values, max(y0, 0), 0, (lo + hi) / 2)
        if not found:
            continue
        y, _ = max(found, key=lambda item: item[1])
        i = int(y - max(y0, 0) - 0.5)
        directions.append(1 if values[min(i + 1, len(values) - 1)] > values[i] else -1)
        points.append((x + 0.5, y))
    if len(points) < 4:
        raise SystemExit('背景列里找不到分界线，请用 --boundary 指定')
    line = fit_line(points)
    # 去掉偏离超过 2 像素的列（玻璃阴影、其他图形），重新拟合。
    kept = [p for p in points if abs(p[1] - line.y(p[0])) < 2.0]
    if len(kept) >= 4:
        line = fit_line(kept)
    direction = 1 if sum(directions) > 0 else -1
    return line, direction


def fit_line(points: list[tuple[float, float]]) -> Line:
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points)
    slope = sxy / sxx if sxx else 0.0
    return Line(slope, my - slope * mx)


def boundary_direction(luma: Luma, line: Line, rect: RoundRect) -> int:
    """手工指定分界线时，从玻璃外侧判断上下哪边更亮。"""
    votes = 0
    for x in (rect.x - rect.short * 0.4, rect.x + rect.w + rect.short * 0.4):
        xi = int(x)
        if not 0 <= xi < luma.width:
            continue
        y = line.y(xi + 0.5)
        above, below = int(y - 6), int(y + 6)
        if 0 <= above and below < luma.height:
            votes += 1 if luma.values[below * luma.width + xi] > luma.values[above * luma.width + xi] else -1
    return 1 if votes > 0 else -1


def measure(luma: Luma, rect: RoundRect, line: Line, direction: int, *, inset: float, step: float,
            min_ny: float, pick: str, min_contrast: float, contrast_ratio: float) -> list[dict[str, float | str]]:
    samples: list[dict[str, float | str]] = []
    x = rect.x + 0.5
    while x < rect.x + rect.w:
        span = rect.span(x, inset)
        if span is None:
            x += step
            continue
        xi = int(x)
        y0, y1 = int(math.ceil(span[0] - 0.5)), int(math.floor(span[1] - 0.5)) + 1
        values = luma.column(xi, y0, y1)
        if len(values) < 3:
            x += step
            continue
        lo, hi = levels(values)
        if hi - lo < min_contrast:
            x += step
            continue
        y_true = line.y(xi + 0.5)
        found = crossings(values, y0, direction, (lo + hi) / 2)
        if not found:
            x += step
            continue
        if pick == 'strongest':
            y_obs, _ = max(found, key=lambda item: item[1])
        else:
            y_obs, _ = min(found, key=lambda item: abs(item[0] - y_true))
        dist, nx, ny = rect.sdf(xi + 0.5, y_obs)
        d = -dist
        shift: float | str = ''
        across = ny - line.slope * nx
        if abs(across) / math.hypot(1.0, line.slope) >= min_ny:
            shift = (y_obs - y_true) / across
        samples.append({
            'x': xi + 0.5,
            'y_obs': y_obs,
            'y_true': y_true,
            'dy': y_obs - y_true,
            'd': d,
            'd_short': d / rect.short,
            'nx': nx,
            'ny': ny,
            'shift': shift,
            'shift_short': shift / rect.short if shift != '' else '',
            'contrast': hi - lo,
            'crossings': len(found),
        })
        x += step
    # 端部的短列只包含过渡的一部分，两侧亮度没到位，阈值会偏。按对比度剔除。
    if samples:
        typical = statistics.median(float(s['contrast']) for s in samples)
        samples = [s for s in samples if float(s['contrast']) >= contrast_ratio * typical]
    return samples


def bin_curve(samples: list[dict], short: float, width: float) -> list[dict[str, float]]:
    groups: dict[int, list[tuple[float, float]]] = {}
    for s in samples:
        if s['shift'] == '' or s['d'] < 0:
            continue
        groups.setdefault(int(s['d'] // width), []).append((s['d'], s['shift']))
    curve = []
    for key in sorted(groups):
        items = groups[key]
        shifts = [item[1] for item in items]
        d = statistics.fmean(item[0] for item in items)
        median = statistics.median(shifts)
        curve.append({
            'd': d,
            'd_short': d / short,
            'shift': median,
            'shift_short': median / short,
            'shift_min': min(shifts),
            'shift_max': max(shifts),
            'n': len(items),
        })
    return curve


def fit_profile(curve: list[dict[str, float]]) -> dict[str, float] | None:
    """拟合 shift(d) = A · max(0, 1 − d/W)^p + C，网格搜索 W 与 p，A、C 用最小二乘。"""
    points = [(c['d'], c['shift'], c['n']) for c in curve]
    if len(points) < 4:
        return None
    dmax = max(p[0] for p in points)
    best = None
    w = 2.0
    while w <= dmax * 1.5 + 2:
        p = 0.5
        while p <= 8.0 + 1e-9:
            basis = [max(0.0, 1 - d / w) ** p for d, _, _ in points]
            sw = sum(n for _, _, n in points)
            sb = sum(b * n for b, (_, _, n) in zip(basis, points))
            sbb = sum(b * b * n for b, (_, _, n) in zip(basis, points))
            sy = sum(y * n for _, y, n in points)
            sby = sum(b * y * n for b, (_, y, n) in zip(basis, points))
            det = sbb * sw - sb * sb
            if abs(det) > 1e-9:
                a = (sby * sw - sb * sy) / det
                c = (sy - a * sb) / sw
                err = sum(n * (a * b + c - y) ** 2 for b, (_, y, n) in zip(basis, points)) / sw
                if best is None or err < best[0]:
                    best = (err, a, w, p, c)
            p += 0.1
        w += 0.5
    if best is None:
        return None
    err, a, w, p, c = best
    return {'amp': a, 'width': w, 'power': p, 'offset': c, 'rms': math.sqrt(err),
            'band90': w * (1 - 0.1 ** (1 / p))}


def write_csv(path: str | None, rows: list[dict], fields: list[str]) -> None:
    stream = open(path, 'w', newline='') if path and path != '-' else sys.stdout
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
    writer.writeheader()
    for row in rows:
        writer.writerow({k: (f'{v:.4f}' if isinstance(v, float) else v) for k, v in row.items()})
    if stream is not sys.stdout:
        stream.close()


SAMPLE_FIELDS = ['x', 'y_obs', 'y_true', 'dy', 'd', 'd_short', 'nx', 'ny', 'shift', 'shift_short', 'contrast', 'crossings']
CURVE_FIELDS = ['d', 'd_short', 'shift', 'shift_short', 'shift_min', 'shift_max', 'n']


def parse_rect(text: str, scale: float, radius: float | None) -> RoundRect:
    parts = [float(v) for v in text.replace(' ', ',').split(',') if v]
    if len(parts) != 4:
        raise SystemExit('--rect 需要 x,y,宽,高')
    x, y, w, h = (v * scale for v in parts)
    return RoundRect(x, y, w, h, None if radius is None else radius * scale)


def apply_page(args: argparse.Namespace) -> None:
    """从 reference-shot.mjs 写下的 JSON 补全轮廓、圆角、分界线与倍率，命令行显式给出的优先。"""
    with open(args.page, encoding='utf-8') as stream:
        page = json.load(stream)
    outline = page['outlines'][0]
    if args.rect is None:
        args.rect = f"{outline['x']},{outline['y']},{outline['width']},{outline['height']}"
    if args.radius is None:
        args.radius = outline['radius']
    if args.scale is None:
        args.scale = page.get('dpr', 1)
    boundary = page.get('boundary')
    if args.boundary is None and boundary:
        args.boundary = f"{boundary['x']},{boundary['y']},{boundary['angle']}"


def run_measure(args: argparse.Namespace) -> dict:
    if getattr(args, 'page', None):
        apply_page(args)
    if args.rect is None:
        raise SystemExit('需要 --rect 或 --page')
    args.scale = 1.0 if args.scale is None else args.scale
    args.boundary = args.boundary or 'auto'
    luma = Luma(args.image)
    rect = parse_rect(args.rect, args.scale, args.radius)
    if args.boundary == 'auto':
        line, direction = detect_boundary(luma, rect, rect.short * args.gap, rect.short * args.band)
    else:
        parts = [float(v) for v in args.boundary.split(',')]
        if len(parts) == 1:
            line = Line(0.0, parts[0] * args.scale)
        elif len(parts) == 3:
            line = Line.through(parts[0] * args.scale, parts[1] * args.scale, parts[2])
        else:
            raise SystemExit('--boundary 取 auto、y 或 x,y,角度')
        direction = boundary_direction(luma, line, rect)
    if abs(line.angle()) > 60:
        raise SystemExit(f'分界线角度 {line.angle():.1f}° 接近竖直，竖直扫描线无法测量')
    samples = measure(luma, rect, line, direction, inset=args.inset, step=args.step,
                      min_ny=args.min_ny, pick=args.pick, min_contrast=args.min_contrast,
                      contrast_ratio=args.contrast_ratio)
    curve = bin_curve(samples, rect.short, args.bin)
    fit = fit_profile(curve)
    write_csv(args.out, samples, SAMPLE_FIELDS)
    if args.curve:
        write_csv(args.curve, curve, CURVE_FIELDS)
    report = {
        'rect': (rect.x, rect.y, rect.w, rect.h, rect.r),
        'boundary': (line.slope, line.offset, line.angle()),
        'samples': len(samples),
        'curve': curve,
        'fit': fit,
    }
    log = sys.stderr
    print(f'轮廓 x={rect.x:g} y={rect.y:g} 宽={rect.w:g} 高={rect.h:g} 圆角={rect.r:g}，短边 {rect.short:g}', file=log)
    print(f'分界线 y = {line.slope:.4f}·x + {line.offset:.2f}（{line.angle():.2f}°），'
          f'{"上暗下亮" if direction > 0 else "上亮下暗"}', file=log)
    print(f'有效列 {len(samples)}，曲线点 {len(curve)}', file=log)
    if curve:
        peak = max(curve, key=lambda c: abs(c['shift']))
        print(f'最大位移 {peak["shift"]:.2f} px（短边的 {peak["shift_short"] * 100:.1f}%），'
              f'位于 d={peak["d"]:.1f} px', file=log)
    if fit:
        print(f'拟合 shift = {fit["amp"]:.2f}·(1 − d/{fit["width"]:.1f})^{fit["power"]:.1f} + {fit["offset"]:.2f}，'
              f'rms {fit["rms"]:.2f} px', file=log)
        print(f'弯折带（位移降到 10%）{fit["band90"]:.1f} px = 短边的 {fit["band90"] / rect.short * 100:.1f}%，'
              f'边缘位移 = 短边的 {(fit["amp"] + fit["offset"]) / rect.short * 100:.1f}%', file=log)
    return report


# ---------------------------------------------------------------------------
# 合成测试图

def profile(d: float, amp: float, width: float, power: float) -> float:
    return amp * max(0.0, 1 - d / width) ** power if d >= 0 else amp


def synth(path: str, *, size=(900, 520), rect=(210, 140, 480, 240), radius=None, boundary_y=212.0, angle=0.0,
          amp=14.0, width=40.0, power=2.5, edge=3.0, truth: str | None = None) -> RoundRect:
    """两色背景 + 已知剖面的位移场。玻璃内加一点白色染色和 1.5 像素的边缘高光，检验测量的稳健性。

    分界线在线性光里用 edge 像素宽的线性过渡（相当于轻微模糊），中点仍在直线上。
    过渡太窄时逐像素取样会把交点量化到整像素，与真实截图（带模糊、带抗锯齿）不符。
    """
    w, h = size
    glass = RoundRect(*rect, radius)
    line = Line.through(w / 2, boundary_y, angle)
    light = [LINEAR[c] for c in (238, 241, 244)]
    dark = [LINEAR[c] for c in (38, 44, 54)]

    def source(px: float, py: float) -> list[float]:
        t = min(max(0.5 + line.signed(px, py) / edge, 0.0), 1.0)
        return [a + (b - a) * t for a, b in zip(light, dark)]

    pixels = []
    for y in range(h):
        for x in range(w):
            px, py = x + 0.5, y + 0.5
            back = source(px, py)
            dist, nx, ny = glass.sdf(px, py)
            coverage = min(max(0.5 - dist, 0.0), 1.0)
            if coverage <= 0:
                pixels.append(tuple(_encode(v) for v in back))
                continue
            s = profile(-dist, amp, width, power)
            seen = source(px - s * nx, py - s * ny)
            seen = [v * 0.92 + 0.08 for v in seen]
            if -dist < 1.5:
                seen = [min(v + 0.25, 1.0) for v in seen]
            mixed = [b + (g - b) * coverage for b, g in zip(back, seen)]
            pixels.append(tuple(_encode(v) for v in mixed))
    image = Image.new('RGB', size)
    image.putdata(pixels)
    image.save(path)
    if truth:
        rows = []
        d = 0.0
        while d <= glass.short / 2:
            rows.append({'d': d, 'd_short': d / glass.short, 'shift': profile(d, amp, width, power),
                         'shift_short': profile(d, amp, width, power) / glass.short})
            d += 1.0
        write_csv(truth, rows, ['d', 'd_short', 'shift', 'shift_short'])
    return glass


def run_selftest() -> int:
    cases = [
        {'angle': 0.0, 'boundary_y': 212.0},
        {'angle': 8.0, 'boundary_y': 215.0},
    ]
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        for i, case in enumerate(cases):
            amp, width, power = 14.0, 40.0, 2.5
            path = os.path.join(tmp, f'synth-{i}.png')
            glass = synth(path, amp=amp, width=width, power=power, **case)
            args = argparse.Namespace(
                image=path, rect=f'{glass.x},{glass.y},{glass.w},{glass.h}', scale=1.0, radius=None,
                boundary='auto', gap=0.1, band=0.2, inset=2.0, step=1.0, min_ny=0.3, pick='nearest',
                min_contrast=0.05, contrast_ratio=0.8, bin=1.0, out=os.path.join(tmp, 'samples.csv'), curve=None)
            report = run_measure(args)
            errors = [abs(c['shift'] - profile(c['d'], amp, width, power)) for c in report['curve']]
            worst = max(errors) if errors else math.inf
            fit = report['fit'] or {}
            angle_error = abs(report['boundary'][2] - case['angle'])
            passed = (worst < 0.5 and angle_error < 0.2 and len(errors) >= 30
                      and abs(fit.get('amp', 0) + fit.get('offset', 0) - amp) < 1.0
                      and abs(fit.get('width', 0) - width) < 4.0)
            print(f'用例 {i}（分界线 {case["angle"]}°）：曲线点 {len(errors)}，最大误差 {worst:.3f} px，'
                  f'拟合 A+C={fit.get("amp", 0) + fit.get("offset", 0):.2f}（真值 {amp}），'
                  f'W={fit.get("width", 0):.1f}（真值 {width}），p={fit.get("power", 0):.1f}（真值 {power}）'
                  f' → {"通过" if passed else "失败"}')
            ok = ok and passed
    print('自检通过' if ok else '自检失败')
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)

    m = sub.add_parser('measure', help='从截图测量剖面')
    m.add_argument('image')
    m.add_argument('--page', help='reference-shot.mjs 写下的 JSON，提供轮廓、圆角、分界线与倍率')
    m.add_argument('--rect', help='玻璃轮廓 x,y,宽,高（与 --scale 相乘后为图像像素）')
    m.add_argument('--radius', type=float, help='圆角半径，缺省为短边一半（胶囊、圆形）')
    m.add_argument('--scale', type=float, help='CSS 像素到图像像素的倍率，例如截图倍率 2，缺省 1')
    m.add_argument('--boundary', help='auto（缺省，从玻璃两侧的背景检测）、y、或 x,y,角度（度，顺时针为正）')
    m.add_argument('--gap', type=float, default=0.25, help='自动检测时跳过玻璃外侧多远（短边的倍数，避开阴影）')
    m.add_argument('--band', type=float, default=0.25, help='自动检测时使用的背景列宽度（短边的倍数）')
    m.add_argument('--inset', type=float, default=2.0, help='忽略轮廓内这么多像素（边缘高光与抗锯齿）')
    m.add_argument('--step', type=float, default=1.0, help='扫描线间隔（像素）')
    m.add_argument('--min-ny', type=float, default=0.3, help='法线在分界线法向上的分量低于它时不换算 shift')
    m.add_argument('--min-contrast', type=float, default=0.05, help='列内亮度对比低于它时跳过（线性亮度）')
    m.add_argument('--contrast-ratio', type=float, default=0.8,
                   help='列内对比度低于所有列中位数的这个比例时剔除（端部只含半个过渡的短列）')
    m.add_argument('--pick', choices=['nearest', 'strongest'], default='nearest',
                   help='一列有多个交点时取离真实分界线最近的，或梯度最大的')
    m.add_argument('--bin', type=float, default=1.0, help='曲线分组宽度（像素）')
    m.add_argument('--out', default='-', help='逐列样本 CSV，缺省输出到标准输出')
    m.add_argument('--curve', help='分组后的曲线 CSV')

    s = sub.add_parser('synth', help='生成已知剖面的合成测试图')
    s.add_argument('image')
    s.add_argument('--truth', help='真值曲线 CSV')
    s.add_argument('--amp', type=float, default=14.0)
    s.add_argument('--width', type=float, default=40.0)
    s.add_argument('--power', type=float, default=2.5)
    s.add_argument('--angle', type=float, default=0.0)
    s.add_argument('--boundary-y', type=float, default=212.0)
    s.add_argument('--edge', type=float, default=3.0, help='分界线过渡宽度（像素）')

    sub.add_parser('selftest', help='合成测试图上还原已知曲线')

    args = parser.parse_args()
    if args.command == 'measure':
        run_measure(args)
        return 0
    if args.command == 'synth':
        glass = synth(args.image, amp=args.amp, width=args.width, power=args.power, angle=args.angle,
                      boundary_y=args.boundary_y, edge=args.edge, truth=args.truth)
        print(f'--rect {glass.x:g},{glass.y:g},{glass.w:g},{glass.h:g}', file=sys.stderr)
        return 0
    return run_selftest()


if __name__ == '__main__':
    sys.exit(main())
