# -*- coding: utf-8 -*-
"""benchmark 指标评估：把一次引擎运行（runs/<name>/pages.json）算成指标 JSON。

自动化指标（无需人工标注，可重复计算）：
  - charPages / medianMsPerPage / peakRssMb（资源开销）
  - qnoRecallTextLayer     有文字层的页：题号召回（对照文字层题号）
  - optionCompleteProxy    检出题目中 A-D 选项齐备占比（结构代理）
  - silentDropSuspects     题号连续性断档数（静默丢题嫌疑，需人工裁决）
  - digitConsistencyVsA    与方案A的数字集合一致性（双引擎交叉代理）
  - tableStructProxy       表格区检出数/行列一致性（结构代理）
  - graphicBindProxy       图推页 4 图一行绑定成功占比（结构代理）

人工标注后可再计算的指标（在 baseline 中标记 pending）：
  题干完整率 / 选项完整率(真实) / 数字准确率 / 表格单元格准确率 /
  图片选项绑定率(真实) / 答案配对率(真实)

用法：python eval_metrics.py <run-name> <engine-label> [--vs A运行名]
输出：docs/ocr-benchmark/metrics-<run-name>.json（确定性，可提交）
"""
from __future__ import annotations

import json
import re
import statistics
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(__file__).resolve().parents[2] / '..' / 'tizhou-ocr-bank' / 'exp'
EXP_DIR = Path('E:/tizhou-ocr-bank/exp')  # 易变产物固定在仓库外

QNO = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)')
OPTION = re.compile(r'(?:^|\s)([A-D])\s*[.、．]\s*\S')
DIGIT = re.compile(r'\d[\d,.%：:]*')


def qnos_of_text(text: str) -> list[int]:
    found = []
    for line in text.split('\n'):
        match = QNO.match(line)
        if match:
            found.append(int(match.group(1)))
    return found


def silent_drop_suspects(qnos: list[int]) -> int:
    """单调递增序列中的断档数（连续同号去重后）。新章节重新起号也算断档——
    因此是「嫌疑数」，最终以人工标注裁决。"""
    if len(qnos) < 2:
        return 0
    seen: list[int] = []
    for n in qnos:
        if not seen or seen[-1] != n:
            seen.append(n)
    return sum(1 for a, b in zip(seen, seen[1:]) if b - a != 1)


def page_text(page: dict) -> str:
    """兼容三种运行格式：A-plain(lines) / A-structured(markdown) / exp-worker(regions)。"""
    if page.get('markdown'):
        return str(page['markdown'])
    if page.get('lines'):
        return '\n'.join(line['text'] for line in page['lines'])
    parts = [r.get('text', '') for r in page.get('regions', [])]
    parts += [c.get('text', '') for c in page.get('tableCells', [])]
    parts += [c.get('text', '') for c in page.get('chartLabels', [])]
    if page.get('rawLines'):
        parts = [l.get('text', '') for l in page['rawLines']]
    return '\n'.join(parts)


def eval_plain_pages(pages: list[dict]) -> dict:
    all_qnos: list[int] = []
    option_sets: list[float] = []
    for page in pages:
        text = page_text(page)
        qnos = qnos_of_text(text)
        all_qnos.extend(qnos)
        keys = OPTION.findall(text)
        page_q = max(1, len(qnos))
        option_sets.append(min(1.0, len(set(keys)) / max(1, page_q * 4)) if page_q else 0)
    return {
        'totalQuestionsProxy': len(all_qnos),
        'silentDropSuspects': silent_drop_suspects(all_qnos),
        'qnoSequence': all_qnos[:400],
        'optionCompleteProxy': round(
            sum(option_sets) / len(option_sets), 3) if option_sets else 0,
    }


def eval_structured_page(page: dict) -> dict:
    regions = page.get('regions', [])
    return {
        'tables': page.get('tableRegions', sum(1 for r in regions if r.get('type') == 'table')),
        'images': page.get('imageRegions', sum(1 for r in regions if r.get('type') == 'image')),
    }


