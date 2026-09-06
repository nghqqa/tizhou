# -*- coding: utf-8 -*-
"""阶段3 方案C：MinerU（pipeline 后端）作为 PDF 结构解析对照。

独立 venv（mineru 3.4.5 / torch 2.14 CPU）。CLI 不支持按页清单跑，因此
把 benchmark 选中的页面用 pypdfium2 抽成单页 PDF 小文件再交给 mineru，
保证「同一批页面」三方案可比。
用法：
  python run_engine_c.py <run-name> [类型过滤,逗号分隔] [--limit N]
产物：TIZHU_EXP_DIR/runs/<run-name>/pages.json + 每页 mineru 原始 markdown
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
MINERU_ENV = Path(os.environ.get('TIZHU_MINERU_ENV', 'E:/tizhou-ocr-bank/venv-mineru'))
MINERU_BIN = MINERU_ENV / 'Scripts' / 'mineru.exe'


def run_mineru(pdf_path: Path, out_dir: Path) -> tuple[float, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    proc = subprocess.run(
        [str(MINERU_BIN), '-p', str(pdf_path), '-o', str(out_dir),
         '-b', 'pipeline', '-m', 'ocr', '-l', 'ch'],
        capture_output=True, text=True, timeout=600, env=os.environ)
    elapsed = time.perf_counter() - started
    if proc.returncode != 0:
        raise RuntimeError(f'mineru rc={proc.returncode}: {proc.stderr[-400:]}')
    md_files = sorted(out_dir.rglob('*.md'))
    text = md_files[-1].read_text(encoding='utf-8') if md_files else ''
    return elapsed, text


def main() -> int:
    run_name = sys.argv[1]
    types = set(sys.argv[2].split(',')) if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else None
    limit = None
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])

    manifest = json.loads((BENCH / 'benchmark-pages.json').read_text(encoding='utf-8'))
    pages = manifest['pages']
    if types:
        pages = [p for p in pages if p['autoType'] in types]
    # 每类型取前若干页，MinerU 单页开销大，做对照即可
    by_type: dict[str, list[dict]] = {}
    for p in pages:
        by_type.setdefault(p['autoType'], []).append(p)
    selected: list[dict] = []
    for kind, entries in sorted(by_type.items()):
        selected.extend(entries[:limit if limit else 4])
    selected.sort(key=lambda p: p['pageId'])

    out_dir = EXP_DIR / 'runs' / run_name
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    work = Path(tempfile.mkdtemp(prefix='mineru-pages-'))
    for entry in selected:
        single = work / f"{entry['pageId']}.pdf"
        doc = pdfium.PdfDocument(entry['relPath'])
        try:
            new = pdfium.PdfDocument.new()
            new.import_pages(doc, pages=[entry['page'] - 1])
            new.save(str(single))
        finally:
            doc.close()
        try:
            elapsed, markdown = run_mineru(single, out_dir / 'raw' / entry['pageId'])
            error = ''
        except Exception as exc:
            elapsed, markdown = 0.0, ''
            error = f'{type(exc).__name__}: {str(exc)[:300]}'
        results.append({
            'pageId': entry['pageId'], 'file': entry['file'], 'page': entry['page'],
            'autoType': entry['autoType'],
            'chars': len(markdown),
            'tableCount': len(re.findall(r'<table', markdown, re.I)),
            'imageRefs': len(re.findall(r'!\[\]\(', markdown)),
            'timeMs': int(elapsed * 1000),
            'error': error,
            'markdown': markdown[:30000],
        })
        print(f"[C] {entry['pageId']} md={results[-1]['chars']} "
              f"tables={results[-1]['tableCount']} {elapsed:.1f}s {error[:80]}",
              flush=True)
        (out_dir / 'pages.json').write_text(
            json.dumps({'engine': 'mineru-3.4.5-pipeline-cpu',
                        'pages': results}, ensure_ascii=False, indent=1) + '\n',
            encoding='utf-8')
    print(json.dumps({'done': run_name, 'pages': len(results)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
