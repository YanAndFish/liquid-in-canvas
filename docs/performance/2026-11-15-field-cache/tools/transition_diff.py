"""比较 transition.mjs 录下的两段过程：每一帧与对照光路在同一滚动位置的画面相差多少，以及静止期间相邻两帧变了多少。

用法: python3 transition_diff.py <被测目录> <对照目录> [阈值=2]

- “与对照的差”：同一滚动位置上，被测帧与对照帧相差超过阈值的像素数与最大差值。对照取那个位置上最后一帧。
- “与上一帧的差”：滚动位置没有变的相邻两帧之间的变化，也就是切换时肉眼能看到的跳变；滚动中的帧不统计。
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

test_dir, ref_dir = Path(sys.argv[1]), Path(sys.argv[2])
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 2


def load(directory):
    info = json.loads((directory / 'frames.json').read_text())
    return info, info['frames']


def image(directory, frame):
    return np.asarray(Image.open(directory / frame['file']).convert('RGB'), dtype=np.int16)


test_info, test_frames = load(test_dir)
_, ref_frames = load(ref_dir)
reference = {}
for frame in ref_frames:
    reference[frame['top']] = frame
marks = test_info['marks']
print(f"{'帧':>3}{'时间':>7}{'位置':>6}  {'阶段':<6}{'与对照的差':>12}{'最大':>5}{'与上一帧的差':>14}{'最大':>5}")
previous = None
previous_top = None
worst_step = (0, 0)
for index, frame in enumerate(test_frames):
    current = image(test_dir, frame)
    time = frame['time'] - marks['start']
    if frame['time'] <= marks['stop']:
        phase = '滚动'
    elif frame['time'] <= marks['resume']:
        phase = '停下'
    elif frame['time'] <= marks['end']:
        phase = '再滚动'
    else:
        phase = '再停下'
    against = ''
    against_max = ''
    if frame['top'] in reference:
        delta = np.abs(current - image(ref_dir, reference[frame['top']])).max(axis=2)
        against = str(int((delta > limit).sum()))
        against_max = str(int(delta.max()))
    step = ''
    step_max = ''
    if previous is not None and previous_top == frame['top']:
        delta = np.abs(current - previous).max(axis=2)
        step = str(int((delta > limit).sum()))
        step_max = str(int(delta.max()))
        if int(delta.max()) > worst_step[0]:
            worst_step = (int(delta.max()), int((delta > limit).sum()))
    print(f"{index:>3}{time:>7.0f}{frame['top']:>6.0f}  {phase:<6}{against:>12}{against_max:>5}{step:>14}{step_max:>5}")
    previous = current
    previous_top = frame['top']
print(f'静止期间相邻两帧的最大变化: {worst_step[0]} 级（{worst_step[1]} 个像素超过 {limit} 级）')