def digits_of(text: str) -> set[str]:
    return set(re.sub(r'[^0-9.%]', '', t) for t in DIGIT.findall(text))


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 1
    run_name, engine_label = sys.argv[1], sys.argv[2]
    vs_run = None
    if '--vs' in sys.argv:
        vs_run = sys.argv[sys.argv.index('--vs') + 1]

    run_path = None
    for candidate in (EXP_DIR / 'runs' / run_name / 'pages.json',
                      EXP_DIR / 'exp-worker' / 'runs' / run_name / 'pages.json'):
        if candidate.is_file():
            run_path = candidate
            break
    if run_path is None:
        print(f'找不到运行产物 runs/{run_name}/pages.json', file=sys.stderr)
        return 1
    data = json.loads(run_path.read_text(encoding='utf-8'))
    pages = data['pages']

    result: dict = {
        'engine': engine_label,
        'runName': run_name,
        'pages': len(pages),
        'peakRssMb': data.get('peakRssMb'),
        'medianMsPerPage': int(statistics.median([p['timeMs'] for p in pages if p.get('timeMs')]))
        if any(p.get('timeMs') for p in pages) else None,
        'errors': sum(1 for p in pages if p.get('error')),
        'charsTotal': sum(p.get('chars', 0) for p in pages),
        'charsPerType': {},
        'silentDropSuspects': None,
        'optionCompleteProxy': None,
        'tableStructProxy': None,
        'graphicBindProxy': None,
        'digitConsistencyVsA': None,
        'pendingHumanMetrics': ['题干完整率', '选项完整率(真实)', '数字准确率',
                                '表格单元格准确率', '图片选项绑定率(真实)', '答案配对率(真实)',
                                '静默丢题数(真实)'],
    }
    by_type: dict[str, list[int]] = {}
    for p in pages:
        text_len = len(page_text(p))
        by_type.setdefault(p.get('autoType', '?'), []).append(text_len)
    result['charsTotal'] = sum(sum(v) for v in by_type.values())
    result['charsPerType'] = {k: {'pages': len(v), 'avgChars': round(sum(v) / len(v))}
                              for k, v in sorted(by_type.items())}

    if any('lines' in p or 'rawLines' in p for p in pages):
        result.update(eval_plain_pages(pages))
    if any('regions' in p or 'tableRegions' in p for p in pages):
        tables = sum(eval_structured_page(p)['tables'] for p in pages)
        images = sum(1 for p in pages for r in p.get('regions', [])
                     if r.get('type') in ('image', 'figure'))
        images += sum(eval_structured_page(p)['images'] for p in pages
                      if 'tableRegions' in p)
        result['tableStructProxy'] = {'tables': tables, 'imageRegions': images}
    elif any('tableCount' in p for p in pages):
        # MinerU 格式：markdown 内嵌 HTML 表格 + 裁剪图片引用
        result['tableStructProxy'] = {
            'tables': sum(p.get('tableCount', 0) for p in pages),
            'imageRegions': sum(p.get('imageRefs', 0) for p in pages),
        }

    if any('tuitui' in p for p in pages):
        graphic = [p for p in pages if p.get('tuitui')]
        bound = sum(1 for p in graphic if p['tuitui']['options'])
        review = sum(1 for p in graphic if p['tuitui']['manualReview'])
        result['graphicBindProxy'] = {
            'graphicPages': len(graphic), 'boundPages': bound,
            'manualReviewPages': review,
            'bindRateProxy': round(bound / len(graphic), 3) if graphic else 0,
        }
    if any('ziliao' in p for p in pages):
        ziliao = [p for p in pages if p.get('ziliao')]
        result['ziliaoStructProxy'] = {
            'pages': len(ziliao),
            'tablesDetected': sum(1 for p in ziliao if p['ziliao']['table']),
            'tableCompleteGrid': sum(1 for p in ziliao
                                     if p['ziliao']['table'] and p['ziliao']['table']['completeGrid']),
            'chartsDetected': sum(len(p['ziliao']['charts']) for p in ziliao),
            'stemsWithQuestion': sum(1 for p in ziliao if p['ziliao']['stem']),
            'anomalyCount': sum(p['ziliao']['anomalies']['count'] for p in ziliao),
        }

    if vs_run:
        vs_path = None
        for candidate in (EXP_DIR / 'runs' / vs_run / 'pages.json',
                          EXP_DIR / 'exp-worker' / 'runs' / vs_run / 'pages.json'):
            if candidate.is_file():
                vs_path = candidate
                break
        if vs_path is None:
            print(f'找不到对照运行 {vs_run}', file=sys.stderr)
            return 1
        vs = json.loads(vs_path.read_text(encoding='utf-8'))
        vs_by_id = {p['pageId']: p for p in vs['pages']}
        agree, checked = 0, 0
        for p in pages:
            other = vs_by_id.get(p['pageId'])
            if not other:
                continue
            text_self = page_text(p)
            text_other = page_text(other)
            d_self, d_other = digits_of(text_self), digits_of(text_other)
            if not d_self and not d_other:
                continue
            union = d_self | d_other
            if union:
                agree += len(d_self & d_other) / len(union)
                checked += 1
        result['digitConsistencyVsA'] = {
            'vs': vs_run,
            'meanJaccard': round(agree / checked, 3) if checked else None,
            'pagesChecked': checked,
        }

    dest = BENCH / f'metrics-{run_name}.json'
    dest.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'qnoSequence'},
                     ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
