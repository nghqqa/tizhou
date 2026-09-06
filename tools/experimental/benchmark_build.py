# -*- coding: utf-8 -*-
"""阶段2：最小 benchmark 构建（确定性抽样，重跑不产生 diff）。

从 inventory.json 的 42 个真实 PDF 中，按（册类型 × 科目）分层、固定随机种子
抽取约 100 页；用文字层/图片对象信号做页面级粗分类；生成：
  docs/ocr-benchmark/benchmark-pages.json   —— 固定页面清单（提交入库）
  docs/ocr-benchmark/page-stats.json        —— 逐页文字层/图片信号（审计用）
  docs/ocr-benchmark/annotation-template.csv —— 人工标注模板（自动填可自动的部分）

不含任何时间戳字段，抽样只依赖 inventory 内容 + SEED，保证幂等。
"""
from __future__ import annotations

import csv
import hashlib
import json
import random
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / 'docs' / 'ocr-benchmark'
SEED = 20260906
TEXT_LAYER_MIN_CHARS = 50

# 目标构成（约100页）：按 benchmark 需要的题型覆盖分配
STRATA_TARGETS = [
    # (booklet, subject, pages)  —— 题本优先取「含图/表格信号」页
    ('题本', '资料分析', 20),
    ('解析册', '资料分析', 10),
    ('题本', '判断推理', 20),  # 判断推理含图形推理页
    ('题本', '数量关系', 8),
    ('题本', '言语理解', 12),  # 片段阅读归类为言语理解
    ('题本', '申论', 6),
    ('解析册', '数量关系', 6),
    ('解析册', '判断推理', 6),
    ('解析册', '言语理解', 6),
    ('解析册', '申论', 4),
]

QNO_RE = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)\s*\S', re.M)


def sha16(data: str) -> str:
    return hashlib.sha256(data.encode('utf-8')).hexdigest()[:16]


def page_signals(doc, index: int) -> dict:
    page = doc[index]
    try:
        text_page = page.get_textpage()
        text = text_page.get_text_range()
        text = text.strip() if isinstance(text, str) else ''
    except Exception:
        text = ''
    images = 0
    try:
        for obj in page.get_objects(max_depth=4):
            if obj.type == 3:
                images += 1
    except Exception:
        images = -1
    qnos = sorted({int(m) for m in QNO_RE.findall(text)})
    return {'chars': len(text), 'images': images, 'qnosTextLayer': qnos[:40]}


def auto_page_type(signals: dict, booklet: str, subject: str) -> str:
    """无 OCR 的页面粗分类（供抽样配额与人工标注参考，最终以人工标注为准）。"""
    if signals['chars'] < 5 and signals['images'] <= 0:
        return 'blank-or-cover'
    if booklet == '解析册':
        return '解析'
    if subject == '资料分析':
        return '资料分析'
    if subject == '判断推理' and signals['images'] >= 3:
        return '图形推理候选'
    if subject == '判断推理' and signals['images'] > 0:
        return '图形推理候选'
    return '普通文字'


