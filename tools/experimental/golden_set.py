# -*- coding: utf-8 -*-
"""第二阶段：Golden Set 选取器（30 页人工真值集）。

从 95 页固定 benchmark 中按 5 类页面各选 6 页：
  普通文字 / 资料分析表格 / 资料分析统计图 / 解析册 / 图形推理
并按「文档来源」拆分为 调优集18 / 验证集6 / 留出集6：
  - 同一 PDF 只允许出现在一个集合（天然满足「相邻页不跨集合」）；
  - 覆盖 >=5 个不同 PDF 来源；
  - 单个 PDF 在 Golden Set 内 <=4 页（防「针对一本书调参」）；
  - 固定种子，无时间戳，重跑零 diff。

输出：docs/ocr-benchmark/golden-set.json
"""
from __future__ import annotations

import itertools
import json
import os
import random
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
SEED = 20260906

TYPES = ['普通文字', '资料分析表格', '资料分析统计图', '解析册', '图形推理']
# 每类型 6 页在三个集合上的分配（列和=18/6/6，行和=6）
QUOTAS = {
    '普通文字': {'tuning': 4, 'validation': 1, 'heldout': 1},
    '资料分析表格': {'tuning': 3, 'validation': 1, 'heldout': 2},
    '资料分析统计图': {'tuning': 4, 'validation': 1, 'heldout': 1},
    '解析册': {'tuning': 3, 'validation': 2, 'heldout': 1},
    '图形推理': {'tuning': 4, 'validation': 1, 'heldout': 1},
}
# 类型间轮转集合访问顺序，避免调优集独占每类最大来源
SET_ORDER = ['tuning', 'validation', 'heldout']
MAX_PAGES_PER_PDF = 4
MIN_DISTINCT_PDFS = 5


def load_candidates() -> dict[str, list[dict]]:
    """按 5 类页面归桶（复用 expworker 信号 + RapidDoc 表格页）。"""
    bench = json.loads((BENCH / 'benchmark-pages.json').read_text(encoding='utf-8'))
    by_id = {p['pageId']: p for p in bench['pages']}
    exp = json.loads(
        (EXP_DIR / 'exp-worker/runs/expworker-300dpi/pages.json').read_text(encoding='utf-8'))
    exp_by_id = {p['pageId']: p for p in exp['pages']}
    structured = json.loads(
        (EXP_DIR / 'runs/engineA-structured/pages.json').read_text(encoding='utf-8'))
    rapid_table_pages = {p['pageId'] for p in structured['pages']
                         if p.get('tableRegions', 0) > 0 and p.get('autoType') == '资料分析'}

    buckets: dict[str, list[dict]] = defaultdict(list)
    for page_id, entry in sorted(by_id.items()):
        signals = exp_by_id.get(page_id, {})
        if entry['autoType'] == '普通文字':
            buckets['普通文字'].append(entry)
        elif entry['autoType'] == '资料分析':
            ziliao = signals.get('ziliao') or {}
            has_table = page_id in rapid_table_pages or bool(ziliao.get('table'))
            charts = ziliao.get('charts') or []
            # 双桶：表格与图表信号同页存在时，两个类型池都收录（选取时页面级去重）
            if has_table:
                buckets['资料分析表格'].append(entry)
            if charts:
                buckets['资料分析统计图'].append(entry)
            if not has_table and not charts:
                buckets['资料分析统计图'].append(entry)
        elif entry['autoType'] == '解析':
            buckets['解析册'].append(entry)
        elif entry['autoType'] == '图形推理候选':
            buckets['图形推理'].append(entry)
    return buckets


