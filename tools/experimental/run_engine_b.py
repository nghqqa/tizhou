# -*- coding: utf-8 -*-
"""阶段3 方案B：PaddleOCR PP-StructureV3（paddleocr 3.7.0 / paddlepaddle 3.3.1 CPU）。

在独立 venv（TIZHU_EXP_DIR 同级的 venv-b）内运行，绝不进入生产链路。
用法：
  python run_engine_b.py <run-name> [类型过滤,逗号分隔] [--dpi 200] [--limit N]
产物：TIZHU_EXP_DIR/runs/<run-name>/pages.json（markdown/表格/版面区域逐页）
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


def main() -> int:
    run_name = sys.argv[1]
    types = set(sys.argv[2].split(',')) if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else None
    dpi = 200
    if '--dpi' in sys.argv:
        dpi = int(sys.argv[sys.argv.index('--dpi') + 1])
    limit = None
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    # paddle 3.3.1 在 CPU 上默认启用 PIR 模式，PP-StructureV3 的部分算子
    # 未实现（ConvertPirAttribute2Run）；回退旧 IR 后可正常运行。
    os.environ.setdefault('FLAGS_enable_pir_api', '0')
    os.environ.setdefault('FLAGS_enable_pir_in_executor', '0')
    from paddleocr import PPStructureV3

    manifest = json.loads((BENCH / 'benchmark-pages.json').read_text(encoding='utf-8'))
    pages = manifest['pages']
    if types:
        pages = [p for p in pages if p['autoType'] in types]
    if limit:
        pages = pages[:limit]

    started = time.perf_counter()
    pipeline = PPStructureV3(device='cpu')
    init_secs = time.perf_counter() - started
    print(f'init {init_secs:.1f}s', flush=True)

    out_dir = EXP_DIR / 'runs' / run_name
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for entry in pages:
        doc = pdfium.PdfDocument(entry['relPath'])
        try:
            page = doc[entry['page'] - 1]
            bitmap = page.render(scale=dpi / 72)
            image = np.asarray(bitmap.to_pil().convert('RGB'))
        finally:
            doc.close()
        started = time.perf_counter()
        try:
            output = pipeline.predict(image)
            page_result = {'markdown': '', 'tables': [], 'layout': [], 'texts': []}
            for res in output:
                md = res.markdown
                page_result['markdown'] = str(md) if md else ''
                for table in (getattr(res, 'table_res_list', None) or []):
                    page_result['tables'].append({
                        'html': str(table.get('pred_html', '') if isinstance(table, dict)
                                    else getattr(table, 'table_body', ''))[:20000],
                        'bbox': [round(float(v), 1) for v in (
                            table.get('table_bbox', []) if isinstance(table, dict)
                            else getattr(table, 'table_bbox', []))]},
                    )
                layout = getattr(res, 'layout_det_res', None)
                if layout is not None:
                    boxes = layout.get('boxes', []) if isinstance(layout, dict) \
                        else getattr(layout, 'boxes', [])
                    for box in boxes:
                        page_result['layout'].append({
                            'label': str(box.get('label', '') if isinstance(box, dict)
                                         else getattr(box, 'label', '')),
                            'bbox': [round(float(v), 1) for v in (
                                box.get('coordinate', box.get('bbox', [])) if isinstance(box, dict)
                                else getattr(box, 'coordinate', []))],
                            'score': round(float(box.get('score', 0) if isinstance(box, dict)
                                                 else getattr(box, 'score', 0)), 4),
                        })
                parsing = getattr(res, 'parsing_res_list', None)
                if parsing:
                    for block in parsing:
                        page_result['texts'].append({
                            'type': str(getattr(block, 'block_label', '')),
                            'text': str(getattr(block, 'block_content', ''))[:4000],
                            'bbox': [round(float(v), 1)
                                     for v in (getattr(block, 'block_bbox', []) or [])],
                        })
            error = ''
        except Exception as exc:  # 单页失败不中断整批
            page_result = {'markdown': '', 'tables': [], 'layout': [], 'texts': []}
            error = f'{type(exc).__name__}: {exc}'
        elapsed = time.perf_counter() - started
        results.append({
            'pageId': entry['pageId'], 'file': entry['file'], 'page': entry['page'],
            'autoType': entry['autoType'],
            'chars': len(page_result['markdown']),
            'tableCount': len(page_result['tables']),
            'layoutCount': len(page_result['layout']),
            'timeMs': int(elapsed * 1000),
            'error': error,
            **page_result,
        })
        print(f"[B] {entry['pageId']} md={results[-1]['chars']} "
              f"tables={results[-1]['tableCount']} {elapsed:.1f}s {error[:60]}",
              flush=True)
        (out_dir / 'pages.json').write_text(
            json.dumps({'engine': 'paddleocr-PPStructureV3-3.7.0-cpu', 'dpi': dpi,
                        'initSecs': round(init_secs, 1), 'peakRssMb': peak_rss_mb(),
                        'pages': results}, ensure_ascii=False, indent=1) + '\n',
            encoding='utf-8')
    print(json.dumps({'done': run_name, 'pages': len(results)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
