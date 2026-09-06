# -*- coding: utf-8 -*-
"""阶段二·五：优化版实验 worker（全部优化项可开关，供消融实验）。

只在 tools/experimental/ 内，不接生产链路。

开关（--config k=v,k=v）：
  dpi          渲染 DPI（默认 300；基线可设 200）
  deskew       去倾斜（0/1）
  clahe        对比度增强（0/1）
  adaptive     自适应 DPI：低置信度/小字号行局部 350/400 DPI 重识别（0/1）
  multicandidate 多预处理候选：灰度原图 + CLAHE 双候选按置信度选优（0/1）
  region_ocr   区域级 OCR：表格裁剪局部放大重识别（0/1）
  reading_order 阅读顺序：分栏 + 题号锚点硬边界组卷（0/1）
  watermark    跨页重复水印统计与剥离（文档级，同 PDF 分组）（0/1）

用法：
  python exp_worker2.py run <set:tuning|validation|heldout|all> <run-name> --config dpi=300,clahe=1
产物：TIZHU_EXP_DIR/exp-worker2/runs/<run-name>/pages.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import exp_worker as v1  # noqa: E402
from winmem import peak_rss_mb  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
QNO = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)\s*(.*)$')
OPTION = re.compile(r'^([A-D])\s*[.、．]?\s*(.*)$')
ANSWER_MARK = re.compile(r'【参考答案(?:及正确率)?】\s*([A-D]+)')
LOW_CONF_THRESHOLD = 0.78
SMALL_TEXT_PX = {200: 18, 300: 26, 350: 30, 400: 35}
ADAPTIVE_UPSCALE = {300: 350, 350: 400, 400: 400, 200: 300}

DEFAULT_CONFIG = {
    'dpi': 300, 'deskew': 0, 'clahe': 0, 'adaptive': 0, 'multicandidate': 0,
    'region_ocr': 0, 'reading_order': 0, 'watermark': 0,
}


def resolve_pdf_path(recorded_path: str) -> Path:
    """按需把清单中的原机器绝对路径映射到 TIZHU_SAMPLE_DIR。"""
    override = os.environ.get('TIZHU_SAMPLE_DIR')
    path = Path(recorded_path)
    if not override:
        return path
    inventory = json.loads((BENCH / 'inventory.json').read_text(encoding='utf-8'))
    source_root = Path(inventory['sampleRoot'])
    try:
        relative = path.relative_to(source_root)
    except ValueError:
        return path
    return Path(override) / relative


def parse_config(text: str | None) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if text:
        for part in text.split(','):
            if not part:
                continue
            key, _, value = part.partition('=')
            cfg[key.strip()] = int(value) if key.strip() != 'dpi' else int(value)
    return cfg


def preprocess_v2(rgb: np.ndarray, cfg: dict) -> tuple[np.ndarray, float, np.ndarray]:
    """灰度基线 + 可选 CLAHE/去倾斜；返回 (处理图, 角度, 逆映射矩阵)。"""
    height, width = rgb.shape[:2]
    identity = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float64)
    if not cfg['clahe'] and not cfg['deskew']:
        return rgb, 0.0, identity
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if cfg['clahe']:
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    angle = 0.0
    if cfg['deskew']:
        edges = cv2.Canny(gray, 80, 160)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=300,
                                minLineLength=width // 3, maxLineGap=30)
        if lines is not None:
            angles = []
            for x1, y1, x2, y2 in np.asarray(lines).reshape(-1, 4):
                dx, dy = float(x2 - x1), float(y2 - y1)
                if abs(dx) > 1e-6:
                    deg = float(np.degrees(np.arctan2(dy, dx)))
                    if abs(deg) <= 5.0:
                        angles.append(deg)
            if len(angles) >= 3:
                angle = float(np.median(angles))
    if angle:
        matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
        processed = cv2.warpAffine(gray, matrix, (width, height),
                                   flags=cv2.INTER_CUBIC, borderValue=255)
    else:
        matrix = identity
        processed = gray
    return cv2.cvtColor(processed, cv2.COLOR_GRAY2RGB), angle, matrix


def ocr_candidate_score(lines: list[dict]) -> float:
    """候选选优分数：平均置信度为主，数字行占比作稳健项。"""
    if not lines:
        return 0.0
    avg = sum(l['score'] for l in lines) / len(lines)
    digits = sum(1 for l in lines if re.search(r'\d', l['text']))
    return avg + 0.02 * (digits / len(lines))


def run_ocr_best(engine, candidates: list[np.ndarray]) -> tuple[list[dict], np.ndarray]:
    """多预处理候选：逐候选 OCR，按分数选优。返回 (lines, 选用图像)。"""
    best_lines, best_image, best_score = [], candidates[0], -1.0
    for image in candidates:
        lines = v1.ocr_lines(engine, image)
        score = ocr_candidate_score(lines)
        if score > best_score:
            best_lines, best_image, best_score = lines, image, score
    return best_lines, best_image


def adaptive_rerender(doc, page_index: int, lines: list[dict], dpi: int,
                      matrix: np.ndarray) -> list[dict]:
    """自适应 DPI：低置信度/小字号行聚类后局部升级 DPI 重识别。"""
    target_dpi = ADAPTIVE_UPSCALE.get(dpi, 400)
    if target_dpi == dpi or not lines:
        return lines
    small_px = SMALL_TEXT_PX.get(dpi, 26)
    flagged = [l for l in lines
               if l['score'] < LOW_CONF_THRESHOLD
               or (l['bbox'][3] - l['bbox'][1]) < small_px]
    if not flagged or len(flagged) > len(lines) * 0.6:
        return lines  # 整页都差时局部升级无意义（走多候选/更大 DPI 的显式决策）
    upscaled = v1.render_page(doc, page_index, target_dpi)
    scale = target_dpi / dpi
    result = list(lines)
    clusters: list[list[float]] = []
    for line in flagged:
        box = line['bbox']
        for cluster in clusters:
            if v1.iou(box, cluster) > 0 or v1.inside(box, cluster):
                cluster[0] = min(cluster[0], box[0]); cluster[1] = min(cluster[1], box[1])
                cluster[2] = max(cluster[2], box[2]); cluster[3] = max(cluster[3], box[3])
                break
        else:
            clusters.append(list(box))
    engine = get_engine()
    for cluster in clusters:
        x0, y0, x1, y1 = [int(v * scale) for v in cluster]
        h, w = upscaled.shape[:2]
        crop = upscaled[max(0, y0 - 10):min(h, y1 + 10), max(0, x0 - 10):min(w, x1 + 10)]
        if crop.size == 0:
            continue
        new_lines = v1.ocr_lines(engine, crop)
        cluster_area = max(1.0, (cluster[2] - cluster[0]) * (cluster[3] - cluster[1]))

        def _in_cluster(line):
            box = line['bbox']
            return v1.inside(box, cluster) and \
                (box[2] - box[0]) * (box[3] - box[1]) / cluster_area > 0.2

        replaced = [line for line in result if _in_cluster(line)]
        for line in replaced:
            result.remove(line)
        for line in new_lines:
            bx = line['bbox']
            line['bbox'] = [round(cluster[0] + bx[0] / scale, 1),
                            round(cluster[1] + bx[1] / scale, 1),
                            round(cluster[0] + bx[2] / scale, 1),
                            round(cluster[1] + bx[3] / scale, 1)]
            line['bboxOriginal'] = v1.bbox_to_original(line['bbox'], matrix)
            result.append(line)
    return result


def sort_reading_order(lines: list[dict]) -> list[dict]:
    """阅读顺序：x 直方图找中缝分栏；栏内按 y 再 x。"""
    if len(lines) < 6:
        return sorted(lines, key=lambda l: (l['bbox'][1], l['bbox'][0]))
    width = int(max(l['bbox'][2] for l in lines)) + 1
    histogram = np.zeros(width)
    for line in lines:
        histogram[int((line['bbox'][0] + line['bbox'][2]) / 2)] += 1
    smoothed = np.convolve(histogram, np.ones(31) / 31, mode='same')
    center = width // 2
    window = smoothed[int(center * 0.4):int(center * 1.6)]
    gap = int(center * 0.4) + int(np.argmin(window))
    if smoothed[gap] < 0.15 * float(smoothed.max()) and \
            smoothed[gap] < 1.0 and width > 2000:
        left = [l for l in lines if (l['bbox'][0] + l['bbox'][2]) / 2 < gap]
        right = [l for l in lines if (l['bbox'][0] + l['bbox'][2]) / 2 >= gap]
        key = lambda l: (l['bbox'][1], l['bbox'][0])
        return sorted(left, key=key) + sorted(right, key=key)
    return sorted(lines, key=lambda l: (l['bbox'][1], l['bbox'][0]))


def assemble_questions(lines: list[dict]) -> list[dict]:
    """题号锚点为硬边界组卷：题干/选项/答案各归其位；答案标记关闭当前题。"""
    questions: list[dict] = []
    current = None
    for line in lines:
        text = line['text']
        if re.search(r'【参考答案(?:及正确率)?】\s*[A-D]', text):
            if current:
                questions.append(current)
                current = None
            continue
        match = QNO.match(text)
        if match:
            if current:
                questions.append(current)
            current = {'setNumber': 1, 'number': int(match.group(1)),
                       'stem': match.group(2)[:300], 'options': [], 'answer': ''}
            continue
        if current is None:
            continue
        opt = OPTION.match(text)
        if opt and len(current['options']) < 4:
            current['options'].append({'key': opt.group(1), 'text': opt.group(2)[:300]})
        elif not current['options']:
            current['stem'] += text[:300]
    if current:
        questions.append(current)
    return questions


def region_ocr_table(engine, doc, page_index: int, dpi: int,
                     table_bbox: list[float]) -> list[dict]:
    """区域级 OCR：表格裁剪局部放大重识别（只服务表格单元格，不进正文）。"""
    target_dpi = ADAPTIVE_UPSCALE.get(dpi, 350)
    upscaled = v1.render_page(doc, page_index, target_dpi)
    scale = target_dpi / dpi
    h, w = upscaled.shape[:2]
    x0, y0, x1, y1 = [int(v * scale) for v in table_bbox]
    crop = upscaled[max(0, y0 - 8):min(h, y1 + 8), max(0, x0 - 8):min(w, x1 + 8)]
    if crop.size == 0:
        return []
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    lines = v1.ocr_lines(engine, cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB))
    for line in lines:
        bx = line['bbox']
        line['bbox'] = [round(table_bbox[0] + bx[0] / scale, 1),
                        round(table_bbox[1] + bx[1] / scale, 1),
                        round(table_bbox[0] + bx[2] / scale, 1),
                        round(table_bbox[1] + bx[3] / scale, 1)]
        line['bboxOriginal'] = line['bbox']  # 已是原始页面坐标
    return lines


def doc_watermark_stats(doc_pages_lines: dict[str, list[list[dict]]]) -> set[str]:
    """跨页重复水印统计：同一 PDF 内出现在 >=3 页顶部的短文本。"""
    counter: dict[str, set[int]] = defaultdict(set)
    for pdf, pages in doc_pages_lines.items():
        counts: dict[str, set[int]] = defaultdict(set)
        for page_index, lines in pages.items():
            for line in lines:
                text = line['text'].strip()
                if 3 <= len(text) <= 40 and not QNO.match(text):
                    counts[text].add(page_index)
        for text, page_set in counts.items():
            if len(page_set) >= 3:
                counter[text] |= page_set
    return {text for text, pages in counter.items() if len(pages) >= 3}


_ENGINE = None


def get_engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr import RapidOCR
        _ENGINE = RapidOCR()
    return _ENGINE


def process_page(engine, doc, page_index: int, cfg: dict, out_dir: Path,
                 page_key: str, watermark_texts: set[str]) -> dict:
    started = time.perf_counter()
    dpi = cfg['dpi']
    rgb = v1.render_page(doc, page_index, dpi)
    processed, angle, matrix = preprocess_v2(rgb, cfg)
    candidates = [processed]
    if cfg['multicandidate'] and (cfg['clahe'] or cfg['deskew']):
        plain, _, _ = preprocess_v2(rgb, {**cfg, 'clahe': 0, 'deskew': 0})
        candidates = [processed, plain]
    if cfg['multicandidate']:
        lines, used_image = run_ocr_best(engine, candidates)
    else:
        used_image = processed
        lines = v1.ocr_lines(engine, processed)
    if cfg['adaptive']:
        lines = adaptive_rerender(doc, page_index, lines, dpi, matrix)
    for line in lines:
        line['bboxOriginal'] = v1.bbox_to_original(line['bbox'], matrix)

    text_boxes = [(int(b[0]), int(b[1]), int(b[2]), int(b[3])) for b in
                  (line['bbox'] for line in lines)]
    gray_for_layout = used_image if used_image.ndim == 2 else \
        cv2.cvtColor(used_image, cv2.COLOR_RGB2GRAY)
    grid = v1.detect_ruling_grid(gray_for_layout)
    page_h, page_w = rgb.shape[:2]
    candidates_fig = v1.pdf_image_rects(doc[page_index], page_w, page_h, dpi)
    candidates_fig += [v1.bbox_to_original(f['bbox'], matrix)
                       for f in v1.detect_figure_regions(gray_for_layout, text_boxes)]
    figures = v1.merge_figure_regions(candidates_fig, page_w, page_h)

    grid_bbox_original = None
    if grid:
        h_bands, v_bands = grid
        if len(h_bands) >= 2 and len(v_bands) >= 2:
            grid_bbox_original = v1.bbox_to_original(
                [min(v_bands), min(h_bands), max(v_bands), max(h_bands)], matrix)
    figure_bboxes = [f['bbox'] for f in figures]
    if grid_bbox_original and any(v1.iou(grid_bbox_original, fb) > 0.5 for fb in figure_bboxes):
        grid_bbox_original = None  # 图表网格线误判护栏
    if grid_bbox_original and cfg['region_ocr']:
        table_lines = region_ocr_table(engine, doc, page_index, dpi, grid_bbox_original)
    else:
        table_lines = []

    prose: list[dict] = []
    chart_labels: list[dict] = []
    table_cells: list[dict] = list(table_lines)
    for line in lines:
        if table_lines and grid_bbox_original and \
                v1.inside(line['bboxOriginal'], grid_bbox_original):
            continue  # 区域级 OCR 已重识别表格内容
        if grid_bbox_original and v1.inside(line['bboxOriginal'], grid_bbox_original):
            table_cells.append(line)
            continue
        if any(v1.inside(line['bboxOriginal'], fb) for fb in figure_bboxes):
            chart_labels.append(line)
            continue
        prose.append(line)

    if cfg['watermark']:
        before = len(prose)
        prose = [l for l in prose if l['text'].strip() not in watermark_texts]
        watermark_removed = before - len(prose)
    else:
        watermark_removed = 0

    if cfg['reading_order']:
        prose = sort_reading_order(prose)
    else:
        prose = sorted(prose, key=lambda l: (l['bbox'][1], l['bbox'][0]))

    regions = []
    crops_dir = out_dir / 'crops'
    if grid_bbox_original:
        regions.append({'type': 'table', 'bbox': grid_bbox_original, 'text': '',
                        'confidence': 0.7, 'cells': len(table_cells),
                        'crop': v1.save_crop(rgb, grid_bbox_original,
                                             crops_dir / f'{page_key}-table.png')})
    for index, fb in enumerate(figure_bboxes):
        regions.append({'type': 'figure', 'bbox': fb, 'text': '', 'confidence': 0.65,
                        'crop': v1.save_crop(rgb, fb, crops_dir / f'{page_key}-fig{index}.png')})
    prose_text = '\n'.join(line['text'] for line in prose)
    if prose_text:
        regions.append({'type': 'text',
                        'bbox': [min(l['bboxOriginal'][0] for l in prose),
                                 min(l['bboxOriginal'][1] for l in prose),
                                 max(l['bboxOriginal'][2] for l in prose),
                                 max(l['bboxOriginal'][3] for l in prose)],
                        'text': prose_text,
                        'confidence': round(sum(l['score'] for l in prose) / len(prose), 4),
                        'crop': ''})

    classification = v1.classify_page(0, lines, len(figures), grid is not None,
                                      sum(1 for o in doc[page_index].get_objects(max_depth=4)
                                          if o.type == 3))
    page_json = {
        'pageId': page_key, 'page': page_index + 1, 'dpi': dpi,
        'deskewAngle': angle, 'classification': classification,
        'regions': regions,
        'tableCells': [{'bbox': c['bboxOriginal'], 'text': c['text'], 'score': c['score']}
                       for c in table_cells],
        'chartLabels': [{'bbox': c['bboxOriginal'], 'text': c['text'], 'score': c['score']}
                        for c in chart_labels],
        'questions': assemble_questions(prose) if cfg['reading_order'] else [],
        'watermarkRemovedLines': watermark_removed,
        'anomalies': v1.numeric_anomalies([l['text'] for l in lines]),
        'lowConfidenceLines': sum(1 for l in lines if l['score'] < 0.72),
        'ocrLineCount': len(lines),
        'rawLines': [{'text': l['text'], 'bbox': l['bboxOriginal'], 'score': l['score']}
                     for l in lines],
        'timeMs': int((time.perf_counter() - started) * 1000),
    }
    return page_json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['run'])
    parser.add_argument('set_name', choices=['tuning', 'validation', 'heldout', 'all'])
    parser.add_argument('run_name')
    parser.add_argument('--config', default='')
    args = parser.parse_args()
    cfg = parse_config(args.config)

    golden = json.loads((BENCH / 'golden-set.json').read_text(encoding='utf-8'))
    pages = golden['pages']
    if args.set_name != 'all':
        pages = [p for p in pages if p['set'] == args.set_name]
    out_dir = EXP_DIR / 'exp-worker2' / 'runs' / args.run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    # 预扫：各 PDF 的行级水印统计（watermark 开关的文档级信息）
    watermark_texts: set[str] = set()
    if cfg['watermark']:
        doc_pages_lines: dict[str, dict[int, list[dict]]] = defaultdict(dict)
        pdf_cache: dict[str, object] = {}
        try:
            for meta in pages:
                rel = meta['relPath']
                if rel not in pdf_cache:
                    pdf_cache[rel] = pdfium.PdfDocument(resolve_pdf_path(rel))
                page_json = v1.process_page(
                    get_engine(), pdf_cache[rel], meta['page'] - 1, out_dir,
                    'wm-' + meta['pageId'], dpi=200)
                doc_pages_lines[rel][meta['page'] - 1] = page_json['rawLines']
        finally:
            for doc in pdf_cache.values():
                v1.close_doc(doc)
        watermark_texts = doc_watermark_stats(doc_pages_lines)

    engine = get_engine()
    results = []
    by_pdf: dict[str, list[dict]] = defaultdict(list)
    for meta in pages:
        by_pdf[meta['relPath']].append(meta)
    for rel, metas in by_pdf.items():
        doc = pdfium.PdfDocument(resolve_pdf_path(rel))
        try:
            for meta in metas:
                page_json = process_page(engine, doc, meta['page'] - 1, cfg, out_dir,
                                         meta['pageId'], watermark_texts)
                page_json['autoType'] = meta['pageType']
                page_json['set'] = meta['set']
                if meta['pageType'] == '资料分析表格' or meta['pageType'] == '资料分析统计图':
                    page_json['ziliao'] = v1.extract_ziliao(page_json, out_dir, meta['pageId'])
                elif meta['pageType'] == '图形推理':
                    page_json['tuitui'] = v1.extract_tuitui(page_json, out_dir, meta['pageId'])
                results.append(page_json)
                print(f"[v2] {meta['pageId']} lines={page_json['ocrLineCount']} "
                      f"{page_json['timeMs']}ms", flush=True)
        finally:
            v1.close_doc(doc)
    (out_dir / 'pages.json').write_text(json.dumps({
        'engine': f'exp-worker2({json.dumps(cfg, sort_keys=True)})',
        'config': cfg, 'peakRssMb': peak_rss_mb(), 'pages': results,
    }, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({'done': args.run_name, 'pages': len(results),
                      'medianMs': int(np.median([r['timeMs'] for r in results]))
                      if results else 0}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
