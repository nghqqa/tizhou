# -*- coding: utf-8 -*-
"""阶段8：真实样本回归测试（实验性 worker）。

用 benchmark 固定清单中每种页面类型的前几页跑实验 worker，证明：
  1) 无静默丢题：原始 OCR 行中的一切题号、选项标记都必须出现在分区输出里
     （行数守恒 + 题号集合守恒 + 选项标记守恒）；
  2) 图形推理：无法可靠绑定时必须 manualReview=true 且不产出任何选项标签，
     绝不转成纯文本题；
  3) 资料分析：图表数字流不拼入正文，保留裁剪与告警；
  4) 解析配对：低置信度配对标记「配对待确认」，答案只来自解析册，
     题干不被答案反向修正。

运行（需要本机有样本目录与应用 venv）：
  <应用venv python> tools/experimental/tests/test_regression.py
样本不在本机时整组跳过。
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'experimental'))

import pypdfium2 as pdfium  # noqa: E402

from exp_worker import (  # noqa: E402
    close_doc,
    extract_tuitui,
    is_number_stream,
    pair_solutions,
    process_page,
)
from winmem import peak_rss_mb  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
QNO = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)')
OPTION = re.compile(r'(?:^|\s)([A-D])\s*[.、．]\s*\S')

PAGES_PER_TYPE = 2


def load_manifest():
    manifest_path = BENCH / 'benchmark-pages.json'
    if not manifest_path.is_file():
        return None
    return json.loads(manifest_path.read_text(encoding='utf-8'))


def pick_pages(manifest, per_type: int = PAGES_PER_TYPE):
    """确定性选取：每种类型按 pageId 排序取前 per_type 页（blank 取 1 页）。"""
    by_type: dict[str, list[dict]] = {}
    for page in manifest['pages']:
        by_type.setdefault(page['autoType'], []).append(page)
    picked = []
    for kind, pages in sorted(by_type.items()):
        pages = sorted(pages, key=lambda p: p['pageId'])
        picked.extend(pages[:1 if kind == 'blank-or-cover' else per_type])
    return picked


def partition_texts(page_json: dict) -> tuple[list[str], int]:
    """worker 输出中所有承接 OCR 文本的位置。"""
    texts: list[str] = []
    for region in page_json['regions']:
        if region['type'] == 'text' and region.get('text'):
            texts.extend(region['text'].split('\n'))
    texts.extend(cell['text'] for cell in page_json.get('tableCells', []))
    texts.extend(label['text'] for label in page_json.get('chartLabels', []))
    return texts, len(page_json.get('rawLines', []))


class SilentLossInvariantTests(unittest.TestCase):
    """核心不变量：原始 OCR 行进入输出后，行数/题号/选项标记一个都不许少。"""

    @classmethod
    def setUpClass(cls):
        manifest = load_manifest()
        if manifest is None or not Path(manifest['pages'][0]['relPath']).is_file():
            raise unittest.SkipTest('真实样本或 benchmark 清单不在本机')
        from exp_worker import load_engine
        cls.engine = load_engine()
        cls.out_dir = Path(tempfile.mkdtemp(prefix='tizhou-regression-'))
        cls.processed = []
        for entry in pick_pages(manifest):
            doc = pdfium.PdfDocument(entry['relPath'])
            try:
                page_json = process_page(cls.engine, doc, entry['page'] - 1,
                                         cls.out_dir, entry['pageId'], dpi=300)
            finally:
                close_doc(doc)
            page_json['autoType'] = entry['autoType']
            cls.processed.append(page_json)

    def test_line_count_conserved(self):
        """每一行 OCR 输出都必须落到正文/表格单元格/图表标签三者之一。"""
        for page in self.processed:
            texts, raw_count = partition_texts(page)
            non_empty = [t for t in texts if t.strip()]
            self.assertEqual(
                len(non_empty), raw_count,
                f"page {page['page']}: {raw_count} 行原始 OCR 只剩 {len(non_empty)} 行")

    def test_question_numbers_never_dropped(self):
        """原始 OCR 行中的题号必须全部出现在最终输出里（无静默丢题）。"""
        for page in self.processed:
            raw_qnos = {int(QNO.match(l['text']).group(1))
                        for l in page.get('rawLines', []) if QNO.match(l['text'])}
            texts, _ = partition_texts(page)
            out_qnos = {int(QNO.match(t).group(1)) for t in texts if QNO.match(t)}
            missing = raw_qnos - out_qnos
            self.assertEqual(
                missing, set(),
                f"page {page['page']}: 题号 {sorted(missing)} 在输出中丢失")

    def test_option_marks_never_dropped(self):
        """A-D 选项标记在输出中不得比原始 OCR 行少。"""
        for page in self.processed:
            raw_marks = sum(len(OPTION.findall(l['text']))
                            for l in page.get('rawLines', []))
            texts, _ = partition_texts(page)
            out_marks = sum(len(OPTION.findall(t)) for t in texts)
            self.assertGreaterEqual(
                out_marks, raw_marks,
                f"page {page['page']}: 选项标记 {raw_marks}→{out_marks} 发生丢失")

    def test_number_stream_not_merged_into_prose(self):
        """图表数字流不允许拼进普通正文（资料分析隔离原则）。"""
        for page in self.processed:
            for region in page['regions']:
                if region['type'] == 'text' and region.get('text'):
                    for line in region['text'].split('\n'):
                        self.assertFalse(
                            is_number_stream(line),
                            f"page {page['page']}: 数字流混入正文: {line[:50]}")


class GraphicModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = load_manifest()
        if manifest is None or not Path(manifest['pages'][0]['relPath']).is_file():
            raise unittest.SkipTest('真实样本或 benchmark 清单不在本机')
        from exp_worker import load_engine
        cls.engine = load_engine()
        cls.out_dir = Path(tempfile.mkdtemp(prefix='tizhou-regression-graphic-'))
        cls.graphics = []
        picked = [p for p in pick_pages(manifest) if p['autoType'] == '图形推理候选']
        for entry in picked:
            doc = pdfium.PdfDocument(entry['relPath'])
            try:
                page_json = process_page(cls.engine, doc, entry['page'] - 1,
                                         cls.out_dir, entry['pageId'], dpi=300)
            finally:
                close_doc(doc)
            cls.graphics.append(extract_tuitui(page_json, cls.out_dir, entry['pageId']))

    def test_never_fabricates_option_labels(self):
        """绑不齐 4 图必须人工审核，且此时不得产出任何 A-D 标签。"""
        self.assertTrue(self.graphics, '没有取到图形推理候选页')
        for result in self.graphics:
            if result['manualReview']:
                self.assertEqual(
                    result['options'], [],
                    '人工审核页不允许自动绑定选项标签')
            else:
                self.assertEqual(len(result['options']), 4)
                self.assertEqual([o['key'] for o in result['options']],
                                 ['A', 'B', 'C', 'D'])
                for option in result['options']:
                    self.assertGreater(option['bindingConfidence'], 0)

    def test_output_is_image_question_never_plain_text(self):
        """图推输出必须是图片题形态（保留题干图或选项图），不得转纯文本。"""
        for result in self.graphics:
            if result['stemImages'] or result['options']:
                self.assertEqual(result['questionType'], 'graphic-image')
            if result['manualReview']:
                self.assertIn('人工审核', result['note'])


class PairingTests(unittest.TestCase):
    """配对规则单元测试（合成用例，确定性）。"""

    def setUp(self):
        self.booklet = [
            {'set': 1, 'num': 1, 'order': 0, 'page': 1,
             'stem': '2022年我国东部地区省内流动农民工人数约为多少万人', 'options': []},
            {'set': 1, 'num': 2, 'order': 1, 'page': 1,
             'stem': '2021年我国本地农民工和外出农民工之比约为', 'options': []},
            {'set': 1, 'num': 3, 'order': 2, 'page': 2,
             'stem': '完全无法匹配到解析的题干内容', 'options': []},
        ]
        self.solutions = [
            {'set': 1, 'num': 2, 'order': 0, 'page': 1,
             'stemExcerpt': '2021年我国本地农民工和外出农民工之比约为', 'answer': 'B'},
            {'set': 1, 'num': 1, 'order': 1, 'page': 1,
             'stemExcerpt': '2022年我国东部地区省内流动农民工人数约为多少万人', 'answer': 'C'},
        ]

    def test_exact_key_pairing(self):
        result = pair_solutions(self.booklet, self.solutions)
        pairs = {p['num']: p for p in result['pairs']}
        self.assertEqual(pairs[1]['status'], 'paired')
        self.assertEqual(pairs[1]['answer'], 'C')
        self.assertTrue(pairs[1]['byKey'])

    def test_unmatchable_marked_pending_review(self):
        result = pair_solutions(self.booklet, self.solutions)
        pairs = {p['num']: p for p in result['pairs']}
        self.assertEqual(pairs[3]['status'], '配对待确认')
        self.assertEqual(pairs[3]['answer'], '')

    def test_answer_letters_only_from_solution(self):
        """答案字段只允许来自解析册；没有解析的题答案必须为空。"""
        result = pair_solutions(self.booklet, self.solutions)
        for pair in result['pairs']:
            if pair['status'] != 'paired':
                self.assertEqual(pair['answer'], '')
        self.assertTrue(result['summary']['answerLettersFromSolutionOnly'])

    def test_answer_grid_pairing(self):
        """四海系范围答案格（无题干摘录）：钥匙一致+顺序接近才发布。"""
        booklet = [
            {'set': 1, 'num': i + 1, 'order': i, 'page': 1, 'stem': f'题{i + 1}干', 'options': []}
            for i in range(5)
        ]
        grid = [
            {'kind': 'grid', 'set': 1, 'num': i + 1, 'order': i, 'page': 6,
             'stemExcerpt': '', 'answer': 'DACDD'[i], 'ambiguous': False, 'explanation': ''}
            for i in range(5)
        ]
        result = pair_solutions(booklet, grid)
        self.assertEqual(result['summary']['paired'], 5)
        self.assertEqual([p['answer'] for p in result['pairs']], list('DACDD'))

    def test_answer_grid_order_mismatch_goes_pending(self):
        """答案格顺序与题本顺序偏离（OCR 误号嫌疑）→ 配对待确认。"""
        booklet = [{'set': 1, 'num': 1, 'order': 0, 'page': 1, 'stem': '题干', 'options': []}]
        grid = [{'kind': 'grid', 'set': 1, 'num': 1, 'order': 40, 'page': 6,
                 'stemExcerpt': '', 'answer': 'A', 'ambiguous': False, 'explanation': ''}]
        result = pair_solutions(booklet, grid)
        self.assertEqual(result['pairs'][0]['status'], '配对待确认')
        self.assertEqual(result['pairs'][0]['answer'], '')

    def test_answer_grid_ambiguous_letters_goes_pending(self):
        """答案格字母数与题数不一致（如「15-20CBDCB」误号）→ 不得自动发布。"""
        booklet = [{'set': 1, 'num': 5, 'order': 4, 'page': 1, 'stem': '题干', 'options': []}]
        grid = [{'kind': 'grid', 'set': 1, 'num': 5, 'order': 4, 'page': 6,
                 'stemExcerpt': '', 'answer': '', 'ambiguous': True, 'explanation': ''}]
        result = pair_solutions(booklet, grid)
        self.assertEqual(result['pairs'][0]['status'], '配对待确认')

    def test_order_fallback_never_creates_fake_answer(self):
        """题号对不上时，靠顺序+相似度也只能给出低置信度标记。"""
        booklet = [{'set': 1, 'num': 9, 'order': 0, 'page': 3,
                    'stem': '2021年我国本地农民工和外出农民工之比约为', 'options': []}]
        solutions = [{'set': 1, 'num': 2, 'order': 0, 'page': 1,
                      'stemExcerpt': '2021年我国本地农民工和外出农民工之比约为',
                      'answer': 'B'}]
        result = pair_solutions(booklet, solutions)
        pair = result['pairs'][0]
        self.assertIn(pair['status'], ('paired', '配对待确认', '缺答案-配对待确认'))
        if not pair['byKey']:
            self.assertLess(pair['confidence'], 0.45)


class ResourceLedgerTests(unittest.TestCase):
    def test_worker_pages_within_time_budget(self):
        """记录单页资源开销（回归基线：300DPI 全管线 ≤ 8s/页）。"""
        manifest = load_manifest()
        if manifest is None or not Path(manifest['pages'][0]['relPath']).is_file():
            self.skipTest('真实样本不在本机')
        from exp_worker import load_engine
        engine = load_engine()
        entry = sorted(manifest['pages'], key=lambda p: p['pageId'])[0]
        with tempfile.TemporaryDirectory(prefix='tizhou-res-') as tmp:
            doc = pdfium.PdfDocument(entry['relPath'])
            try:
                page_json = process_page(engine, doc, entry['page'] - 1,
                                         Path(tmp), entry['pageId'], dpi=300)
            finally:
                close_doc(doc)
        ledger = {
            'timeMs': page_json['timeMs'],
            'peakRssMb': peak_rss_mb(),
            'ocrLineCount': page_json['ocrLineCount'],
        }
        print(json.dumps({'resourceLedger': ledger}, ensure_ascii=False))
        self.assertLess(page_json['timeMs'], 8000)


if __name__ == '__main__':
    unittest.main(verbosity=2)
