"""读取浏览器测量结果，拒绝无效样本并汇总每个版本的中位数和范围。"""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def summarize(values):
    """汇总多轮结果，保留原始值供检查。"""
    return {"median": statistics.median(values), "min": min(values), "max": max(values), "values": values}


def report(path):
    """验证绘制或排序确实发生，再按版本汇总。"""
    rows = json.loads(path.read_text())
    groups = defaultdict(list)
    viewport = None
    order = None
    for row in rows:
        assert not row["errors"], f"{path}: 存在运行错误"
        assert row.get("comparable", True), f"{path}: 样本无效"
        if row.get("kind") == "content-sort":
            assert row["iterations"] >= 1000 and row["elements"] > 1, f"{path}: 排序工作量不足"
            assert row["mismatches"] == 0, f"{path}: 排序结果发生变化"
            order = order or row["order"]
            assert row["order"] == order, f"{path}: 两个版本的排序结果不一致"
        else:
            assert row["stagePresent"] and row["videoPlaying"], f"{path}: 画布或视频未运行"
            assert row["draw"]["count"] >= 30 and row["elapsed"] >= 7900, f"{path}: 绘制工作量不足"
            assert row["videoTime"][0] != row["videoTime"][1], f"{path}: 视频时间没有推进"
            viewport = viewport or row["viewport"]
            assert row["viewport"] == viewport, f"{path}: 视口发生变化"
        groups[row["variant"]].append(row)
    result = {}
    for variant, samples in groups.items():
        assert len(samples) >= 5, f"{path}: {variant} 少于五轮"
        if samples[0].get("kind") == "content-sort":
            result[variant] = {
                "sortMs": summarize([sample["mean"] for sample in samples]),
                "styleReads": summarize([sample["styleReads"] for sample in samples]),
            }
        else:
            result[variant] = {
                "drawMs": summarize([sample["draw"]["mean"] for sample in samples]),
                "paintIntervalMs": summarize([sample["paintInterval"]["mean"] for sample in samples]),
                "longAnimationFrames": summarize([sample["longAnimationFrames"] for sample in samples]),
            }
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tests/perf/summarize.py <测量结果.json> [更多文件]")
    print(json.dumps({name: report(Path(name)) for name in sys.argv[1:]}, ensure_ascii=False, indent=2))
