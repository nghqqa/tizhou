# -*- coding: utf-8 -*-
"""Golden Set 人工真值 schema（阶段二）。

标注 JSON 必须通过 validate() 才能作为 Ground Truth 计入指标：
  - setStatus == 'confirmed' 且 annotator 非空且不是 OCR 预填身份；
  - 页面身份与 golden-set.json 一致；
  - bbox 为 [x0,y0,x1,y1] 且 x0<x1, y0<y1；
  - 题号 1-999 且页内唯一；选项键 A-D 唯一；
  - 禁止时间戳字段（可 diff 原则）。
"""
from __future__ import annotations

import re

SCHEMA_VERSION = 1
PAGE_TYPES = {'普通文字', '资料分析表格', '资料分析统计图', '解析册', '图形推理'}
STATUSES = {'pending', 'confirmed'}
BBOX_KEYS = {'bbox'}
FORBIDDEN_KEYS = {'createdAt', 'updatedAt', 'timestamp', 'time', 'date', 'annotatedAt'}
OCR_PREFILL_PREFIX = 'ocr-prefill'
OPTION_KEYS = {'A', 'B', 'C', 'D'}


def _valid_bbox(bbox) -> bool:
    return (isinstance(bbox, list) and len(bbox) == 4
            and all(isinstance(v, (int, float)) for v in bbox)
            and bbox[0] < bbox[2] and bbox[1] < bbox[3])


def _walk_forbidden_keys(node, path: str, errors: list[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in FORBIDDEN_KEYS:
                errors.append(f'{path}.{key}: 禁止时间戳字段')
            _walk_forbidden_keys(value, f'{path}.{key}', errors)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            _walk_forbidden_keys(item, f'{path}[{index}]', errors)


def validate(data: dict, golden_pages: list[dict]) -> list[str]:
    errors: list[str] = []
    if data.get('schemaVersion') != SCHEMA_VERSION:
        errors.append('schemaVersion 必须为 1')
    page_id = data.get('pageId')
    meta = next((p for p in golden_pages if p['pageId'] == page_id), None)
    if meta is None:
        errors.append(f'pageId {page_id} 不在 golden-set 中')
        return errors
    if data.get('pageNumber') != meta['page']:
        errors.append(f"pageNumber 与 golden-set 不符 (期望 {meta['page']})")
    if data.get('sourcePdf') != meta['relPath']:
        errors.append('sourcePdf 与 golden-set 不符')
    if data.get('pageType') not in PAGE_TYPES:
        errors.append(f"pageType 非法: {data.get('pageType')}")
    if data.get('setStatus') not in STATUSES:
        errors.append(f"setStatus 非法: {data.get('setStatus')}")
    annotator = (data.get('annotator') or '').strip()
    if not annotator:
        errors.append('annotator 必填')
    if data.get('setStatus') == 'confirmed' and annotator.startswith(OCR_PREFILL_PREFIX):
        errors.append('OCR 预填身份不得标记为 confirmed（人工确认才可计入 GT）')
    if data.get('setStatus') == 'confirmed' and not re.fullmatch(r'[\w\u4e00-\u9fff.-]{2,32}', annotator or ''):
        errors.append('confirmed 需要 2-32 字符的标注人标识')

    seen_keys: set[tuple[int, int]] = set()
    for index, question in enumerate(data.get('questions') or []):
        where = f'questions[{index}]'
        number = question.get('number')
        set_number = question.get('setNumber', 1)
        if not isinstance(number, int) or not 1 <= number <= 999:
            errors.append(f'{where}.number 非法: {number}')
        elif not isinstance(set_number, int) or not 1 <= set_number <= 999:
            errors.append(f'{where}.setNumber 非法: {set_number}')
        elif (set_number, number) in seen_keys:
            errors.append(f'{where}.number 页内重复: 套{set_number} 题{number}')
        else:
            seen_keys.add((set_number, number))
        keys = [o.get('key') for o in question.get('options') or []]
        if len(keys) != len(set(keys)):
            errors.append(f'{where}.options 选项键重复')
        if any(k not in OPTION_KEYS for k in keys):
            errors.append(f'{where}.options 选项键必须是 A-D')
        answer = question.get('answer', '')
        if answer and not re.fullmatch(r'[A-D]{1,4}', answer):
            errors.append(f'{where}.answer 非法: {answer}')
        for image in question.get('optionImages') or []:
            if not _valid_bbox(image.get('bbox')):
                errors.append(f'{where}.optionImages bbox 非法')
        for image in question.get('stemImages') or []:
            if not _valid_bbox(image.get('bbox')):
                errors.append(f'{where}.stemImages bbox 非法')

    for index, table in enumerate(data.get('tables') or []):
        if not _valid_bbox(table.get('bbox')):
            errors.append(f'tables[{index}].bbox 非法')
    for index, chart in enumerate(data.get('charts') or []):
        if not _valid_bbox(chart.get('bbox')):
            errors.append(f'charts[{index}].bbox 非法')
    for index, watermark in enumerate(data.get('watermarks') or []):
        if not _valid_bbox(watermark.get('bbox')):
            errors.append(f'watermarks[{index}].bbox 非法')
    for side in ('header', 'footer'):
        block = data.get(side)
        if block is not None and not _valid_bbox(block.get('bbox')):
            errors.append(f'{side}.bbox 非法')

    for token in data.get('numbers') or []:
        if not re.fullmatch(r'[-+]?\d[\d,，]*(?:\.\d+)?[%％％]?', token):
            errors.append(f'numbers 含非法 token: {token}')
    _walk_forbidden_keys(data, 'root', errors)
    return errors


def confirmed_pages(annotations: list[dict]) -> list[dict]:
    """只有 confirmed 的标注才算 Ground Truth。"""
    return [a for a in annotations if a.get('setStatus') == 'confirmed']
