# -*- coding: utf-8 -*-
"""阶段1：真实样本清单（只读，不修改原 PDF）。

统计每个 PDF：页数、逐页文字层字符数、扫描页比例、每页图片对象数、页面尺寸；
按文件名把题本归类为：普通文字 / 资料分析 / 解析册 / 图形推理(含) 等类别。

输出（确定性，重跑不产生 diff）：
  docs/ocr-benchmark/inventory.json
  docs/ocr-benchmark/inventory.md

用法：
  python tools/experimental/survey_pdfs.py [样本目录]
样本目录缺省取环境变量 TIZHU_SAMPLE_DIR，再缺省 E:/BaiduNetdiskDownload/考公刷题本答案。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium

DEFAULT_SAMPLE_DIR = r'E:/BaiduNetdiskDownload/考公刷题本答案'
REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / 'docs' / 'ocr-benchmark'

TEXT_LAYER_MIN_CHARS = 50  # 与生产 ocr-worker.py 一致的扫描页判定

# 文件级分类：按文件名（题本），与其配套解析册另行标注
SUBJECT_RULES = [
    ('资料分析', '资料分析'),
    ('数量关系', '数量关系'),
    ('判断推理', '判断推理'),
    ('逻辑判断', '判断推理'),
    ('片段阅读', '言语理解'),
    ('言语理解', '言语理解'),
    ('申论', '申论'),
]
BOOKLET_RULES = [
    ('参考答案', '解析册'),
    ('解析', '解析册'),
    ('答案', '解析册'),
    ('题本', '题本'),
]


def classify_book(name: str) -> tuple[str, str]:
    """返回 (册类型, 科目)。"""
    booklet = '题本'
    for needle, kind in BOOKLET_RULES:
        if needle in name:
            booklet = kind
            break
    subject = '综合'
    for needle, subj in SUBJECT_RULES:
        if needle in name:
            subject = subj
            break
    return booklet, subject


def page_image_objects(page) -> int:
    """统计页面图片对象数（图形推理/图表页的强信号）。"""
    count = 0
    try:
        for obj in page.get_objects(max_depth=4):
            if obj.type == 3:  # FPDF_PAGEOBJ_IMAGE
                count += 1
    except Exception:
        count = -1
    return count


def survey_pdf(path: Path) -> dict:
    doc = pdfium.PdfDocument(str(path))
    try:
        total = len(doc)
        page_chars: list[int] = []
        page_images: list[int] = []
        widths: set[tuple[int, int]] = set()
        for index in range(total):
            page = doc[index]
            try:
                text_page = page.get_textpage()
                text = text_page.get_text_range()
                chars = len(text.strip()) if isinstance(text, str) else 0
            except Exception:
                chars = 0
            page_chars.append(chars)
            page_images.append(page_image_objects(page))
            try:
                w, h = page.get_size()
                widths.add((round(w), round(h)))
            except Exception:
                pass
        scan_pages = sum(1 for c in page_chars if c < TEXT_LAYER_MIN_CHARS)
        booklet, subject = classify_book(path.stem)
        return {
            'file': path.name,
            'relPath': str(path).replace('\\', '/'),
            'booklet': booklet,
            'subject': subject,
            'pages': total,
            'textLayerPages': total - scan_pages,
            'scanPages': scan_pages,
            'scanPageRatio': round(scan_pages / total, 3) if total else 0,
            'totalTextChars': int(sum(page_chars)),
            'avgCharsPerPage': round(sum(page_chars) / total, 1) if total else 0,
            'pagesWithImages': sum(1 for n in page_images if n > 0),
            'maxImagesPerPage': max(page_images) if page_images else 0,
            'pageSizes': sorted(f'{w}x{h}' for w, h in widths),
        }
    finally:
        doc.close()


def main() -> int:
    sample_dir = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get('TIZHU_SAMPLE_DIR', DEFAULT_SAMPLE_DIR))
    if not sample_dir.is_dir():
        print(f'样本目录不存在: {sample_dir}', file=sys.stderr)
        return 1
    pdfs = sorted(sample_dir.rglob('*.pdf'), key=lambda p: str(p).replace('\\', '/'))
    entries = [survey_pdf(pdf) for pdf in pdfs]

    summary = {
        'generatedBy': 'tools/experimental/survey_pdfs.py',
        'sampleDir': str(sample_dir).replace('\\', '/'),
        'pdfCount': len(entries),
        'totalPages': sum(e['pages'] for e in entries),
        'totalScanPages': sum(e['scanPages'] for e in entries),
        'scanPageRatioOverall': round(
            sum(e['scanPages'] for e in entries) / max(1, sum(e['pages'] for e in entries)), 3
        ),
        'byBooklet': {},
        'bySubject': {},
        'entries': entries,
    }
    for booklet in sorted({e['booklet'] for e in entries}):
        group = [e for e in entries if e['booklet'] == booklet]
        summary['byBooklet'][booklet] = {
            'files': len(group),
            'pages': sum(e['pages'] for e in group),
            'scanPageRatio': round(
                sum(e['scanPages'] for e in group) / max(1, sum(e['pages'] for e in group)), 3
            ),
        }
    for subject in sorted({e['subject'] for e in entries}):
        group = [e for e in entries if e['subject'] == subject]
        summary['bySubject'][subject] = {
            'files': len(group),
            'pages': sum(e['pages'] for e in group),
        }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / 'inventory.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )

    lines = [
        '# 真实样本清单（阶段1）',
        '',
        f"- 样本目录：`{summary['sampleDir']}`",
        f"- PDF 数：{summary['pdfCount']}；总页数：{summary['totalPages']}；"
        f"扫描页占比：{summary['scanPageRatioOverall']:.1%}"
        '（扫描页 = 文字层字符 < 50，与生产判定一致）',
        '',
        '| 册类型 | 文件数 | 页数 | 扫描页占比 |',
        '| --- | --- | --- | --- |',
    ]
    for booklet, stat in sorted(summary['byBooklet'].items()):
        lines.append(
            f"| {booklet} | {stat['files']} | {stat['pages']} | {stat['scanPageRatio']:.1%} |"
        )
    lines += ['', '| 科目 | 文件数 | 页数 |', '| --- | --- | --- |']
    for subject, stat in sorted(summary['bySubject'].items()):
        lines.append(f"| {subject} | {stat['files']} | {stat['pages']} |")
    lines += [
        '',
        '## 逐文件清单',
        '',
        '| 文件 | 册 | 科目 | 页数 | 文字层页 | 扫描页 | 平均字符/页 | 含图页 | 单页最多图 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    for e in entries:
        lines.append(
            f"| {e['file']} | {e['booklet']} | {e['subject']} | {e['pages']} | "
            f"{e['textLayerPages']} | {e['scanPages']} | {e['avgCharsPerPage']} | "
            f"{e['pagesWithImages']} | {e['maxImagesPerPage']} |"
        )
    lines.append('')
    (OUT_DIR / 'inventory.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps({'pdfCount': summary['pdfCount'], 'totalPages': summary['totalPages'],
                      'scanPageRatioOverall': summary['scanPageRatioOverall']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
