# -*- coding: utf-8 -*-
"""Golden Set OCR 预填（阶段二·一.6）。

把实验 worker 在 30 个 Golden 页上的输出转成标注 JSON：
  setStatus='pending'，annotator='ocr-prefill-v1'
  —— 预填永远不是 Ground Truth，必须经标注工具人工确认。

字段：题号/题干/选项/答案/解析（解析册）、数字 token、表格、图表 bbox、
水印/页眉/页脚区域。图推页只填题干图与选项图 bbox（来自版面分区），
不做任何图形内容猜测。

用法：<应用venv python> tools/experimental/prefill_golden.py
输出：docs/ocr-benchmark/golden/annotations/<pageId>.json（pending）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
ANNOT_DIR = BENCH / 'golden' / 'annotations'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))

QNO = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)\s*(.*)$')
OPTION = re.compile(r'^([A-D])\s*[.、．]?\s*(.*)$')
ANSWER_MARK = re.compile(r'【参考答案(?:及正确率)?】\s*([A-D]+)(?:[，,]\s*(\d{1,3})\s*%)?')
EXPLAIN_MARK = re.compile(r'【实战解析】')
ANSWER_RANGE = re.compile(r'^\s*(\d{1,3})\s*[-—~]\s*(\d{1,3})\s*[:：]?\s*([A-Da-d]{1,30})\s*$')
WATERMARK_PATTERNS = [
    re.compile(p) for p in (
        r'公考最新资料[、，]?\s*更新进度微信\S*', r'微信SKA\d+', r'公众号[：:]\S+',
        r'超格学员专用', r'资料分析600[贴折]', r'一手最全公考资源加微信\s*\S+',
        r'加微信\s*SYA\d+',
    )
]
DIGIT_TOKEN = re.compile(r'\d[\d,，]*(?:\.\d+)?[%％]?')


def all_lines(page: dict) -> list[dict]:
    """页面全部 OCR 行（含 bbox，300DPI 原始坐标）——与标注渲染同坐标系。"""
    lines = list(page.get('rawLines') or [])
    return lines


def build_questions(page: dict, page_type: str) -> list[dict]:
    """从正文分区解析题目（解析册按答案标记块，题本按题号+选项）。"""
    prose = next((r for r in page['regions'] if r['type'] == 'text'), None)
    if not prose:
        return []
    lines = prose['text'].split('\n')
    questions: list[dict] = []
    if page_type == '解析册':
        raw: list[dict] = []
        current = None
        grid_section = 0
        grid_expected_next: int | None = None
        for line in lines:
            grid = ANSWER_RANGE.match(line)
            if grid:
                start, end, letters = int(grid.group(1)), int(grid.group(2)), grid.group(3)
                if start == 1 or (grid_expected_next is not None
                                  and start - grid_expected_next >= 2):
                    grid_section += 1
                grid_expected_next = end + 1
                for offset in range(end - start + 1):
                    raw.append({'set': grid_section, 'num': start + offset,
                                'answer': letters[offset].upper() if offset < len(letters) else '',
                                'stemExcerpt': '', 'explanation': ''})
                current = None
                continue
            match = QNO.match(line)
            if match:
                if current:
                    raw.append(current)
                answer = ANSWER_MARK.search(line)
                current = {'set': 1, 'num': int(match.group(1)),
                           'stemExcerpt': match.group(2)[:80], 'answer': '',
                           'explanation': ''}
                if answer:
                    current['answer'] = answer.group(1)
                continue
            if current is None:
                continue
            mark = ANSWER_MARK.search(line)
            if mark:
                current['answer'] = mark.group(1)
            current['explanation'] += line + '\n'
        if current:
            raw.append(current)
        seen: set[tuple[int, int]] = set()
        deduped = []
        for q in raw:
            key = (q.get('set', 1), q['num'])
            if key in seen:
                continue  # OCR 误号导致的重号（如 16-20 误作 15-20）：预填保留首个
            seen.add(key)
            deduped.append(q)
        return [{
            'setNumber': q.get('set', 1), 'number': q['num'],
            'stem': q.get('stemExcerpt', ''), 'options': [], 'optionImages': [],
            'stemImages': [], 'answer': q.get('answer', ''),
            'explanation': q.get('explanation', '')[:2000],
        } for q in deduped]

    current = None
    for line in lines:
        match = QNO.match(line)
        if match:
            if current:
                questions.append(current)
            current = {'setNumber': 1, 'number': int(match.group(1)),
                       'stem': match.group(2)[:200], 'options': [],
                       'optionImages': [], 'stemImages': [], 'answer': '',
                       'explanation': ''}
            continue
        if current is None:
            continue
        opt = OPTION.match(line)
        if opt:
            key = opt.group(1)
            if all(o['key'] != key for o in current['options']):
                current['options'].append({'key': key, 'text': opt.group(2)[:200]})
        else:
            current['stem'] += line[:200]
    if current:
        questions.append(current)
    return questions


def build(page: dict, meta: dict) -> dict:
    page_type = meta['pageType']
    lines = all_lines(page)
    numbers: list[str] = []
    seen: set[str] = set()
    for line in lines:
        for token in DIGIT_TOKEN.findall(line['text']):
            token = token.replace('，', ',')
            if token not in seen:
                seen.add(token)
                numbers.append(token)

    watermarks = []
    header = footer = None
    height = page.get('pageHeight') or 0
    for line in lines:
        text = line['text']
        if any(p.search(text) for p in WATERMARK_PATTERNS) and len(text) <= 40:
            watermarks.append({'bbox': line['bbox'], 'text': text})
        if height and line['bbox'][3] < height * 0.08 and len(text) <= 40 and not header:
            header = {'bbox': line['bbox'], 'text': text}
        if height and line['bbox'][1] > height * 0.93 and len(text) <= 12 and \
                re.fullmatch(r'[–—-\s]*\d{1,3}[–—-\s]*', text):
            footer = {'bbox': line['bbox'], 'text': text}

    charts = [{'bbox': r['bbox'], 'kind': ''} for r in page['regions'] if r['type'] == 'figure']
    tables = []
    ziliao = page.get('ziliao') or {}
    if ziliao.get('tableCrop'):
        crop_bbox = next((r['bbox'] for r in page['regions']
                          if r['type'] == 'table'), None)
        if crop_bbox:
            tables.append({'bbox': crop_bbox,
                           'rows': [[c['text'] for c in row]
                                    for row in ziliao['table'].get('rows', [])]})

    tuitui = page.get('tuitui') or {}
    questions = build_questions(page, page_type)
    if page_type == '图形推理':
        for question in questions:
            question['stemImages'] = [{'bbox': s['bbox']}
                                      for s in tuitui.get('stemImages', [])]
            question['optionImages'] = [{'key': o.get('key'), 'bbox': o['bbox']}
                                        for o in tuitui.get('options', [])]
    return {
        'schemaVersion': 1,
        'pageId': page['pageId'],
        'pageNumber': meta['page'],
        'sourcePdf': meta['relPath'],
        'pageType': page_type,
        'setStatus': 'pending',
        'annotator': 'ocr-prefill-v1',
        'set': meta['set'],
        'questions': questions,
        'numbers': numbers[:200],
        'tables': tables,
        'charts': charts,
        'watermarks': watermarks,
        'header': header,
        'footer': footer,
        'notes': 'OCR 预填，未经人工确认，不得计入 Ground Truth',
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--out-dir', type=Path, default=ANNOT_DIR)
    parser.add_argument('--force', action='store_true',
                        help='覆盖已有标注；仅允许在人工标注开始前使用')
    args = parser.parse_args()
    golden = json.loads((BENCH / 'golden-set.json').read_text(encoding='utf-8'))
    exp = json.loads(
        (EXP_DIR / 'exp-worker/runs/expworker-300dpi/pages.json').read_text(encoding='utf-8'))
    exp_by_id = {p['pageId']: p for p in exp['pages']}
    args.out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    preserved = 0
    for meta in golden['pages']:
        page = exp_by_id.get(meta['pageId'])
        if page is None:
            print(f"缺少 expworker 输出: {meta['pageId']}", file=sys.stderr)
            continue
        data = build(page, meta)
        dest = args.out_dir / f"{meta['pageId']}.json"
        if dest.exists() and not args.force:
            preserved += 1
            continue
        dest.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + '\n',
                        encoding='utf-8')
        written += 1
    print(json.dumps({'prefilled': written, 'preserved': preserved}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
