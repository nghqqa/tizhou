# -*- coding: utf-8 -*-
"""题舟·脏乱考公题本 高精度导入 —— 实验性 worker（阶段4-7）。

实验代码：不被生产链路引用，不改写 tools/ocr-worker.py，不删除 RapidOCR 通道。

每个页面输出：
  - 页面类型（普通文字/资料分析/图形推理候选/解析/空白封面）
  - 300 DPI 渲染 + 灰度 + 去倾斜 + 对比度增强
  - 版面分区：正文 text / 表格 table / 图表 figure / 图片 image
  - 每个区域：bbox、类型、文本、置信度、原图裁剪路径
  - 表格/图表内的数字不拼入普通正文（隔离输出）

专用输出：
  --mode ziliao    资料分析：题干文本、表格 HTML/JSON、图表原图、图表标签 OCR、
                   数字异常与低置信度告警、原始裁剪
  --mode tuitui    图形推理：题干图片、A-D 图片选项、版面坐标与绑定置信度；
                   不能确定 → manualReview=true（禁止猜标签、禁止转纯文本）
  --mode pair      解析配对：题本+解析册联合（套号/题号/版面顺序/文本相似度），
                   低置信度标记「配对待确认」；答案只来自解析册，不反向修正题干

用法：
  python exp_worker.py page <pdf> <页号1-based> [--mode plain|ziliao|tuitui] [--dpi 300] [--out DIR]
  python exp_worker.py run-benchmark <run-name> [--dpi 300]   # 跑 docs/ocr-benchmark/benchmark-pages.json
  python exp_worker.py pair <题本doc.json> <解析doc.json> [--out DIR]
产物写在 --out（缺省 TIZHU_EXP_DIR，仓库外），不污染工作区。
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from winmem import peak_rss_mb  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
EXP_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp'))
DEFAULT_DPI = 300
TEXT_LAYER_MIN_CHARS = 50
MAX_SKEW_DEG = 5.0
# 数字流（统计图坐标轴残渣）判定：与生产 import-quality.ts 同口径
NUMERIC_TOKEN = re.compile(r'^[-+]?[\d,，]+(?:\.\d+)?[%％]?$')
ANSWER_MARK = re.compile(r'【参考答案(?:及正确率)?】\s*([A-D]+)(?:[，,]\s*(\d{1,3})\s*%)?')
EXPLAIN_MARK = re.compile(r'【实战解析】')
QNO = re.compile(r'^\s*(\d{1,3})\s*[.、．](?!\d)\s*(.*)$')
OPTION = re.compile(r'^([A-D])\s*[.、．]?\s*(.*)$')
# 范围答案格（四海系答案册实测版式）：「21-25 DACDD」「15-20CBDCB」，冒号可缺省
ANSWER_RANGE = re.compile(r'^\s*(\d{1,3})\s*[-—~]\s*(\d{1,3})\s*[:：]?\s*([A-Da-d]{1,30})\s*$')
ORIGIN_PREFIX = re.compile(r'^[（(]\s*\d{4}\s*年[^）)]{0,24}[）)]')
# 段标题（四海系双侧都印：「类比刷题1」「定义刷题2」）——比行号回退更可靠的套对齐信号
TITLE_LINE = re.compile(r'^\s*([\u4e00-\u9fff]{1,6}刷题\s*\d{1,3}|第\s*\d{1,3}\s*套)\s*$')


# ---------------------------------------------------------------- 图像处理
def render_page(doc, page_index: int, dpi: int) -> np.ndarray:
    page = doc[page_index]
    bitmap = page.render(scale=dpi / 72)
    return np.asarray(bitmap.to_pil().convert('RGB'))


def close_doc(doc) -> None:
    """pypdfium2 close 与 GC 弱引用回收存在竞态（Set changed size during
    iteration），实验工具允许吞掉该错误，资源随进程退出释放。"""
    try:
        close_doc(doc)
    except RuntimeError:
        pass


def preprocess(rgb: np.ndarray) -> tuple[np.ndarray, float, np.ndarray]:
    """返回 (预处理图, 去倾斜角度[度, 逆时针为正], 逆旋转映射矩阵 M 的逆)。

    灰度 → CLAHE 对比度增强 → Hough 估计倾斜 → 旋转矫正。
    OCR 在矫正后的图上跑；bbox 用 M 逆映射回原始页面坐标。
    """
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    angle = 0.0
    edges = cv2.Canny(enhanced, 80, 160)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=300,
                            minLineLength=enhanced.shape[1] // 3, maxLineGap=30)
    if lines is not None:
        segments = np.asarray(lines).reshape(-1, 4)
        angles = []
        for x1, y1, x2, y2 in segments:
            dx, dy = float(x2 - x1), float(y2 - y1)
            if abs(dx) < 1e-6:
                continue
            deg = float(np.degrees(np.arctan2(dy, dx)))
            if abs(deg) <= MAX_SKEW_DEG:
                angles.append(deg)
        if len(angles) >= 3:
            angle = float(np.median(angles))

    height, width = enhanced.shape[:2]
    center = (width / 2, height / 2)
    # cv2 正角度=逆时针；Hough 角度为图像坐标下的倾斜，旋转方向取负
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(enhanced, matrix, (width, height),
                             flags=cv2.INTER_CUBIC, borderValue=255)
    return rotated, round(angle, 2), matrix


def bbox_to_original(bbox: list[float], matrix: np.ndarray) -> list[float]:
    """矫正图 bbox [x0,y0,x1,y1] → 原始页面坐标（四角逆映射取外接框）。"""
    x0, y0, x1, y1 = bbox
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    inv = cv2.invertAffineTransform(matrix)
    mapped = [inv @ np.array([cx, cy, 1.0]) for cx, cy in corners]
    xs, ys = [float(p[0]) for p in mapped], [float(p[1]) for p in mapped]
    return [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]


def save_crop(original_rgb: np.ndarray, bbox: list[float], path: Path,
              pad: int = 6) -> str:
    height, width = original_rgb.shape[:2]
    x0 = max(0, int(bbox[0]) - pad)
    y0 = max(0, int(bbox[1]) - pad)
    x1 = min(width, int(bbox[2]) + pad)
    y1 = min(height, int(bbox[3]) + pad)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return ''
    path.parent.mkdir(parents=True, exist_ok=True)
    # cv2.imwrite 在 Windows 不支持非 ASCII 路径，用 imencode + 字节写入
    ok, encoded = cv2.imencode('.png', cv2.cvtColor(original_rgb[y0:y1, x0:x1],
                                                    cv2.COLOR_RGB2BGR))
    if ok:
        path.write_bytes(encoded.tobytes())
    return str(path).replace('\\', '/') if ok else ''


# ---------------------------------------------------------------- 版面分析
def detect_ruling_grid(image: np.ndarray) -> tuple[list[float], list[float]] | None:
    """检测表格横竖线：≥2 条水平线且 ≥2 条垂直线则认为存在网格。"""
    binary = cv2.adaptiveThreshold(255 - image, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                   cv2.THRESH_BINARY, 15, -2)
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                                  cv2.getStructuringElement(cv2.MORPH_RECT, (image.shape[1] // 20, 1)))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN,
                                cv2.getStructuringElement(cv2.MORPH_RECT, (1, image.shape[0] // 40)))
    h_proj = horizontal.sum(axis=1)
    v_proj = vertical.sum(axis=0)
    h_lines = [i for i in range(image.shape[0]) if h_proj[i] > 255 * image.shape[1] * 0.35]
    v_lines = [i for i in range(image.shape[1]) if v_proj[i] > 255 * image.shape[0] * 0.15]
    h_bands = _merge_bands(h_lines, 6)
    v_bands = _merge_bands(v_lines, 6)

    if len(h_bands) >= 2 and len(v_bands) >= 2:
        return h_bands, v_bands
    return None


def _merge_bands(positions: list[int], gap: int) -> list[int]:
    if not positions:
        return []
    bands, start, prev = [], positions[0], positions[0]
    for pos in positions[1:]:
        if pos - prev > gap:
            bands.append((start + prev) // 2)
            start = pos
        prev = pos
    bands.append((start + prev) // 2)
    return bands


def detect_figure_regions(image: np.ndarray, text_boxes: list[tuple[int, int, int, int]]) -> list[dict]:
    """非文字图片区域（矢量图表兜底）：剔除 OCR 文本框后，取大块高边缘密度连通域。"""
    edges = cv2.Canny(image, 60, 150)
    mask = np.full_like(edges, 255)
    for x0, y0, x1, y1 in text_boxes:
        cv2.rectangle(mask, (x0, y0), (x1, y1), 0, -1)
    # mask 在文本框外为 255：只保留非文字区域的边缘
    masked = cv2.bitwise_and(edges, edges, mask=mask)
    masked = cv2.dilate(masked, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(masked, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    page_area = image.shape[0] * image.shape[1]
    regions = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w * h < page_area * 0.012 or h < 40 or w < 60:
            continue
        if x < 10 and y < 10 and w > image.shape[1] * 0.95 and h < image.shape[0] * 0.06:
            continue  # 页眉横线带
        regions.append({'bbox': [x, y, x + w, y + h], 'area': int(w * h)})
    regions.sort(key=lambda r: (r['bbox'][1], r['bbox'][0]))
    return regions


def pdf_image_rects(page, render_width: int, render_height: int,
                    dpi: int) -> list[list[float]]:
    """直接读取 PDF 图片对象的页面坐标（位图题图/选项图的主信号，比边缘检测可靠）。

    pypdfium2 get_pos() 返回 (left, bottom, right, top)，原点在左下；
    转成渲染像素坐标（原点左上）。
    """
    rects: list[list[float]] = []
    try:
        pw, ph = page.get_size()
    except Exception:
        return rects
    scale_x, scale_y = render_width / pw, render_height / ph
    try:
        for obj in page.get_objects(max_depth=4):
            if obj.type != 3:
                continue
            try:
                left, bottom, right, top = obj.get_pos()
            except Exception:
                continue
            if right - left <= 1 or top - bottom <= 1:
                continue
            rects.append([round(left * scale_x, 1), round((ph - top) * scale_y, 1),
                          round(right * scale_x, 1), round((ph - bottom) * scale_y, 1)])
    except Exception:
        pass
    return rects


def _iou(a: list[float], b: list[float]) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def merge_figure_regions(candidate_bboxes: list[list[float]],
                         page_w: int, page_h: int) -> list[dict]:
    """合并图片对象矩形与边缘检测区域；过滤页眉通栏横幅与碎片噪声。"""
    merged: list[dict] = []
    page_area = float(page_w * page_h)
    for bbox in candidate_bboxes:
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w < 60 or h < 40 or w * h < page_area * 0.004:
            continue
        # 通栏页眉横幅：贴顶 + 占宽 55% 以上（四海/花生卷首 logo 条）
        if bbox[1] < page_h * 0.10 and w > page_w * 0.55:
            continue
        if any(_iou(bbox, kept['bbox']) > 0.4 for kept in merged):
            continue
        merged.append({'bbox': [round(v, 1) for v in bbox], 'area': int(w * h)})
    merged.sort(key=lambda r: (r['bbox'][1], r['bbox'][0]))
    return merged


def ocr_lines(engine, image: np.ndarray) -> list[dict]:
    result = engine(image)
    lines = []
    if result is None or result.txts is None:
        return lines
    for text, box, score in zip(result.txts, result.boxes, result.scores):
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        lines.append({'text': str(text).strip(),
                      'bbox': [round(min(xs), 1), round(min(ys), 1),
                               round(max(xs), 1), round(max(ys), 1)],
                      'score': round(float(score), 4)})
    return lines


def center_y(bbox: list[float]) -> float:
    return (bbox[1] + bbox[3]) / 2


def overlap_ratio(a: list[float], b: list[float]) -> float:
    """两框 x 轴投影的重叠占比（相对较窄者），用于 2x2 网格列对齐判断。"""
    x0, x1 = max(a[0], b[0]), min(a[2], b[2])
    inter = max(0.0, x1 - x0)
    width_a = max(0.0, a[2] - a[0])
    width_b = max(0.0, b[2] - b[0])
    return inter / max(1e-6, min(width_a, width_b))


def inside(inner: list[float], outer: list[float]) -> bool:
    cx = (inner[0] + inner[2]) / 2
    cy = (inner[1] + inner[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def is_number_stream(text: str) -> bool:
    if re.search(r'[\u4e00-\u9fff]', text):
        return False
    tokens = text.split()
    if len(tokens) < 6:
        return False
    numeric = sum(1 for t in tokens if NUMERIC_TOKEN.match(t))
    return numeric / len(tokens) >= 0.6


def numeric_anomalies(lines: list[str]) -> dict:
    """数字异常扫描：数字流 / 多小数点 / 全角数字（与 import-quality.ts 同口径，只告警不改写）。"""
    count, streams, samples = 0, 0, []
    for text in lines:
        kind = None
        if is_number_stream(text):
            streams += 1
            kind = '数字流'
        elif re.search(r'\d\.\d+\.\d', text):
            kind = '多小数点'
        elif re.search(r'[０-９]', text):
            kind = '全角数字'
        if kind:
            count += 1
            if len(samples) < 5:
                samples.append(f'[{kind}] {text[:60]}')
    return {'count': count, 'numberStreamLines': streams, 'samples': samples}


# ---------------------------------------------------------------- 页面分类
def classify_page(text_layer_chars: int, lines: list[dict], figures: int,
                  grid: bool, pdf_images: int) -> dict:
    """确定性规则分类。返回 {type, signals, confidence}。"""
    full_text = ' '.join(line['text'] for line in lines)
    signals = {'textLayerChars': text_layer_chars, 'ocrLines': len(lines),
               'figureRegions': figures, 'hasGrid': grid, 'pdfImageObjects': pdf_images}
    numeric_tokens = len(re.findall(r'\d[\d,.%]*', full_text))
    if ANSWER_MARK.search(full_text) or EXPLAIN_MARK.search(full_text):
        return {'type': '解析', 'signals': signals, 'confidence': 0.9}
    if pdf_images >= 3 and len(lines) < 30:
        return {'type': '图形推理候选', 'signals': signals, 'confidence': 0.75}
    if figures >= 2 and (grid or numeric_tokens >= 60):
        return {'type': '资料分析', 'signals': signals, 'confidence': 0.8}
    if grid and numeric_tokens >= 30:
        return {'type': '资料分析', 'signals': signals, 'confidence': 0.7}
    if len(lines) <= 3 and text_layer_chars < 5 and figures == 0:
        return {'type': 'blank-or-cover', 'signals': signals, 'confidence': 0.85}
    return {'type': '普通文字', 'signals': signals, 'confidence': 0.6}


# ---------------------------------------------------------------- 页面管线
def process_page(engine, doc, page_index: int, out_dir: Path, page_key: str,
                 dpi: int = DEFAULT_DPI) -> dict:
    """单页全管线，返回页面 JSON（含区域与裁剪路径）。"""
    started = time.perf_counter()
    rgb = render_page(doc, page_index, dpi)
    text_layer_chars = 0
    try:
        text = doc[page_index].get_textpage().get_text_range()
        text_layer_chars = len(text.strip()) if isinstance(text, str) else 0
    except Exception:
        pass
    pdf_images = sum(1 for obj in doc[page_index].get_objects(max_depth=4) if obj.type == 3)

    processed, angle, matrix = preprocess(rgb)
    lines = ocr_lines(engine, processed)
    # bbox 映射回原始页面坐标（便于裁剪与人工对照）
    for line in lines:
        line['bboxOriginal'] = bbox_to_original(line['bbox'], matrix)

    text_boxes = [(int(b[0]), int(b[1]), int(b[2]), int(b[3])) for b in
                  (line['bbox'] for line in lines)]
    grid = detect_ruling_grid(processed)

    # 图形区域：PDF 图片对象（主信号，原始坐标）+ 边缘检测（矢量图表兜底，
    # 矫正坐标 → 原始坐标），统一去横幅/去重
    page_h_px, page_w_px = rgb.shape[:2]
    candidates = pdf_image_rects(doc[page_index], page_w_px, page_h_px, dpi)
    candidates += [bbox_to_original(f['bbox'], matrix)
                   for f in detect_figure_regions(processed, text_boxes)]
    figures = merge_figure_regions(candidates, page_w_px, page_h_px)

    classification = classify_page(text_layer_chars, lines, len(figures),
                                   grid is not None, pdf_images)

    # 分区：表格网格框 / 图表区 / 正文（全部使用原始页面坐标）
    grid_bbox_original = None
    if grid:
        h_bands, v_bands = grid
        if len(h_bands) >= 2 and len(v_bands) >= 2:
            grid_processed = [min(v_bands), min(h_bands), max(v_bands), max(h_bands)]
            grid_bbox_original = bbox_to_original(grid_processed, matrix)
    figure_bboxes = [f['bbox'] for f in figures]

    # 网格框若与图片对象（统计图）高度重叠，是图表网格线而非表格——
    # 丢弃表格判定，让其中的数字作为图表标签隔离输出
    if grid_bbox_original:
        for fb in figure_bboxes:
            if _iou(grid_bbox_original, fb) > 0.5:
                grid_bbox_original = None
                break

    prose: list[dict] = []
    chart_labels: list[dict] = []
    table_cells: list[dict] = []
    for line in lines:
        if grid_bbox_original and inside(line['bboxOriginal'], grid_bbox_original):
            table_cells.append(line)
            continue
        if any(inside(line['bboxOriginal'], fb) for fb in figure_bboxes):
            chart_labels.append(line)
            continue
        prose.append(line)

    regions: list[dict] = []
    crops_dir = out_dir / 'crops'
    if grid_bbox_original:
        regions.append({
            'type': 'table', 'bbox': grid_bbox_original,
            'text': '', 'confidence': 0.7, 'cells': len(table_cells),
            'crop': save_crop(rgb, grid_bbox_original,
                              crops_dir / f'{page_key}-table.png'),
        })
    for index, fb in enumerate(figure_bboxes):
        regions.append({
            'type': 'figure', 'bbox': fb, 'text': '', 'confidence': 0.65,
            'crop': save_crop(rgb, fb, crops_dir / f'{page_key}-fig{index}.png'),
        })
    prose_text = '\n'.join(line['text'] for line in prose)
    if prose_text:
        xs0 = min(line['bboxOriginal'][0] for line in prose)
        ys0 = min(line['bboxOriginal'][1] for line in prose)
        xs1 = max(line['bboxOriginal'][2] for line in prose)
        ys1 = max(line['bboxOriginal'][3] for line in prose)
        regions.append({
            'type': 'text', 'bbox': [xs0, ys0, xs1, ys1],
            'text': prose_text,
            'confidence': round(sum(l['score'] for l in prose) / len(prose), 4),
            'crop': '',
        })

    page_json = {
        'page': page_index + 1,
        'dpi': dpi,
        'deskewAngle': angle,
        'classification': classification,
        'textLayerChars': text_layer_chars,
        'pdfImageObjects': pdf_images,
        'regions': regions,
        'tableCells': [{'bbox': c['bboxOriginal'], 'text': c['text'], 'score': c['score']}
                       for c in table_cells],
        'chartLabels': [{'bbox': c['bboxOriginal'], 'text': c['text'], 'score': c['score']}
                        for c in chart_labels],
        'anomalies': numeric_anomalies([l['text'] for l in lines]),
        'lowConfidenceLines': sum(1 for l in lines if l['score'] < 0.72),
        'ocrLineCount': len(lines),
        # 原始 OCR 行全量保留：回归测试用它证明分区没有静默丢行/丢题
        'rawLines': [{'text': l['text'], 'bbox': l['bboxOriginal'], 'score': l['score']}
                     for l in lines],
        'timeMs': int((time.perf_counter() - started) * 1000),
    }
    return page_json


# ---------------------------------------------------------------- 资料分析专用
def extract_ziliao(page_json: dict, out_dir: Path, page_key: str) -> dict:
    """资料分析专用输出：题干/表格HTML+JSON/图表图/标签OCR/数字告警/裁剪。"""
    prose = next((r for r in page_json['regions'] if r['type'] == 'text'), None)
    table_region = next((r for r in page_json['regions'] if r['type'] == 'table'), None)
    figures = [r for r in page_json['regions'] if r['type'] == 'figure']

    table_html = ''
    table_json = None
    if table_region and page_json['tableCells']:
        table_json, table_html = build_table(page_json['tableCells'])

    stem = ''
    options: list[dict] = []
    if prose:
        current_q: int | None = None
        for line in prose['text'].split('\n'):
            match = QNO.match(line)
            if match:
                current_q = int(match.group(1))
                stem += (line.strip() + '\n')
                continue
            opt = OPTION.match(line)
            if opt:
                options.append({'key': opt.group(1), 'text': opt.group(2)})
            elif current_q is not None:
                stem += line + '\n'

    warnings = []
    if page_json['anomalies']['count']:
        warnings.append(f"数字异常 {page_json['anomalies']['count']} 处，请对照原图核对")
    if page_json['lowConfidenceLines'] / max(1, page_json['ocrLineCount']) > 0.2:
        warnings.append(f"低置信度行 {page_json['lowConfidenceLines']} 行")
    if table_region and table_json and not table_json['completeGrid']:
        warnings.append('表格网格不完整，单元格归属为启发式结果，必须人工核对')
    if not table_region and figures:
        warnings.append('未检出表格网格线，若原书为无边框表请人工补录')

    return {
        'page': page_json['page'],
        'stem': stem.strip(),
        'options': options,
        'table': table_json,
        'tableHtml': table_html,
        'tableCrop': table_region['crop'] if table_region else '',
        'charts': [{'bbox': f['bbox'], 'crop': f['crop'],
                    'labels': [c for c in page_json['chartLabels']
                               if inside(c['bbox'], f['bbox'])]}
                   for f in figures],
        'warnings': warnings,
        'anomalies': page_json['anomalies'],
        'crops': [r['crop'] for r in page_json['regions'] if r.get('crop')],
    }


def build_table(cells: list[dict]) -> tuple[dict, str]:
    """把带 bbox 的单元格按坐标聚成行列，输出 JSON 与 HTML。不做语义猜测。"""
    ys = sorted({round(c['bbox'][1] / 10) * 10 for c in cells})
    rows: list[list[dict]] = []
    for y in ys:
        row = [c for c in cells if abs(c['bbox'][1] - y) <= 10]
        row.sort(key=lambda c: c['bbox'][0])
        if row and (not rows or row[0]['text'] != rows[-1][0]['text'] or len(row) != len(rows[-1])):
            rows.append(row)
    ncols = max(len(r) for r in rows) if rows else 0
    grid_rows = []
    for row in rows:
        while len(row) < ncols:
            row.append({'text': '', 'score': 0})
        grid_rows.append([{'text': c['text'], 'score': c['score']} for c in row])
    table_json = {
        'rows': grid_rows,
        'rowsc': len(grid_rows),
        'cols': ncols,
        'completeGrid': all(len(r) == ncols for r in rows) and bool(ncols),
        'minCellScore': min((c['score'] for r in grid_rows for c in r), default=0),
    }
    html = ['<table>']
    for row in grid_rows:
        html.append('<tr>' + ''.join(f'<td>{c["text"]}</td>' for c in row) + '</tr>')
    html.append('</table>')
    return table_json, '\n'.join(html)


# ---------------------------------------------------------------- 图形推理专用
def extract_tuitui(page_json: dict, out_dir: Path, page_key: str) -> dict:
    """图形推理专用输出：题干图 + A-D 图片选项绑定 + 人工审核门。

    禁止：猜选项标签（不确定就 manualReview）、转纯文本题、把题干图当选项。
    """
    figures = [r for r in page_json['regions'] if r['type'] == 'figure']
    prose = next((r for r in page_json['regions'] if r['type'] == 'text'), None)
    stem_text = prose['text'] if prose else ''

    stem_images: list[dict] = []
    options: list[dict] = []
    manual_review = False
    binding_confidence = 0.0
    note = ''

    def area(b: list[float]) -> float:
        return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])

    # 按垂直带聚类（同一行的图归一带）
    bands: list[list[dict]] = []
    for figure in sorted(figures, key=lambda f: center_y(f['bbox'])):
        placed = False
        for band in bands:
            if abs(center_y(figure['bbox']) - center_y(band[0]['bbox'])) < \
                    (figure['bbox'][3] - figure['bbox'][1]):
                band.append(figure)
                placed = True
                break
        if not placed:
            bands.append([figure])

    option_band: list[dict] | None = None
    grid_2x2: bool = False
    for band in bands:
        if len(band) == 4:
            areas = sorted(area(f['bbox']) for f in band)
            median = areas[2]
            if median > 0 and areas[0] >= median * 0.4 and areas[0] <= median * 1.6:
                option_band = band
                stem_band = [f for b in bands if b is not band for f in b]
                stem_images = [{'bbox': f['bbox'], 'crop': f['crop']} for f in stem_band]
                break

    if option_band is None and len(bands) >= 2:
        # 2x2 网格版式：恰好两条带、各 2 图、列位置跨带对齐、尺寸相近
        if len(bands) == 2 and all(len(band) == 2 for band in bands) \
                and sum(len(b) for b in bands) == 4:
            row0, row1 = sorted(bands, key=lambda b: center_y(b[0]['bbox']))
            row0.sort(key=lambda f: f['bbox'][0])
            row1.sort(key=lambda f: f['bbox'][0])
            areas = [area(f['bbox']) for f in row0 + row1]
            spread = max(areas) / max(1e-6, min(areas))
            col_overlap_0 = overlap_ratio(row0[0]['bbox'], row1[0]['bbox'])
            col_overlap_1 = overlap_ratio(row0[1]['bbox'], row1[1]['bbox'])
            if spread <= 2.2 and col_overlap_0 >= 0.3 and col_overlap_1 >= 0.3:
                option_band = row0 + row1
                grid_2x2 = True
                stem_band = [f for b in bands if b is not row0 and b is not row1 for f in b]
                stem_images = [{'bbox': f['bbox'], 'crop': f['crop']} for f in stem_band]

    if option_band:
        option_band.sort(key=lambda f: (center_y(f['bbox']), f['bbox'][0])
                         if not grid_2x2 else f['bbox'][0])
        if grid_2x2:
            row0, row1 = option_band[:2], option_band[2:]
            ordered = [row0[0], row0[1], row1[0], row1[1]]  # 阅读序：左上/右上/左下/右下
        else:
            ordered = option_band
        keys = ['A', 'B', 'C', 'D']
        areas = [area(f['bbox']) for f in ordered]
        spread = max(areas) / max(1e-6, min(areas))
        binding_confidence = (0.75 if spread <= 1.5 else 0.55) if grid_2x2 \
            else (0.85 if spread <= 1.5 else 0.6)
        for key, figure in zip(keys, ordered):
            options.append({'key': key, 'bbox': figure['bbox'], 'crop': figure['crop'],
                            'bindingConfidence': binding_confidence})
        note = ('4 图按 2x2 网格阅读序绑定 A-D' if grid_2x2
                else '4 图按版面顺序绑定 A-D') + '（不判定图形规律）'
    else:
        manual_review = True
        stem_images = [{'bbox': f['bbox'], 'crop': f['crop']} for f in figures]
        if figures:
            note = (f'图片数 {len(figures)} 无法可靠绑定 A-D（4 图一行或 2x2 网格），'
                    '进入人工审核；不猜标签')
        else:
            note = '未检出图片区域，进入人工审核'

    return {
        'page': page_json['page'],
        'stemText': stem_text[:400],
        'stemImages': stem_images,
        'options': options,
        'manualReview': manual_review,
        'bindingConfidence': binding_confidence,
        'note': note,
        'questionType': 'graphic-image' if (stem_images or options) else 'text-only-uncertain',
    }


# ---------------------------------------------------------------- 解析配对
def extract_solutions(engine, pdf_path: str, out_dir: Path, dpi: int,
                      max_pages: int | None = None) -> list[dict]:
    """解析册逐页 → 解析条目。支持两种真实版式：
    - 标记块：题号行 + 【参考答案】X（花生/超格系解析册）
    - 范围答案格：「21-25 DACDD」（四海系答案册），按位置展开为逐题答案
    答案只来自解析册文本；题本侧永远不被反向修正。"""
    doc = pdfium.PdfDocument(pdf_path)
    entries: list[dict] = []
    grid_expected_next: int | None = None
    grid_section = 0
    mark_section = 0
    prev_num: int | None = None
    current_title = ''
    try:
        total = min(len(doc), max_pages) if max_pages else len(doc)
        for page_index in range(total):
            page_json = process_page(engine, doc, page_index, out_dir,
                                     f'sol-p{page_index + 1:04d}', dpi)
            prose = next((r for r in page_json['regions'] if r['type'] == 'text'), None)
            if not prose:
                continue
            current: dict | None = None
            for line in prose['text'].split('\n'):
                title = TITLE_LINE.match(line)
                if title:
                    current_title = re.sub(r'\s+', '', title.group(1))
                    continue
                grid = ANSWER_RANGE.match(line)
                if grid:
                    start, end, letters = int(grid.group(1)), int(grid.group(2)), grid.group(3)
                    count = end - start + 1
                    if start == 1 or (grid_expected_next is not None
                                      and start - grid_expected_next >= 2):
                        grid_section += 1
                    grid_expected_next = end + 1
                    for offset in range(count):
                        ambiguous = offset >= len(letters) or count != len(letters)
                        entries.append({
                            'kind': 'grid', 'set': grid_section, 'num': start + offset,
                            'section': current_title, 'order': len(entries),
                            'page': page_index + 1, 'stemExcerpt': '',
                            'answer': letters[offset].upper() if offset < len(letters) else '',
                            'ambiguous': ambiguous, 'explanation': ''})
                    current = None
                    continue
                match = QNO.match(line)
                if match:
                    num = int(match.group(1))
                    if prev_num is not None and num < prev_num:
                        mark_section += 1  # 题号回退 → 新套/新段落
                    prev_num = num
                    if current:
                        entries.append(current)
                    current = {'kind': 'mark', 'set': mark_section + 1, 'num': num,
                               'section': current_title,
                               'order': len(entries), 'page': page_index + 1,
                               'stemExcerpt': match.group(2)[:60], 'answer': '',
                               'rate': None, 'explanation': ''}
                    continue
                if ANSWER_RANGE.search(line) and current is None:
                    continue
                if current is None:
                    continue
                answer = ANSWER_MARK.search(line)
                if answer:
                    current['answer'] = answer.group(1)
                    if answer.group(2):
                        current['rate'] = int(answer.group(2)) / 100
                if EXPLAIN_MARK.search(line):
                    current['explanation'] += line
                else:
                    current['explanation'] += line + '\n'
            if current:
                entries.append(current)
    finally:
        close_doc(doc)
    return entries


def extract_booklet_questions(engine, pdf_path: str, out_dir: Path, dpi: int,
                              max_pages: int | None = None) -> list[dict]:
    """题本逐页 → 题目条目（套/题号/题干摘录/页序）。

    题号回退（1..N 后又出现 1）视为新套重起，set 递增——四海系一册多段、
    花生系一册多套都靠这个结构信号切套。题干绝不被答案反向修正。"""
    doc = pdfium.PdfDocument(pdf_path)
    questions: list[dict] = []
    section = 0
    prev_num: int | None = None
    current_title = ''
    try:
        total = min(len(doc), max_pages) if max_pages else len(doc)
        for page_index in range(total):
            page_json = process_page(engine, doc, page_index, out_dir,
                                     f'bk-p{page_index + 1:04d}', dpi)
            prose = next((r for r in page_json['regions'] if r['type'] == 'text'), None)
            if not prose:
                continue
            current: dict | None = None
            for line in prose['text'].split('\n'):
                title = TITLE_LINE.match(line)
                if title:
                    current_title = re.sub(r'\s+', '', title.group(1))
                    continue
                match = QNO.match(line)
                if match:
                    num = int(match.group(1))
                    if prev_num is not None and num < prev_num:
                        section += 1
                    prev_num = num
                    if current:
                        questions.append(current)
                    current = {'set': section + 1, 'num': num, 'section': current_title,
                               'order': len(questions), 'page': page_index + 1,
                               'stem': match.group(2)[:80], 'options': []}
                    continue
                if current is None:
                    continue
                opt = OPTION.match(line)
                if opt:
                    current['options'].append({'key': opt.group(1), 'text': opt.group(2)[:60]})
                elif len(current['options']) == 0:
                    current['stem'] += line[:60]
            if current:
                questions.append(current)
    finally:
        close_doc(doc)
    return questions


def normalize_sim(text: str) -> str:
    return re.sub(r'[\s，。、；：？！,.;:?!()（）【】\[\]"]', '', text)


def lcs_similarity(a: str, b: str) -> float:
    """最长公共子串相似度：对解析册摘录被出处行/邻栏污染鲁棒
    （污染只影响两端与中间插入，不影响局部公共段）。"""
    a, b = normalize_sim(a), normalize_sim(b)
    if not a or not b:
        return 0.0
    matcher = difflib.SequenceMatcher(None, a, b)
    match = matcher.find_longest_match(0, len(a), 0, len(b))
    return match.size / min(len(a), len(b))


def _section_list(items: list[dict]) -> list[tuple[int, str]]:
    """条目中段落（set, 段标题）的保序去重清单。"""
    seen: set[tuple[int, str]] = set()
    out: list[tuple[int, str]] = []
    for item in items:
        key = (item['set'], (item.get('section') or '').strip())
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def pair_solutions(booklet: list[dict], solutions: list[dict]) -> dict:
    """套号+题号+版面顺序+文本相似度联合配对。

    - 段落对齐：题本窗口是解析册段落列表的前缀，按出现顺序对齐；
      双侧都有段标题（「类比刷题1」）时用 LCS 校验，标题对不上 → 待确认
    - 题本/解析双条目：段落对齐 + 题号一致 + LCS 相似度 ≥0.6 → paired
    - 答案格条目（无题干摘录）：段落对齐 + 题号一致 + 版面顺序接近 → paired
      （顺序偏离 → 配对待确认，防 OCR 误号错配）
    - 其余 → 待确认（配对待确认），绝不猜、绝不用答案字母改题干
    """
    results = []
    used_solutions: set[int] = set()
    bk_sections = _section_list(booklet)
    sol_sections = _section_list(solutions)

    # 段落映射：优先按段标题（页眉/段名，题本窗口与答案册册内位置无关）；
    # 任一侧缺标题时退化为按出现顺序前缀对齐（题本窗口是答案册章节前缀）。
    has_titles = bool(bk_sections and sol_sections
                      and any(t for _, t in bk_sections)
                      and any(t for _, t in sol_sections))
    section_map: dict[tuple[int, str], tuple[tuple[int, str], float]] = {}
    if has_titles:
        for bk_key in bk_sections:
            if not bk_key[1]:
                continue
            best = None
            for sol_key in sol_sections:
                if not sol_key[1]:
                    continue
                score = lcs_similarity(bk_key[1], sol_key[1])
                if score >= 0.6 and (best is None or score > best[1]):
                    best = (sol_key, score)
            if best:
                section_map[bk_key] = best
    else:
        for i, bk_key in enumerate(bk_sections):
            if i >= len(sol_sections):
                break
            section_map[bk_key] = (sol_sections[i], 1.0)

    solution_by_key: dict[tuple[tuple[int, str], int], int] = {}
    for i, sol in enumerate(solutions):
        solution_by_key[((sol['set'], (sol.get('section') or '').strip()),
                         sol['num'])] = i

    for question in booklet:
        bk_key = (question['set'], (question.get('section') or '').strip())
        alignment = section_map.get(bk_key)
        if alignment is None or alignment[1] < 0.4:
            results.append({'set': question['set'], 'num': question['num'],
                            'section': bk_key[1], 'answer': '',
                            'status': '配对待确认', 'confidence': 0.0,
                            'byKey': False, 'similarity': None})
            continue
        sol_key = alignment[0]
        key = (sol_key, question['num'])
        index = solution_by_key.get(key)
        if index is not None and index in used_solutions:
            # 同一答案被另一道题（OCR 误号重复）认领过：不再发布，转人工审核
            index = None
        if index is not None:
            sol = solutions[index]
            if sol.get('ambiguous'):
                # 答案格内字母数与题数不一致（OCR 误号/漏字）：只标注不发布
                results.append({'set': question['set'], 'num': question['num'],
                                'section': bk_key[1], 'answer': '',
                                'similarity': None, 'byKey': True,
                                'confidence': 0.0, 'status': '配对待确认'})
                continue
            excerpt = ORIGIN_PREFIX.sub('', sol.get('stemExcerpt') or '')
            if sol.get('kind') == 'grid' or not excerpt:
                # 结构配对：段落对齐 + 题号一致 + 版面顺序接近
                order_gap = abs(sol.get('order', 0) - question.get('order', 0))
                confidence = 0.85 if order_gap <= 3 else 0.0
                status = 'paired' if confidence > 0 else '配对待确认'
                results.append({'set': question['set'], 'num': question['num'],
                                'section': bk_key[1],
                                'answer': sol['answer'] if confidence > 0 else '',
                                'similarity': None, 'byKey': True,
                                'confidence': confidence, 'status': status})
                if confidence > 0:
                    used_solutions.add(index)
                continue
            sim = lcs_similarity(question['stem'], excerpt)
            confidence = sim if sim >= 0.6 else 0.0
            status = 'paired' if confidence > 0 else '配对待确认'
            results.append({'set': question['set'], 'num': question['num'],
                            'section': bk_key[1],
                            'answer': sol['answer'] if confidence > 0 else '',
                            'similarity': round(sim, 3), 'byKey': True,
                            'confidence': round(confidence, 3), 'status': status})
            if confidence > 0:
                used_solutions.add(index)
            continue
        results.append({'set': question['set'], 'num': question['num'],
                        'section': bk_key[1], 'answer': '',
                        'status': '配对待确认', 'confidence': 0.0,
                        'byKey': False, 'similarity': None})
    unpaired_solutions = [i for i in range(len(solutions)) if i not in used_solutions]
    paired = sum(1 for r in results if r['status'] == 'paired')
    return {
        'pairs': results,
        'summary': {
            'questions': len(booklet), 'solutions': len(solutions),
            'paired': paired,
            'pendingReview': sum(1 for r in results if r['status'] != 'paired'),
            'unusedSolutions': len(unpaired_solutions),
            'sectionsBooklet': len(bk_sections),
            'sectionsSolution': len(sol_sections),
            'answerLettersFromSolutionOnly': True,
        },
    }


# ---------------------------------------------------------------- CLI
def load_engine():
    from rapidocr import RapidOCR
    return RapidOCR()


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print(__doc__, file=sys.stderr)
        return 1
    out_root = EXP_DIR / 'exp-worker'
    mode = argv[0]

    if mode == 'page':
        pdf, page_no = argv[1], int(argv[2])
        sub = argv[argv.index('--mode') + 1] if '--mode' in argv else 'plain'
        dpi = int(argv[argv.index('--dpi') + 1]) if '--dpi' in argv else DEFAULT_DPI
        out_dir = out_root / 'pages' / f'{Path(pdf).stem}-{page_no:04d}'
        engine = load_engine()
        doc = pdfium.PdfDocument(pdf)
        try:
            page_json = process_page(engine, doc, page_no - 1, out_dir,
                                     f'p{page_no:04d}', dpi)
        finally:
            close_doc(doc)
        if sub == 'ziliao':
            page_json['ziliao'] = extract_ziliao(page_json, out_dir, f'p{page_no:04d}')
        elif sub == 'tuitui':
            page_json['tuitui'] = extract_tuitui(page_json, out_dir, f'p{page_no:04d}')
        write_json(out_dir / 'page.json', page_json)
        print(json.dumps({'out': str(out_dir / 'page.json'),
                          'type': page_json['classification']['type'],
                          'regions': len(page_json['regions'])}, ensure_ascii=False))
        return 0

    if mode == 'run-benchmark':
        run_name = argv[1]
        dpi = int(argv[argv.index('--dpi') + 1]) if '--dpi' in argv else DEFAULT_DPI
        manifest = json.loads((BENCH / 'benchmark-pages.json').read_text(encoding='utf-8'))
        out_dir = out_root / 'runs' / run_name
        engine = load_engine()
        results = []
        by_pdf: dict[str, list[dict]] = {}
        for entry in manifest['pages']:
            by_pdf.setdefault(entry['relPath'], []).append(entry)
        for rel, entries in by_pdf.items():
            doc = pdfium.PdfDocument(rel)
            try:
                for entry in entries:
                    page_key = entry['pageId']
                    page_json = process_page(engine, doc, entry['page'] - 1,
                                             out_dir, page_key, dpi)
                    page_json['pageId'] = page_key
                    page_json['autoType'] = entry['autoType']
                    if entry['autoType'] == '资料分析':
                        page_json['ziliao'] = extract_ziliao(page_json, out_dir, page_key)
                    elif entry['autoType'] == '图形推理候选':
                        page_json['tuitui'] = extract_tuitui(page_json, out_dir, page_key)
                    results.append(page_json)
                    print(f"[exp] {page_key} {page_json['classification']['type']} "
                          f"lines={page_json['ocrLineCount']} "
                          f"{page_json['timeMs']}ms", flush=True)
            finally:
                close_doc(doc)
        write_json(out_dir / 'pages.json', {
            'engine': f'exp-worker-{dpi}dpi-rapidocr', 'dpi': dpi,
            'peakRssMb': peak_rss_mb(), 'pages': results})
        print(json.dumps({'done': run_name, 'pages': len(results)}, ensure_ascii=False))
        return 0

    if mode == 'pair':
        booklet_path, solution_path = Path(argv[1]), Path(argv[2])
        booklet = json.loads(booklet_path.read_text(encoding='utf-8'))
        solutions = json.loads(solution_path.read_text(encoding='utf-8'))
        result = pair_solutions(booklet if isinstance(booklet, list) else booklet['items'],
                                solutions if isinstance(solutions, list) else solutions['items'])
        dest = out_root / 'pair' / (booklet_path.parent.name + '-pair.json')
        write_json(dest, result)
        print(json.dumps(result['summary'], ensure_ascii=False))
        print(dest)
        return 0

    if mode == 'doc':
        # doc <pdf> --role booklet|solution [--max-pages N]
        pdf = argv[1]
        role = argv[argv.index('--role') + 1]
        max_pages = int(argv[argv.index('--max-pages') + 1]) if '--max-pages' in argv else None
        dpi = int(argv[argv.index('--dpi') + 1]) if '--dpi' in argv else DEFAULT_DPI
        out_dir = out_root / 'doc' / Path(pdf).stem
        engine = load_engine()
        if role == 'booklet':
            data = extract_booklet_questions(engine, pdf, out_dir, dpi, max_pages)
        else:
            data = extract_solutions(engine, pdf, out_dir, dpi, max_pages)
        dest = out_dir / f'{role}.json'
        write_json(dest, {'pdf': pdf, 'role': role, 'items': data})
        print(json.dumps({'dest': str(dest), 'items': len(data)}, ensure_ascii=False))
        return 0

    print(f'未知模式 {mode}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
