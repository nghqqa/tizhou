# -*- coding: utf-8 -*-
"""benchmark 引擎运行器：把 benchmark-pages.json 的页面跑过指定引擎。

用法：
  python run_engine.py A <run-name>      # 生产现状：RapidOCR 200DPI（与 ocr-worker.py 一致）
  python run_engine.py A-structured <run-name>[:仅限 pageId,pageId]  # RapidDoc 结构化逐页

产物（易变）写入 TIZHU_EXP_DIR（缺省 E:/tizhou-ocr-bank/exp）/runs/<run-name>/：
  pages.json   每页原始输出（行级 bbox 文本置信度 / 结构化 regions）
  summary.json 每页字符数/耗时等（供报告引用；不进仓库）

本脚本不改生产代码、不动应用 venv 之外的任何环境。
"""
from __future__ import annotations


import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium

sys.path.insert(0, str(Path(__file__).resolve().parent))
from winmem import peak_rss_mb  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
PROD_DPI = 200  # 生产 ocr-worker.py 的 RENDER_DPI


def load_pages(filter_ids: set[str] | None = None,
               types: set[str] | None = None) -> list[dict]:
    manifest = json.loads((BENCH / 'benchmark-pages.json').read_text(encoding='utf-8'))
    pages = manifest['pages']
    if filter_ids:
        pages = [p for p in pages if p['pageId'] in filter_ids]
    if types:
        pages = [p for p in pages if p['autoType'] in types]
    return pages


def render_page(doc, page_index: int, dpi: int):
    page = doc[page_index]
    bitmap = page.render(scale=dpi / 72)
    return np.asarray(bitmap.to_pil().convert('RGB'))


def run_plain(pages: list[dict], out_dir: Path) -> None:
    from rapidocr import RapidOCR
    engine = RapidOCR()
    results = []
    for entry in pages:
        doc = pdfium.PdfDocument(entry['relPath'])
        try:
            started = time.perf_counter()
            image = render_page(doc, entry['page'] - 1, PROD_DPI)
            height = int(image.shape[0])
            result = engine(image)
            elapsed = time.perf_counter() - started
        finally:
            doc.close()
        lines = []
        if result is not None and result.txts is not None:
            for text, box, score in zip(result.txts, result.boxes, result.scores):
                ys = [float(p[1]) for p in box]
                lines.append({'text': str(text).strip(), 'top': round(min(ys), 1),
                              'bottom': round(max(ys), 1), 'score': round(float(score), 4)})
        results.append({
            'pageId': entry['pageId'], 'file': entry['file'], 'page': entry['page'],
            'autoType': entry['autoType'], 'dpi': PROD_DPI,
            'chars': sum(len(l['text']) for l in lines),
            'avgScore': round(sum(l['score'] for l in lines) / len(lines), 4) if lines else 0,
            'timeMs': int(elapsed * 1000),
            'lines': lines, 'pageHeight': height,
        })
        print(f"[A] {entry['pageId']} chars={results[-1]['chars']} {elapsed:.1f}s", flush=True)
    (out_dir / 'pages.json').write_text(
        json.dumps({'engine': 'rapidocr-200dpi', 'peakRssMb': peak_rss_mb(),
                    'pages': results}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


def run_structured(pages: list[dict], out_dir: Path) -> None:
    from rapid_doc.main import RapidDoc
    from rapid_doc.data.data_reader_writer import FileBasedDataWriter
    tmp_dir = out_dir / '_rapiddoc-tmp'
    tmp_dir.mkdir(parents=True, exist_ok=True)
    doc_engine = RapidDoc(table_enable=True, formula_enable=False, lang='ch',
                          output_dir=str(tmp_dir),
                          md_writer=FileBasedDataWriter(str(tmp_dir)),
                          image_writer=FileBasedDataWriter(str(tmp_dir / 'images')))
    results = []
    by_pdf: dict[str, list[dict]] = {}
    for entry in pages:
        by_pdf.setdefault(entry['relPath'], []).append(entry)
    for rel, entries in by_pdf.items():
        for entry in entries:
            page_index = entry['page'] - 1
            started = time.perf_counter()
            output = doc_engine(rel, start_page_id=page_index, end_page_id=page_index)
            elapsed = time.perf_counter() - started
            regions = []
            blocks = getattr(output, 'content_list_json', None)
            if isinstance(blocks, list):
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    regions.append({
                        'type': str(block.get('type') or 'text'),
                        'bbox': [round(float(v)) for v in (block.get('bbox') or [])
                                 if isinstance(v, (int, float))],
                        'imgPath': str(block.get('img_path') or ''),
                        'text': str(block.get('text') or ''),
                    })
            markdown = str(getattr(output, 'markdown', '') or '')
            results.append({
                'pageId': entry['pageId'], 'file': entry['file'], 'page': entry['page'],
                'autoType': entry['autoType'], 'chars': len(markdown),
                'regionCount': len(regions),
                'tableRegions': sum(1 for r in regions if r['type'] == 'table'),
                'imageRegions': sum(1 for r in regions if r['type'] == 'image'),
                'timeMs': int(elapsed * 1000),
                'markdown': markdown, 'regions': regions,
            })
            print(f"[A-structured] {entry['pageId']} regions={len(regions)} "
                  f"{elapsed:.1f}s", flush=True)
    (out_dir / 'pages.json').write_text(
        json.dumps({'engine': 'rapid-doc-0.9.10-structured', 'peakRssMb': peak_rss_mb(),
                    'pages': results}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 1
    mode, run_name = sys.argv[1], sys.argv[2]
    filter_ids: set[str] | None = None
    if ':' in run_name:
        run_name, ids = run_name.split(':', 1)
        filter_ids = {x.strip() for x in ids.split(',') if x.strip()}
    out_dir = EXP_DIR / 'runs' / run_name
    out_dir.mkdir(parents=True, exist_ok=True)
    if mode == 'A':
        run_plain(load_pages(filter_ids), out_dir)
    elif mode == 'A-structured':
        types = {'资料分析', '图形推理候选'} if filter_ids is None else None
        run_structured(load_pages(filter_ids, types), out_dir)
    else:
        print(f'未知模式 {mode}', file=sys.stderr)
        return 1
    print(json.dumps({'done': run_name, 'outDir': str(out_dir)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
