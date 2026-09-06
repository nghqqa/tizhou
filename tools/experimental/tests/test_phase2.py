# -*- coding: utf-8 -*-
"""阶段二·八：Golden Set / 真实指标 / 确定性 测试。

运行：<应用venv python> tools/experimental/tests/test_phase2.py
golden-set.json 不在本机时相关用例自动跳过。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'experimental'))

from eval_real import (  # noqa: E402
    iou,
    lev,
    match_questions,
    norm_number,
    worker_questions,
)
from gt_schema import validate  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
GOLDEN = BENCH / 'golden-set.json'


def minimal_annotation(**overrides) -> dict:
    data = {
        'schemaVersion': 1,
        'pageId': 'test-p0001',
        'pageNumber': 1,
        'sourcePdf': 'E:/samples/book.pdf',
        'pageType': '普通文字',
        'setStatus': 'confirmed',
        'annotator': 'tester',
        'set': 'tuning',
        'questions': [],
        'numbers': [],
        'tables': [],
        'charts': [],
        'watermarks': [],
        'header': None,
        'footer': None,
        'notes': '',
    }
    data.update(overrides)
    return data


GOLDEN_PAGES = [{'pageId': 'test-p0001', 'page': 1,
                 'relPath': 'E:/samples/book.pdf', 'set': 'tuning'}]


class GtSchemaTests(unittest.TestCase):
    def test_valid_minimal_passes(self):
        self.assertEqual(validate(minimal_annotation(), GOLDEN_PAGES), [])

    def test_ocr_prefill_cannot_be_confirmed(self):
        errs = validate(minimal_annotation(annotator='ocr-prefill-v1'), GOLDEN_PAGES)
        self.assertTrue(any('confirmed' in e for e in errs))
        pending = validate(minimal_annotation(annotator='ocr-prefill-v1',
                                              setStatus='pending'), GOLDEN_PAGES)
        self.assertEqual(pending, [])

    def test_timestamp_fields_rejected(self):
        errs = validate(minimal_annotation(createdAt='2026-09-06'), GOLDEN_PAGES)
        self.assertTrue(any('时间戳' in e for e in errs))

    def test_bad_bbox_rejected(self):
        errs = validate(minimal_annotation(
            charts=[{'bbox': [100, 100, 100, 50], 'kind': ''}]), GOLDEN_PAGES)
        self.assertTrue(any('bbox' in e for e in errs))

    def test_duplicate_question_number_rejected(self):
        questions = [{'setNumber': 1, 'number': 5, 'stem': '', 'options': [],
                      'optionImages': [], 'stemImages': [], 'answer': '',
                      'explanation': ''}]
        errs = validate(minimal_annotation(questions=questions * 2), GOLDEN_PAGES)
        self.assertTrue(any('重复' in e for e in errs))
        # 不同套号下同题号合法（答案册多套同页）
        questions[0]['setNumber'] = 2
        errs2 = validate(minimal_annotation(questions=questions * 1 + [
            {**questions[0], 'setNumber': 1}]), GOLDEN_PAGES)
        self.assertFalse(any('重复' in e for e in errs2))


class GoldenSetIsolationTests(unittest.TestCase):
    def setUp(self):
        if not GOLDEN.is_file():
            self.skipTest('golden-set.json 不在本机')

    def test_set_sizes_and_type_quota(self):
        data = json.loads(GOLDEN.read_text(encoding='utf-8'))
        sets = data['sets']
        self.assertEqual(len(sets['tuning']), 18)
        self.assertEqual(len(sets['validation']), 6)
        self.assertEqual(len(sets['heldout']), 6)
        for page_type, want in (('普通文字', 6), ('资料分析表格', 6),
                                ('资料分析统计图', 6), ('解析册', 6), ('图形推理', 6)):
            count = sum(1 for p in data['pages'] if p['pageType'] == page_type)
            self.assertEqual(count, want, page_type)

    def test_pdf_disjoint_across_sets(self):
        data = json.loads(GOLDEN.read_text(encoding='utf-8'))
        pdf_sets: dict[str, set[str]] = {}
        for page in data['pages']:
            pdf_sets.setdefault(page['relPath'], set()).add(page['set'])
        for pdf, names in pdf_sets.items():
            self.assertEqual(len(names), 1, f'{pdf} 跨集合')

    def test_source_diversity_and_page_cap(self):
        data = json.loads(GOLDEN.read_text(encoding='utf-8'))
        self.assertGreaterEqual(data['distinctPdfs'], 5)
        per_pdf: dict[str, int] = {}
        for page in data['pages']:
            per_pdf[page['relPath']] = per_pdf.get(page['relPath'], 0) + 1
        for pdf, count in per_pdf.items():
            self.assertLessEqual(count, 4, pdf)


class MetricsComputationTests(unittest.TestCase):
    @staticmethod
    def annotation_with(questions, numbers=None, watermarks=None):
        anno = minimal_annotation()
        anno['questions'] = questions
        anno['numbers'] = numbers or []
        anno['watermarks'] = watermarks or []
        return anno

    @staticmethod
    def page_with(prose_lines, figures=None):
        return {
            'pageId': 'test-p0001',
            'regions': [{'type': 'text', 'text': '\n'.join(prose_lines),
                         'bbox': [0, 0, 100, 100]}],
            'tableCells': [], 'chartLabels': [],
            'figures': figures or [],
            'deskewAngle': 0,
            'tuitui': {'options': []},
        }

    def test_perfect_detection_zero_drops(self):
        anno = self.annotation_with([{
            'setNumber': 1, 'number': 1, 'stem': '某公司有八十人报名',
            'options': [{'key': 'A', 'text': '十'}, {'key': 'B', 'text': '二十'}],
            'optionImages': [], 'stemImages': [], 'answer': 'A', 'explanation': '',
        }], numbers=['80', '2022'])
        page = self.page_with([
            '1. 某公司有八十人报名',
            'A. 十',
            'B. 二十',
        ])
        # worker 输出的正文里补上数字，保证数字召回可测
        page['regions'][0]['text'] += '\n2022年，公司有80人'
        metrics, _ = __import__('eval_real').page_metrics(anno, page)
        self.assertEqual(metrics['silentDrops'], 0)
        self.assertEqual(metrics['questionRecall'], 1.0)
        self.assertEqual(metrics['questionPrecision'], 1.0)
        self.assertEqual(metrics['optionCompleteRate'], 1.0)
        self.assertEqual(metrics['numbers']['recall'], 1.0)

    def test_missing_question_is_silent_drop(self):
        anno = self.annotation_with([
            {'setNumber': 1, 'number': 1, 'stem': '题一', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': '', 'explanation': ''},
            {'setNumber': 1, 'number': 2, 'stem': '题二', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': '', 'explanation': ''},
        ])
        page = self.page_with(['1. 题一'])
        metrics, _ = __import__('eval_real').page_metrics(anno, page)
        self.assertEqual(metrics['silentDrops'], 1)
        self.assertEqual(metrics['questionRecall'], 0.5)

    def test_misread_number_counts_against_number_accuracy(self):
        anno = self.annotation_with([
            {'setNumber': 1, 'number': 11, 'stem': '题十一', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': '', 'explanation': ''},
        ])
        page = self.page_with(['1. 题十一'])
        metrics, _ = __import__('eval_real').page_metrics(anno, page)
        # 题号被误读（11→1）：既有静默丢题，题号准确率也不满
        self.assertEqual(metrics['silentDrops'], 1)
        self.assertIsNotNone(metrics['questionNumberAccuracy'])

    def test_watermark_residual_detected(self):
        anno = self.annotation_with([], watermarks=[
            {'bbox': [0, 0, 10, 10], 'text': '微信SKA123'}])
        page = self.page_with(['正文开头 微信SKA123 正文结束'])
        metrics, errors = __import__('eval_real').page_metrics(anno, page)
        self.assertEqual(metrics['watermarkResidualRate'], 1.0)
        self.assertGreaterEqual(errors.get('水印穿透正文', 0), 1)

    def test_empty_worker_page_counts_all_questions_as_silent_drops(self):
        anno = self.annotation_with([
            {'setNumber': 1, 'number': 1, 'stem': '题一', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': '', 'explanation': ''},
            {'setNumber': 1, 'number': 2, 'stem': '题二', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': '', 'explanation': ''},
        ])
        page = self.page_with([])
        metrics, _ = __import__('eval_real').page_metrics(anno, page)
        self.assertEqual(metrics['silentDrops'], 2)
        self.assertEqual(metrics['questionRecall'], 0.0)

    def test_answer_grid_expansion_matches_gt(self):
        anno = self.annotation_with([
            {'setNumber': 1, 'number': 1, 'stem': '', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': 'D', 'explanation': ''},
            {'setNumber': 1, 'number': 2, 'stem': '', 'options': [],
             'optionImages': [], 'stemImages': [], 'answer': 'A', 'explanation': ''},
        ])
        page = self.page_with(['1-2 DA'])
        metrics, _ = __import__('eval_real').page_metrics(anno, page)
        self.assertEqual(metrics['questionRecall'], 1.0)
        self.assertEqual(metrics['answerAccuracy'], 1.0)

    def test_util_functions(self):
        self.assertEqual(lev('abcd', 'abcd'), 0)
        self.assertEqual(lev('abcd', 'abef'), 2)
        self.assertEqual(norm_number('1，234％'), '1234%')
        self.assertAlmostEqual(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1.0)
        self.assertLess(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0.01)
        matched, gt_only = match_questions(
            [{'setNumber': 1, 'number': 1}], [{'num': 1, 'setNumber': 1}])
        self.assertEqual(len(matched), 1)
        self.assertEqual(len(gt_only), 0)


class DeterminismTests(unittest.TestCase):
    def test_golden_set_solver_deterministic(self):
        if not GOLDEN.is_file():
            self.skipTest('golden-set.json 不在本机')
        import golden_set
        buckets = golden_set.load_candidates()
        first = golden_set.solve(buckets)
        second = golden_set.solve(buckets)
        self.assertTrue(first, '求解器无解')
        self.assertEqual(
            [(s['pageId'], s['set'], s['pageType']) for s in first],
            [(s['pageId'], s['set'], s['pageType']) for s in second])

    def test_manifest_has_no_timestamp_fields(self):
        for name in ('golden-set.json', 'benchmark-pages.json', 'inventory.json'):
            path = BENCH / name
            if not path.is_file():
                continue
            text = path.read_text(encoding='utf-8')
            for forbidden in ('createdAt', 'updatedAt', 'generatedAt',
                              'timestamp', '"date"'):
                self.assertNotIn(forbidden, text, f'{name} 含时间戳字段 {forbidden}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