def solve(buckets: dict[str, list[dict]]) -> list[dict]:
    """DFS 精确求解：为每个集合选一组互不重复的 PDF 并按配额取页。

    候选 PDF 数量小（~15），子集枚举 + 剪枝即可；确定性（无全局随机）。
    页面选择用固定种子 RNG，保证重跑零 diff。
    """
    all_pdfs = sorted({e['relPath'] for t in TYPES for e in buckets.get(t, [])})
    pdf_types: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for t in TYPES:
        for e in buckets.get(t, []):
            pdf_types[e['relPath']][t].append(e)
    rng = random.Random(SEED)
    selected: list[dict] = []

    def set_quota(set_name: str) -> dict[str, int]:
        return {t: QUOTAS[t][set_name] for t in TYPES if QUOTAS[t][set_name] > 0}

    def take_for_set(set_name: str, pdfs: list[str],
                     used_pages: set[str]) -> list[tuple[dict, str]] | None:
        """从给定 PDF 集合按配额取页；容量不足返回 None。

        返回 (页面, 配额类型)：双桶页面按其填补的配额标注类型，
        而非按桶归属（人工标注时仍可在工具中修正最终类型）。
        """
        remaining = set_quota(set_name)
        taken: list[tuple[dict, str]] = []
        per_pdf_count: dict[str, int] = defaultdict(int)

        def fresh_count(t: str) -> int:
            return len([e for e in buckets.get(t, [])
                        if e['pageId'] not in used_pages])

        # 先取稀缺类型，后取富裕类型，降低单页双类型冲突
        for t in sorted(remaining, key=fresh_count):
            need = remaining[t]
            if need <= 0:
                continue
            fresh = [e for pdf in pdfs for e in pdf_types[pdf].get(t, [])
                     if e['pageId'] not in used_pages]
            if len(fresh) < need:
                return None
            rng.shuffle(fresh)
            for entry in fresh:
                if need <= 0:
                    break
                pdf = entry['relPath']
                if per_pdf_count[pdf] >= MAX_PAGES_PER_PDF:
                    continue
                taken.append((entry, t))
                used_pages.add(entry['pageId'])
                per_pdf_count[pdf] += 1
                need -= 1
            if need > 0:
                return None
        return taken

    def dfs(set_index: int, used_pdfs: set[str], used_pages: set[str]) -> list[dict] | None:
        if set_index == len(SET_ORDER):
            return selected[:]
        set_name = SET_ORDER[set_index]
        quota = set_quota(set_name)
        # 该集合需要的类型相关的候选 PDF（含任一所需类型的页面）
        need_types = list(quota)
        candidate_pdfs = [p for p in all_pdfs if p not in used_pdfs and any(
            pdf_types[p].get(t) for t in need_types)]
        # 子集枚举：从最小到最大（上界=Σ配额，实际更小）
        max_size = min(len(candidate_pdfs), sum(quota.values()))
        for size in range(1, max_size + 1):
            for subset in itertools.combinations(candidate_pdfs, size):
                local_used = set(used_pages)
                taken = take_for_set(set_name, list(subset), local_used)
                if taken is None:
                    continue
                selected.extend({
                    'pageId': e['pageId'], 'relPath': e['relPath'], 'page': e['page'],
                    'file': e['file'], 'set': set_name, 'pageType': t,
                } for e, t in taken)
                result = dfs(set_index + 1, used_pdfs | set(subset), local_used)
                if result is not None:
                    return result
                del selected[len(selected) - len(taken):]
        return None

    result = dfs(0, set(), set())
    return result if result is not None else []


def main() -> int:
    buckets = load_candidates()
    selected = solve(buckets)
    if not selected:
        print(json.dumps({'ok': False, 'problems': ['无可行解']}, ensure_ascii=False))
        return 1

    # ---- 约束自检 ----
    problems = []
    sets: dict[str, list[dict]] = defaultdict(list)
    for item in selected:
        sets[item['set']].append(item)
    for set_name, want in (('tuning', 18), ('validation', 6), ('heldout', 6)):
        if len(sets[set_name]) != want:
            problems.append(f'{set_name}={len(sets[set_name])} 期望 {want}')
    for page_type in TYPES:
        count = sum(1 for s in selected if s['pageType'] == page_type)
        if count != 6:
            problems.append(f'{page_type}={count} 期望 6')
    pdf_sets: dict[str, set[str]] = defaultdict(set)
    for item in selected:
        pdf_sets[item['relPath']].add(item['set'])
    for pdf, names in pdf_sets.items():
        if len(names) > 1:
            problems.append(f'PDF 跨集合: {pdf} -> {names}')
    distinct = len(pdf_sets)
    if distinct < MIN_DISTINCT_PDFS:
        problems.append(f'来源仅 {distinct} 个, 期望 >= {MIN_DISTINCT_PDFS}')
    per_pdf = defaultdict(int)
    for item in selected:
        per_pdf[item['relPath']] += 1
    for pdf, count in per_pdf.items():
        if count > MAX_PAGES_PER_PDF:
            problems.append(f'{pdf} 页数 {count} > {MAX_PAGES_PER_PDF}')

    manifest = {
        'schemaVersion': 1,
        'seed': SEED,
        'sourceBenchmark': 'benchmark-pages.json (seed=20260906, 95页)',
        'pageCount': len(selected),
        'distinctPdfs': distinct,
        'constraints': {
            'pdfDisjointAcrossSets': all(len(v) == 1 for v in pdf_sets.values()),
            'maxPagesPerPdf': MAX_PAGES_PER_PDF,
            'minDistinctPdfs': MIN_DISTINCT_PDFS,
        },
        'sets': {name: sorted(s['pageId'] for s in sets[name])
                 for name in ('tuning', 'validation', 'heldout')},
        'pages': sorted(selected, key=lambda s: (s['set'], s['relPath'], s['page'])),
    }
    if problems:
        manifest['problems'] = problems
        print(json.dumps({'ok': False, 'problems': problems}, ensure_ascii=False))
        return 1
    (BENCH / 'golden-set.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True) + '\n',
        encoding='utf-8')
    summary = {
        'ok': True, 'pages': len(selected), 'distinctPdfs': distinct,
        'bySet': {k: len(v) for k, v in sets.items()},
        'byType': {t: sum(1 for s in selected if s['pageType'] == t) for t in TYPES},
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