def main() -> int:
    inventory_path = OUT_DIR / 'inventory.json'
    if not inventory_path.is_file():
        print('请先运行 survey_pdfs.py', file=sys.stderr)
        return 1
    inventory = json.loads(inventory_path.read_text(encoding='utf-8'))
    entries = inventory['entries']
    inv_ref = sha16(inventory_path.read_text(encoding='utf-8'))

    # 逐页信号缓存（确定性）
    per_pdf: dict[str, tuple[Path, list[dict]]] = {}
    for e in entries:
        path = Path(e['relPath'])
        doc = pdfium.PdfDocument(str(path))
        try:
            signals = [page_signals(doc, i) for i in range(e['pages'])]
        finally:
            doc.close()
        per_pdf[e['relPath']] = (path, signals)

    page_stats = {
        'inventoryRef': inv_ref,
        'seed': SEED,
        'pdfs': {
            rel: {
                'pages': len(sig),
                'signals': [{k: s[k] for k in ('chars', 'images')} for s in sig],
            }
            for rel, (_, sig) in per_pdf.items()
        },
    }
    # 紧凑序列化：审计数据体积可控（确定性不受影响）
    (OUT_DIR / 'page-stats.json').write_text(
        json.dumps(page_stats, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8'
    )

    rng = random.Random(SEED)
    selected: list[dict] = []
    for booklet, subject, want in STRATA_TARGETS:
        candidates: list[tuple[str, int, dict]] = []
        for e in entries:
            if e['booklet'] != booklet or e['subject'] != subject:
                continue
            _, signals = per_pdf[e['relPath']]
            for page_index, sig in enumerate(signals):
                candidates.append((e['relPath'], page_index, sig))
        # 排除空白页（保留少量给「其他」类型），再固定种子抽样
        non_blank = [c for c in candidates if c[2]['chars'] >= 5 or c[2]['images'] > 0]
        picks = rng.sample(non_blank, min(want, len(non_blank)))
        for rel, page_index, sig in picks:
            e = next(x for x in entries if x['relPath'] == rel)
            selected.append({
                'pageId': f"{sha16(rel)[:8]}-p{page_index + 1:04d}",
                'file': e['file'],
                'relPath': rel,
                'page': page_index + 1,
                'booklet': booklet,
                'subject': subject,
                'autoType': auto_page_type(sig, booklet, subject),
                'chars': sig['chars'],
                'images': sig['images'],
                'qnosTextLayer': sig['qnosTextLayer'],
            })
    # 少量空白/封面页（真实题本存在的版式）
    blanks: list[tuple[str, int, dict]] = []
    for rel, (_, signals) in per_pdf.items():
        for page_index, sig in enumerate(signals):
            if sig['chars'] < 5 and sig['images'] <= 0:
                blanks.append((rel, page_index, sig))
    for rel, page_index, _sig in rng.sample(blanks, min(4, len(blanks))):
        e = next(x for x in entries if x['relPath'] == rel)
        selected.append({
            'pageId': f"{sha16(rel)[:8]}-p{page_index + 1:04d}",
            'file': e['file'], 'relPath': rel, 'page': page_index + 1,
            'booklet': e['booklet'], 'subject': e['subject'],
            'autoType': 'blank-or-cover', 'chars': 0, 'images': 0, 'qnosTextLayer': [],
        })
    selected.sort(key=lambda s: (s['relPath'], s['page']))

    manifest = {
        'version': 1,
        'inventoryRef': inv_ref,
        'seed': SEED,
        'pageCount': len(selected),
        'strataTargets': STRATA_TARGETS,
        'pages': selected,
    }
    (OUT_DIR / 'benchmark-pages.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8'
    )

    # 人工标注模板：自动列尽量填好，人工列留空
    header = [
        'page_id', 'file', 'page', 'auto_type', 'booklet', 'subject',
        'qnos_in_text_layer(自动)', 'expected_qnos(人工必填)',
        'expected_stem_chars(人工)', 'stem_truncated(人工:0/1)',
        'expected_options(人工:如A4B4C4D4或0)', 'option_text_ok(人工:0/1/待)',
        'numbers_to_verify(人工:抄3-5个原书数字)', 'table_rows_cols(人工:如6x5或0)',
        'image_options(人工:题干图数+A-D或0)', 'answer_expected(人工)',
        'notes(人工)',
    ]
    rows = []
    for s in selected:
        rows.append([
            s['pageId'], s['file'], s['page'], s['autoType'], s['booklet'], s['subject'],
            ' '.join(map(str, s['qnosTextLayer'])) if s['qnosTextLayer'] else '', '', '', '', '',
            '', '', '', '', '', '',
        ])
    with (OUT_DIR / 'annotation-template.csv').open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)

    by_type: dict[str, int] = {}
    for s in selected:
        by_type[s['autoType']] = by_type.get(s['autoType'], 0) + 1
    print(json.dumps({'pageCount': len(selected), 'byAutoType': by_type}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
