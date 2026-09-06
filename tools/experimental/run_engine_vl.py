# -*- coding: utf-8 -*-
"""可选评估：PaddleOCR-VL（0.9B VLM）单机 CPU 探针。

记录：模型下载体积、初始化时间、峰值内存、每页耗时、输出样例。
用法：python run_engine_vl.py <页数上限，默认2>
产物：TIZHU_EXP_DIR/runs/engineVL-vl/pages.json
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from winmem import peak_rss_mb  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
MODEL_DIR = Path.home() / '.paddlex'


def main() -> int:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    manifest = json.loads((BENCH / 'benchmark-pages.json').read_text(encoding='utf-8'))
    # 每类型第 1 页：资料分析 + 图形推理候选
    picked: list[dict] = []
    for kind in ('资料分析', '图形推理候选'):
        picked.append(next(p for p in manifest['pages'] if p['autoType'] == kind))
    picked = picked[:limit]

    # paddle 3.0.0 + 关 PIR（同 run_engine_b 的兼容处理）
    os.environ.setdefault('FLAGS_enable_pir_api', '0')
    os.environ.setdefault('FLAGS_enable_pir_in_executor', '0')
    from paddleocr import PaddleOCRVL

    started = time.perf_counter()
    pipeline = PaddleOCRVL(device='cpu')
    init_secs = time.perf_counter() - started
    model_bytes = sum(p.stat().st_size for p in MODEL_DIR.rglob('*') if p.is_file())
    print(f'init {init_secs:.1f}s, paddlex models {model_bytes / 1e9:.2f}GB', flush=True)

    out_dir = EXP_DIR / 'runs' / 'engineVL-vl'
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for entry in picked:
        doc = pdfium.PdfDocument(entry['relPath'])
        try:
            page = doc[entry['page'] - 1]
            bitmap = page.render(scale=200 / 72)
            image = np.asarray(bitmap.to_pil().convert('RGB'))
        finally:
            doc.close()
        started = time.perf_counter()
        error = ''
        markdown = ''
        layout_count = 0
        try:
            output = pipeline.predict(image)
            for res in output:
                md = res.markdown
                markdown = str(md) if md else ''
                layout = getattr(res, 'layout_det_res', None)
                if layout is not None:
                    boxes = layout.get('boxes', []) if isinstance(layout, dict) \
                        else getattr(layout, 'boxes', [])
                    layout_count = len(boxes)
        except Exception as exc:
            error = f'{type(exc).__name__}: {str(exc)[:300]}'
        elapsed = time.perf_counter() - started
        results.append({
            'pageId': entry['pageId'], 'file': entry['file'], 'page': entry['page'],
            'autoType': entry['autoType'], 'chars': len(markdown),
            'layoutCount': layout_count, 'timeMs': int(elapsed * 1000),
            'error': error, 'markdown': markdown[:20000],
        })
        print(f"[VL] {entry['pageId']} md={len(markdown)} {elapsed:.1f}s {error[:80]}",
              flush=True)
    (out_dir / 'pages.json').write_text(json.dumps({
        'engine': 'paddleocr-PaddleOCRVL-0.9B-cpu',
        'initSecs': round(init_secs, 1),
        'paddlexModelsGb': round(model_bytes / 1e9, 2),
        'peakRssMb': peak_rss_mb(),
        'pages': results,
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({'done': 'engineVL-vl', 'pages': len(results)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
