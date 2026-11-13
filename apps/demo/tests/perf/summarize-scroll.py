"""检查往返滚动记录，并汇总各版本多轮耗时的中位数和范围。"""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def distribution(values):
    """返回中位数、最小值、最大值与全部样本。"""
    return {
        "median": statistics.median(values),
        "min": min(values),
        "max": max(values),
        "values": values,
    }


def report(path):
    """拒绝错误、滚动不足或混用 GPU 诊断模式的记录，再按版本汇总。"""
    rows = json.loads(path.read_text())
    assert rows, f"{path}: 没有测量记录"
    groups = defaultdict(list)
    first = rows[0]
    for row in rows:
        assert row["comparable"] and not row["errors"], f"{path}: 存在无效记录"
        assert row["draw"]["count"] >= 30, f"{path}: 绘制次数不足"
        assert row["elapsed"] >= 7900, f"{path}: 测量时间不足"
        assert row["distance"] > 0, f"{path}: 页面没有可滚动范围"
        assert row["maxScroll"] >= row["distance"] * 0.95, f"{path}: 滚动范围不足"
        assert row["viewport"] == first["viewport"], f"{path}: 视口发生变化"
        assert row["distance"] == first["distance"], f"{path}: 滚动距离发生变化"
        assert row["gpuDiagnostic"] == first["gpuDiagnostic"], f"{path}: 混用了 GPU 诊断模式"
        if row["gpuDiagnostic"]:
            assert row["gpu"]["count"] > 0, f"{path}: 没有 GPU 时间样本"
        groups[row["version"]].append(row)
    result = {}
    for version, samples in groups.items():
        result[version] = {
            "runs": len(samples),
            "enoughRunsForComparison": len(samples) >= 5,
            "drawMeanMs": distribution([r["draw"]["mean"] for r in samples]),
            "animationMeanMs": distribution([r["animationInterval"]["mean"] for r in samples]),
            "animationP95Ms": distribution([r["animationInterval"]["p95"] for r in samples]),
            "longAnimationFrames": distribution([r["longAnimationFrames"] for r in samples]),
        }
        if first["gpuDiagnostic"]:
            result[version]["gpuMeanMs"] = distribution([r["gpu"]["mean"] for r in samples])
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tests/perf/summarize-scroll.py <滚动记录.json> [更多文件]")
    print(json.dumps({name: report(Path(name)) for name in sys.argv[1:]}, ensure_ascii=False, indent=2))
