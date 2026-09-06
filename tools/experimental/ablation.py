# -*- coding: utf-8 -*-
"""阶段二·六：消融实验运行器。

阶梯式开关（每级只多开一项优化），在 Golden Set 指定集合上运行：
  c1_base200   200 DPI 裸基线（对齐生产 RENDER_DPI）
  c2_dpi300    300 DPI
  c3_deskew    +去倾斜
  c4_clahe     +对比度增强
  c5_adaptive  +自适应 DPI 局部重识别
  c6_regionocr +表格区域级 OCR
  c7_reading   +阅读顺序（分栏 + 题号锚点硬边界）
  c8_watermark +跨页重复水印剥离
  c9_multican  +多预处理候选选优

产物：TIZHU_EXP_DIR/exp-worker2/ablation/<config>/pages.json（含 config 与耗时内存）
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
ABLATION_DIR = EXP_DIR / 'exp-worker2' / 'ablation'

LADDER: list[tuple[str, dict]] = [
    ('c1_base200', {'dpi': 200}),
    ('c2_dpi300', {'dpi': 300}),
    ('c3_deskew', {'dpi': 300, 'deskew': 1}),
    ('c4_clahe', {'dpi': 300, 'deskew': 1, 'clahe': 1}),
    ('c5_adaptive', {'dpi': 300, 'deskew': 1, 'clahe': 1, 'adaptive': 1}),
    ('c6_regionocr', {'dpi': 300, 'deskew': 1, 'clahe': 1, 'adaptive': 1, 'region_ocr': 1}),
    ('c7_reading', {'dpi': 300, 'deskew': 1, 'clahe': 1, 'adaptive': 1, 'region_ocr': 1,
                    'reading_order': 1}),
    ('c8_watermark', {'dpi': 300, 'deskew': 1, 'clahe': 1, 'adaptive': 1, 'region_ocr': 1,
                      'reading_order': 1, 'watermark': 1}),
    ('c9_multican', {'dpi': 300, 'deskew': 1, 'clahe': 1, 'adaptive': 1, 'region_ocr': 1,
                     'reading_order': 1, 'watermark': 1, 'multicandidate': 1}),
]


def main() -> int:
    set_name = sys.argv[1] if len(sys.argv) > 1 else 'tuning'
    only = sys.argv[2] if len(sys.argv) > 2 else None
    py = sys.executable
    results = []
    ABLATION_DIR.mkdir(parents=True, exist_ok=True)
    for name, config in LADDER:
        if only and not name.startswith(only):
            continue
        cfg_text = ','.join(f'{k}={v}' for k, v in config.items())
        started = time.perf_counter()
        proc = subprocess.run(
            [py, str(REPO_ROOT / 'tools' / 'experimental' / 'exp_worker2.py'),
             'run', set_name, name, '--config', cfg_text],
            capture_output=True, text=True, timeout=3600)
        elapsed = time.perf_counter() - started
        if proc.returncode != 0:
            print(json.dumps({'config': name, 'error': proc.stderr[-400:]},
                             ensure_ascii=False))
            results.append({'config': name, 'error': proc.stderr[-200:]})
            continue
        pages_file = EXP_DIR / 'exp-worker2' / 'runs' / name / 'pages.json'
        data = json.loads(pages_file.read_text(encoding='utf-8'))
        results.append({
            'config': name, 'configDict': config,
            'pages': len(data['pages']),
            'medianMsPerPage': int(__import__('statistics').median(
                [p['timeMs'] for p in data['pages']])) if data['pages'] else None,
            'peakRssMb': data.get('peakRssMb'),
            'wallSec': round(elapsed, 1),
        })
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    (ABLATION_DIR / 'ablation-summary.json').write_text(
        json.dumps({'set': set_name, 'results': results}, ensure_ascii=False,
                   indent=1, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps({'done': len(results)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
