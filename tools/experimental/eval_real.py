# -*- coding: utf-8 -*-
"""阶段二：真实评测指标计算器（Ground Truth 驱动）。

只把 setStatus='confirmed' 的标注当作 Ground Truth；
pending 标注仅产出「未核实参考」指标，输出中显式分离，绝不冒充真实准确率。

用法：
  python eval_real.py --worker <runs/<name>/pages.json> --label <引擎说明> \
      [--out docs/ocr-benchmark/real-metrics-<name>.json]

指标（16 项）与错误分类（14 类）定义见 docs/ocr-benchmark/phase2-report.md。
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gt_schema import validate  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
ANNOT_DIR = BENCH / 'golden' / 'annotations'

QNO = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)\s*(.*)$')
ANSWER_RANGE = re.compile(r'^\s*(\d{1,3})\s*[-—~]\s*(\d{1,3})\s*[:：]?\s*([A-Da-d]{1,30})\s*$')
ANSWER_MARK_RE = re.compile(r'【参考答案(?:及正确率)?】\s*([A-D]+)')
DIGIT_TOKEN = re.compile(r'\d[\d,，]*(?:\.\d+)?[%％]?')
NUM_STREAM = re.compile(r'^\s*(?:[-+]?\d[\d,.%％：:]+\s+){5,}')

ERROR_TYPES = [
    '低分辨率', '页面倾斜', '文字粘连', '水印穿透正文', '多栏阅读顺序错误',
    '题号误识别', 'A-D标签误识别', '表格线缺失', '单元格跨行', '图表数字进入正文',
    '解析串题', '题本与答案册套号错位', '图推选项合并成整条图片', '其他',
]


def norm_number(token: str) -> str:
    return re.sub(r'[\s,，]', '', token).replace('％', '%').replace('。', '.')


def norm_text(text: str) -> str:
    return re.sub(r'[\s，。、；：？！,.;:?!()（）【】\[\]"\'’“”]', '', text)


def lev(a: str, b: str) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        cur = [i + 1]
        for j, cb in enumerate(b):
            cur.append(min(prev[j + 1] + 1, cur[j] + 1, prev[j] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(det: str, gt: str) -> float:
    gt_n = norm_text(gt)
    if not gt_n:
        return 0.0
    return min(1.0, lev(norm_text(det), gt_n) / len(gt_n))


def iou(a: list[float], b: list[float]) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def worker_questions(page: dict) -> list[dict]:
    """从 worker 输出提取检出题目（题号/题干/选项/答案）。

    与生产 question-import 同口径：题号锚点 + A-D 选项 + 【参考答案】标记，
    以及答案册范围格「21-25 DACDD」（parseAnswerGroups 的无冒号变体）。
    这里解析的是 worker 实际产出的文本，不是预填脚本。
    """
    prose = next((r for r in page.get('regions', []) if r.get('type') == 'text'), None)
    if not prose:
        return []
    lines = prose['text'].split('\n')
    questions: list[dict] = []
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
                questions.append({'num': start + offset,
                                  'setNumber': grid_section, 'stem': '',
                                  'options': [],
                                  'answer': letters[offset].upper()
                                  if offset < len(letters) else ''})
            current = None
            continue
        match = QNO.match(line)
        if match:
            if current:
                questions.append(current)
            current = {'num': int(match.group(1)), 'setNumber': 1,
                       'stem': match.group(2), 'options': [], 'answer': ''}
            continue
        if current is None:
            continue
        opt = re.match(r'^([A-D])\s*[.、．]?\s*(.*)$', line)
        if opt:
            current['options'].append({'key': opt.group(1), 'text': opt.group(2)})
        else:
            mark = ANSWER_MARK_RE.search(line)
            if mark:
                current['answer'] = mark.group(1)
            current['stem'] += line
    if current:
        questions.append(current)
    return questions


def output_text(page: dict) -> str:
    parts = [r.get('text', '') for r in page.get('regions', []) if r.get('type') == 'text']
    parts += [c.get('text', '') for c in page.get('tableCells', [])]
    return '\n'.join(parts)


def match_questions(gt_questions: list[dict], det_questions: list[dict]) -> tuple[dict, dict]:
    """按 (setNumber, number) 精确匹配；返回 (matched, gt_only)。"""
    det_by_key = {(q.get('setNumber', 1), q['num']): q for q in det_questions}
    matched, gt_only = {}, {}
    for q in gt_questions:
        key = (q.get('setNumber', 1), q['number'])
        det = det_by_key.get(key)
        if det is not None:
            matched[key] = (q, det)
        else:
            gt_only[key] = q
    return matched, gt_only


def page_metrics(annotation: dict, page: dict) -> tuple[dict, dict]:
    """单页指标 + 单页错误计数。"""
    errors: dict[str, int] = defaultdict(int)
    gt_questions = annotation.get('questions') or []
    det_questions = worker_questions(page)
    matched, gt_only = match_questions(gt_questions, det_questions)
    det_keys = {(q.get('setNumber', 1), q['num']) for q in det_questions}
    gt_keys = {(q.get('setNumber', 1), q['number']) for q in gt_questions}
    fp = len([k for k in det_keys - gt_keys])

    # 1 题目检测 recall/precision；15 静默丢题
    gt_total = len(gt_questions)
    tp = len(matched)
    recall_q = tp / gt_total if gt_total else None
    precision_q = tp / (tp + fp) if (tp + fp) else None
    silent_drops = len(gt_only)
    if silent_drops:
        errors['题号误识别'] += silent_drops
    if fp:
        errors['其他'] += fp

    # 2 题号识别准确率（序列比对：位置对齐上号是否一致）
    num_acc = None
    if gt_questions and det_questions:
        gt_seq = [str(q['number']) for q in gt_questions]
        det_seq = [str(q['num']) for q in det_questions]
        sm = __import__('difflib').SequenceMatcher(None, gt_seq, det_seq)
        equal = sum(1 for block in sm.get_matching_blocks()
                    for i in range(block.size)
                    if gt_seq[block.a + i] == det_seq[block.b + i])
        num_acc = equal / len(gt_seq)

    # 3 题干 CER；5 选项字符准确率；4 A-D 完整率
    cers: list[float] = []
    opt_cers: list[float] = []
    opt_complete, opt_gt = 0, 0
    for (key, (g, d)) in matched.items():
        if g.get('stem'):
            cers.append(cer(d.get('stem', ''), g['stem']))
        gt_opts = {o['key']: o.get('text', '') for o in g.get('options') or []}
        if gt_opts:
            opt_gt += 1
            det_opts = {o['key']: o.get('text', '') for o in d.get('options') or []}
            if all(k in det_opts for k in gt_opts):
                opt_complete += 1
            gt_join = ''.join(gt_opts[k] for k in sorted(gt_opts))
            det_join = ''.join(det_opts.get(k, '') for k in sorted(gt_opts))
            opt_cers.append(cer(det_join, gt_join))
            if any(k not in det_opts for k in gt_opts):
                errors['A-D标签误识别'] += 1
    stem_acc = round(1 - statistics.mean(cers), 4) if cers else None
    mean_stem_cer = round(statistics.mean(cers), 4) if cers else None
    opt_complete_rate = opt_complete / opt_gt if opt_gt else None
    opt_char_acc = round(1 - statistics.mean(opt_cers), 4) if opt_cers else None
    if cers and statistics.mean(cers) > 0.35 and opt_gt == 0:
        errors['文字粘连'] += 1

    # 6 数字 token P/R/F1（GT numbers 为必识别数字清单）
    gt_nums = {norm_number(t) for t in annotation.get('numbers') or []}
    out_text = output_text(page)
    det_nums = {norm_number(t) for t in DIGIT_TOKEN.findall(out_text)}
    det_nums = {t for t in det_nums if t}
    if gt_nums:
        inter = gt_nums & det_nums
        p = len(inter) / len(det_nums) if det_nums else 0.0
        r = len(inter) / len(gt_nums)
        f1 = 2 * p * r / (p + r) if p + r else 0.0
        numbers_metric = {'precision': round(p, 4), 'recall': round(r, 4), 'f1': round(f1, 4)}
        if r < 0.5 and NUM_STREAM.search(out_text):
            errors['图表数字进入正文'] += 1
    else:
        numbers_metric = None

    # 7/8 表格行列与单元格
    table_metric = None
    gt_tables = annotation.get('tables') or []
    det_tables = [r for r in page.get('regions', []) if r.get('type') == 'table']
    if gt_tables:
        gt_rows = gt_tables[0].get('rows') or []
        gt_r, gt_c = len(gt_rows), max((len(r) for r in gt_rows), default=0)
        if det_tables:
            det_cells = page.get('tableCells') or []
            det_r = len(det_tables[0].get('rows') or
                        [c.get('text', '') for c in det_cells]) if det_cells else 0
            row_acc = max(0.0, 1 - abs(det_r - gt_r) / gt_r) if gt_r else None
            gt_cells = [norm_text(c) for row in gt_rows for c in row if norm_text(c)]
            det_cell_texts = [norm_text(c.get('text', '')) for c in det_cells]
            hit = sum(1 for c in gt_cells if c in det_cell_texts)
            cell_acc = hit / len(gt_cells) if gt_cells else None
            table_metric = {'rowAccuracy': round(row_acc, 4) if row_acc is not None else None,
                            'cellAccuracy': round(cell_acc, 4) if cell_acc is not None else None,
                            'detected': True}
            if cell_acc is not None and cell_acc < 0.5:
                errors['单元格跨行'] += 1
        else:
            table_metric = {'rowAccuracy': None, 'cellAccuracy': None, 'detected': False}
            errors['表格线缺失'] += 1

    # 9 图表区域检测 recall；10 图推图片保留率；11 绑定准确率
    det_figures = [r['bbox'] for r in page.get('regions', []) if r.get('type') == 'figure']
    gt_charts = [c['bbox'] for c in annotation.get('charts') or [] if _bbox_ok(c.get('bbox'))]
    chart_recall = None
    if gt_charts:
        hit = sum(1 for b in gt_charts if any(iou(b, f) >= 0.3 for f in det_figures))
        chart_recall = round(hit / len(gt_charts), 4)
    gt_images = []
    for q in gt_questions:
        gt_images += [s['bbox'] for s in q.get('stemImages') or [] if _bbox_ok(s.get('bbox'))]
        gt_images += [o['bbox'] for o in q.get('optionImages') or [] if _bbox_ok(o.get('bbox'))]
    image_keep = None
    bind_acc = None
    if gt_images:
        hit = sum(1 for b in gt_images if any(iou(b, f) >= 0.3 for f in det_figures))
        image_keep = round(hit / len(gt_images), 4)
        if image_keep < 0.5 and len(det_figures) < len(gt_images):
            errors['图推选项合并成整条图片'] += 1
        gt_option_keys = [o['key'] for q in gt_questions
                          for o in q.get('optionImages') or [] if o.get('key')]
        tuitui = page.get('tuitui') or {}
        det_option_keys = [o.get('key') for o in tuitui.get('options', []) if o.get('key')]
        if gt_option_keys:
            match_n = sum(1 for i, k in enumerate(gt_option_keys)
                          if i < len(det_option_keys) and det_option_keys[i] == k)
            bind_acc = round(match_n / len(gt_option_keys), 4)

    # 12 答案配对准确率；13 解析串题率
    gt_answers = {(q.get('setNumber', 1), q['number']): q.get('answer', '')
                  for q in gt_questions if q.get('answer')}
    det_answers = {(1, q['num']): q.get('answer', '') for q in det_questions if q.get('answer')}
    answer_acc = serial_rate = None
    if gt_answers:
        hit = sum(1 for k, a in gt_answers.items() if det_answers.get(k) == a)
        answer_acc = round(hit / len(gt_answers), 4)
        wrong_at = sum(1 for k, a in det_answers.items()
                       if k not in gt_answers and a)
        serial_rate = round(wrong_at / len(det_answers), 4) if det_answers else 0.0
        if wrong_at:
            errors['解析串题'] += wrong_at
            errors['题本与答案册套号错位'] += 1

    # 14 水印残留率
    gt_wm = [w for w in annotation.get('watermarks') or [] if (w.get('text') or '').strip()]
    residual = 0
    if gt_wm:
        norm_out = norm_text(out_text)
        for w in gt_wm:
            if norm_text(w['text']) and norm_text(w['text']) in norm_out:
                residual += 1
        watermark_residual = round(residual / len(gt_wm), 4)
        if residual:
            errors['水印穿透正文'] += residual
    else:
        watermark_residual = None

    # 输入条件类错误（非 worker 过错，单独记录）
    if (page.get('deskewAngle') or 0) and abs(page['deskewAngle']) > 1.0:
        errors['页面倾斜'] += 1

    metrics = {
        'questionRecall': round(recall_q, 4) if recall_q is not None else None,
        'questionPrecision': round(precision_q, 4) if precision_q is not None else None,
        'questionNumberAccuracy': round(num_acc, 4) if num_acc is not None else None,
        'stemCER': mean_stem_cer,
        'stemAccuracy': stem_acc,
        'optionCompleteRate': round(opt_complete_rate, 4) if opt_complete_rate is not None else None,
        'optionCharAccuracy': opt_char_acc,
        'numbers': numbers_metric,
        'table': table_metric,
        'chartRegionRecall': chart_recall,
        'graphicImageKeepRate': image_keep,
        'graphicBindAccuracy': bind_acc,
        'answerAccuracy': answer_acc,
        'serialMismatchRate': serial_rate,
        'watermarkResidualRate': watermark_residual,
        'silentDrops': silent_drops,
        'gtQuestions': gt_total,
        'detectedQuestions': len(det_questions),
        'falseQuestions': fp,
    }
    return metrics, dict(errors)


def _bbox_ok(bbox) -> bool:
    return (isinstance(bbox, list) and len(bbox) == 4
            and all(isinstance(v, (int, float)) for v in bbox)
            and bbox[2] > bbox[0] and bbox[3] > bbox[1])


def aggregate(page_results: list[dict]) -> dict:
    """对一组单页结果求聚合指标。"""
    def mean_of(key, data=None):
        values = [r['metrics'][key] for r in (data or page_results)
                  if r['metrics'].get(key) is not None]
        return round(statistics.mean(values), 4) if values else None

    numbers = [r['metrics']['numbers'] for r in page_results
               if r['metrics'].get('numbers')]
    num_f1 = round(statistics.mean([n['f1'] for n in numbers]), 4) if numbers else None
    tables = [r['metrics']['table'] for r in page_results if r['metrics'].get('table')]
    error_counts: dict[str, int] = defaultdict(int)
    for r in page_results:
        for k, v in r['errors'].items():
            error_counts[k] += v
    return {
        'pages': len(page_results),
        'questionRecall': mean_of('questionRecall'),
        'questionPrecision': mean_of('questionPrecision'),
        'questionNumberAccuracy': mean_of('questionNumberAccuracy'),
        'stemAccuracy': mean_of('stemAccuracy'),
        'stemCER': mean_of('stemCER'),
        'optionCompleteRate': mean_of('optionCompleteRate'),
        'optionCharAccuracy': mean_of('optionCharAccuracy'),
        'numberTokenF1': num_f1,
        'tableRowAccuracy': mean_of('tableRowAccuracy',
                                    [r for r in page_results if r['metrics'].get('table')]),
        'tableCellAccuracy': mean_of('tableCellAccuracy',
                                     [r for r in page_results if r['metrics'].get('table')]),
        'chartRegionRecall': mean_of('chartRegionRecall'),
        'graphicImageKeepRate': mean_of('graphicImageKeepRate'),
        'graphicBindAccuracy': mean_of('graphicBindAccuracy'),
        'answerAccuracy': mean_of('answerAccuracy'),
        'serialMismatchRate': mean_of('serialMismatchRate'),
        'watermarkResidualRate': mean_of('watermarkResidualRate'),
        'silentDrops': sum(r['metrics']['silentDrops'] for r in page_results),
        'gtQuestions': sum(r['metrics']['gtQuestions'] for r in page_results),
        'errors': dict(sorted(error_counts.items(), key=lambda kv: -kv[1])),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', required=True)
    parser.add_argument('--label', default='exp-worker')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    golden = json.loads((BENCH / 'golden-set.json').read_text(encoding='utf-8'))
    meta_by_id = {p['pageId']: p for p in golden['pages']}
    worker = json.loads(Path(args.worker).read_text(encoding='utf-8'))
    worker_by_id = {p['pageId']: p for p in worker['pages']}

    confirmed, pending = [], []
    for meta in golden['pages']:
        anno_path = ANNOT_DIR / f"{meta['pageId']}.json"
        if not anno_path.is_file():
            raise FileNotFoundError(f'缺少 Golden Set 标注：{anno_path}')
        data = json.loads(anno_path.read_text(encoding='utf-8'))
        schema_errors = validate(data, golden['pages'])
        if schema_errors:
            raise ValueError(f'{anno_path.name} schema 无效：{"; ".join(schema_errors)}')
        (confirmed if data.get('setStatus') == 'confirmed' else pending).append((meta, data))

    def run_group(groups: list[tuple[dict, dict]], verified: bool) -> dict:
        page_results = []
        for meta, anno in groups:
            page = worker_by_id.get(meta['pageId'])
            missing_worker_page = page is None
            if missing_worker_page:
                page = {
                    'pageId': meta['pageId'],
                    'regions': [],
                    'rawLines': [],
                    'questions': [],
                    'tableCells': [],
                    'chartLabels': [],
                }
            metrics, errors = page_metrics(anno, page)
            if missing_worker_page:
                errors['页面无输出'] = errors.get('页面无输出', 0) + 1
            page_results.append({'pageId': meta['pageId'], 'set': meta['set'],
                                 'pageType': meta['pageType'],
                                 'metrics': metrics, 'errors': errors})
        by_set = {name: aggregate([r for r in page_results if r['set'] == name])
                  for name in ('tuning', 'validation', 'heldout')
                  if any(r['set'] == name for r in page_results)}
        by_type = {}
        for t in {r['pageType'] for r in page_results}:
            by_type[t] = aggregate([r for r in page_results if r['pageType'] == t])
        overall = aggregate(page_results)
        times = [p['timeMs'] for p in worker['pages'] if p.get('timeMs')]
        return {
            'verified': verified,
            'note': ('Ground Truth（人工已确认）' if verified
                     else '未核实参考（OCR 预填对比，不是真实准确率）'),
            'pages': overall['pages'],
            'overall': overall,
            'bySet': by_set,
            'byType': by_type,
            'perPage': [{'pageId': r['pageId'], 'set': r['set'],
                         'pageType': r['pageType'], **r['metrics']} for r in page_results],
            'cost': {
                'medianMsPerPage': int(statistics.median(times)) if times else None,
                'peakRssMb': worker.get('peakRssMb'),
                'modelSizeMb': worker.get('modelSizeMb'),
            },
        }

    output = {
        'schemaVersion': 1,
        'engine': args.label,
        'workerRun': args.worker,
        'gtConfirmedPages': len(confirmed),
        'gtPendingPages': len(pending),
        'groundTruth': run_group(confirmed, True) if confirmed else None,
        'unverifiedReference': run_group(pending, False) if pending else None,
    }
    Path(args.out).write_text(
        json.dumps(output, ensure_ascii=False, indent=1, sort_keys=True) + '\n',
        encoding='utf-8')
    print(json.dumps({
        'gtConfirmedPages': output['gtConfirmedPages'],
        'gtPendingPages': output['gtPendingPages'],
        'unverifiedOverall': output['unverifiedReference']['overall']
        if output['unverifiedReference'] else None,
    }, ensure_ascii=False)[:1500])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
