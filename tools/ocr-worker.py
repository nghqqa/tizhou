from __future__ import annotations

import json
import math
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from rapidocr import RapidOCR

RENDER_DPI = 260
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'}

# 页面文字层最低有效字符数：低于此值的页面视为扫描页，需要 OCR
TEXT_LAYER_MIN_CHARS = 50
# OCR 平均置信度低于此值时标记低质量
LOW_CONFIDENCE_THRESHOLD = 0.72
# 低置信度行占比超过此值时标记低质量
LOW_CONFIDENCE_RATIO = 0.20

# 顶部/底部边缘带占比：整行落在带内视为页眉/页脚
EDGE_BAND_TOP = 0.10
EDGE_BAND_BOTTOM = 0.07

# 完全相同（忽略空白）的短/中行在足够多页面重复出现，视为通栏页眉/水印
REPEAT_PAGE_RATIO = 0.5
REPEAT_MIN_PAGES = 4
REPEAT_MAX_LENGTH = 40
REPEAT_EXCLUDED_CHARS = '?？。！!'
# 识别置信度低且极短的行，多为竖排水印断字等碎片
FRAGMENT_MAX_LENGTH = 4
FRAGMENT_MIN_SCORE = 0.55

# 孤立页码行（如「第 1 页」「第12页」），即使文字层页面无坐标高度也能在页首/页尾安全过滤
PAGE_LABEL_PATTERN = re.compile(r'^第\s*\d{1,4}\s*页$')
# 选项行保护：常见短选项（如「A. 1个」「B. 错误」）可能跨多页重复，绝不可当作页眉/水印误删
OPTION_LINE_PATTERN = re.compile(r'^[A-D]\s*[.、．]')
# 套标题 / 章节标题 / 解析结构标签等文档结构锚点：跨页去重与边缘噪声剥离均须保护，防止正文锚点（如高频【参考答案】B）被误删
STRUCTURAL_HEADING_PATTERNS = [
    re.compile(r'^#{0,4}\s*练习题\s*0*\d{1,3}\s*套?\s*#*\s*$'),
    re.compile(r'^#{0,4}\s*第[一二三四五六七八九十百0-9]{1,4}[篇章套章节]'),
    re.compile(
        r'^#{0,4}\s*(?:考点|综合|专项|套题|图推|类比|定义|逻辑|判断|言语|选词|片段|数量|资料)(?:刷题|套题|训练)\s*[一二三四五六七八九十百0-9]{1,3}'
    ),
    re.compile(
        r'^#{0,4}\s*【(?:参考答案|答案|解析|实战解析|解析思路|解题思路|题型|难度|技巧|思路|考点|易错|拓展|总结|例题?\s*\d|训练\s*[一二三四五六七八九十百0-9]|资料|给定资料|材料)'
    ),
    re.compile(r'^#{0,4}\s*训练\s*[一二三四五六七八九十百0-9]{1,4}\s*[:：]'),
    re.compile(r'^#{0,4}\s*(?:参考答案|答案要点)\s*[:：]?$'),
]
# 纯数字 / 页码形态：绝不允许参与全局子串替换（防止页码 016 挖空正文 2016 / 2.016）
NUMERIC_OR_PAGE_NOISE = re.compile(r'^[\d\s\-—./第页共]+$')
# 行内选项标记：RapidDoc 合并中文/数字行时选项之间常无空格（如「B. 4:1C. 15:4」「最大B. 2022」），
# 仅排除紧跟小写字母的场景，靠「连续递增序列 + 非行首须从 A 起」防正文误切
INLINE_OPTION_MARKER = re.compile(r'(?<![a-z])([A-D])[.、．]\s*\S')

# 题号保护模式：这些格式的数字行是题号，不是页码
QUESTION_NUMBER_PATTERNS = [
    re.compile(r'^\d{1,3}[.、．,，]\s*\S'),  # 1. xxx  2、xxx  12.xxx
    re.compile(r'^第\d{1,3}题'),
    re.compile(r'^\d{1,3}-\d{1,3}'),  # 1-20 范围
    re.compile(r'^\d{1,3}/\d{1,3}'),  # 5/20 进度
    re.compile(r'^[A-D]\d{1,3}'),  # A1 B2 选项编号
    re.compile(r'^\(\d{1,3}\)'),
    re.compile(r'^（\d{1,3}）'),
    re.compile(r'^\d{1,3}\s*[$%€£¥]'),  # 金额
    re.compile(r'^\d{4}\s*年'),  # 年份
    re.compile(r'^\d{1,3}\s*[.．]\s*\d'),  # 小数
]


def report(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def is_question_number(line: str) -> bool:
    """判断一行是否为题号、选项编号等正文数字（不应被当作页码删除）"""
    return any(pattern.match(line) for pattern in QUESTION_NUMBER_PATTERNS)


def is_structural_heading(line: str) -> bool:
    """判断一行是否为套标题/章节标题等结构锚点（不应被当作页眉/水印删除）"""
    stripped = line.strip()
    return any(pattern.match(stripped) for pattern in STRUCTURAL_HEADING_PATTERNS)


def is_option_line(line: str) -> bool:
    """判断一行是否为 A-D 选项行（不应被跨页重复页眉/水印过滤误删）"""
    return bool(OPTION_LINE_PATTERN.match(line.strip()))


def create_pdf_ocr_engine() -> RapidOCR:
    """创建面向正向印刷 PDF 的 RapidOCR 实例。

    实测默认 Global.use_cls=True 会把正向纯数字单元格（如 9709→6016、006→900）
    或正常中文长行误判为 180° 倒立导致乱码或整行丢失；正向 PDF 关闭方向分类器
    与 RapidDoc 默认策略一致，既消除误翻又提速 ~15%。
    """
    return RapidOCR(params={'Global.use_cls': False})


def split_inline_options(line: str) -> list[str]:
    """把同行横排的连续选项（如 A. xx B. xx 或 C. xx D. xx）拆成独立行。

    支持任意连续递增选项子序列（A-B / C-D / A-B-C-D / B-C-D）：
    - 表格行（<table / |）与图片行跳过，防止破坏表格或图片链接；
    - 首个选项不在行首时，仅允许从 A 开始拆（支持「题干 A. 甲 B. 乙」），
      避免把正文中间偶发的「某B. xxx C. xxx」误切。
    """
    stripped = line.strip()
    if not stripped or stripped.startswith(('<table', '|', '![')):
        return [line]
    option_hits = [(m.start(1), m.group(1)) for m in INLINE_OPTION_MARKER.finditer(line)]
    if len(option_hits) < 2:
        return [line]
    ordered = 'ABCD'
    best_picks: list[int] = []
    for start_idx, (pos, key) in enumerate(option_hits):
        # 非行首起始时只允许从 A 切分（题干 + A. xx B. xx），防止正文误拆
        if pos > 0 and line[:pos].strip() and key != 'A':
            continue
        seq_pos = ordered.find(key)
        if seq_pos < 0:
            continue
        picks = [pos]
        expect_idx = seq_pos + 1
        for next_pos, next_key in option_hits[start_idx + 1:]:
            if expect_idx < len(ordered) and next_key == ordered[expect_idx]:
                picks.append(next_pos)
                expect_idx += 1
        if len(picks) > len(best_picks):
            best_picks = picks
    if len(best_picks) < 2:
        return [line]
    parts: list[str] = []
    stem = line[:best_picks[0]].strip()
    if stem:
        parts.append(stem)
    for i, pos in enumerate(best_picks):
        end = best_picks[i + 1] if i + 1 < len(best_picks) else len(line)
        part = line[pos:end].strip()
        if part:
            parts.append(part)
    return parts if parts else [line]


def repeat_key(text: str) -> str:
    return re.sub(r'\s+', '', text)


def extract_text_layer(page) -> str:
    """尝试从 PDF 页面提取文字层文本"""
    try:
        text_page = page.get_textpage()
        text = text_page.get_text_range()
        return text.strip() if isinstance(text, str) else ''
    except Exception:
        return ''


def preprocess_for_ocr(rgb: np.ndarray) -> np.ndarray:
    """轻量图像预处理：漂白浅色斜向水印与扫描底灰，增强深色印刷体对比度。

    仅作用于逐页文本 OCR 识字通道，不修改结构解析原图切图与来源证据图。
    """
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.size == 0:
        return rgb
    arr = rgb.astype(np.float32)
    min_ch = arr.min(axis=2)
    max_ch = arr.max(axis=2)
    lum = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    sat = max_ch - min_ch
    # 仅针对高亮度、低中饱和且三通道整体偏浅（min_ch >= 160）的浅彩水印（淡红/淡蓝斜纹）
    # 抬高其等效亮度以便一并漂白；保护中饱和浅彩印刷标题（如褪色蓝 [140,180,230]）与高饱和红/蓝重点字。
    is_pale_color_watermark = (sat > 25.0) & (sat <= 75.0) & (lum > 180.0) & (min_ch >= 160.0)
    is_colored_ink = (sat > 45.0) & (~is_pale_color_watermark)
    eff_lum = np.where(is_pale_color_watermark, np.minimum(255.0, lum + sat * 0.45), lum)
    # 下采样计算背景亮度分位数，耗时从 ~800ms 降至 <50ms
    sample = eff_lum[::4, ::4]
    p75 = float(np.percentile(sample, 75))
    white_pt = min(210.0, max(178.0, p75 - 24.0))
    black_pt = 45.0
    if white_pt <= black_pt + 20.0:
        return rgb
    scale = 255.0 / (white_pt - black_pt)
    target_lum = np.clip((eff_lum - black_pt) * scale, 0.0, 255.0)
    ratio = np.where(lum > 1.0, target_lum / np.maximum(lum, 1.0), 1.0)
    ratio = np.clip(ratio, 0.65, 1.6)
    # 彩色印刷文字不向上漂淡、不被置白，确保浅蓝/浅红标题在 OCR 识字通道中完整保留
    ratio = np.where(is_colored_ink, np.minimum(ratio, 1.0), ratio)
    out = np.empty_like(arr)
    for c in range(3):
        out[:, :, c] = np.clip(arr[:, :, c] * ratio, 0.0, 255.0)
    out[(eff_lum >= white_pt) & (~is_colored_ink)] = 255.0
    return out.astype(np.uint8)


def order_ocr_lines(
    lines: list[dict],
    page_width: int,
    page_height: int,
) -> list[dict]:
    """检测并重排「主栏 + 窄批注边栏」的双栏解析页（如花生解析册左右交替批注栏）。

    安全边界（防单栏页/2x2选项页/多列表格误切）：
    - 只在页面宽度 [0.22, 0.36]（左边栏）与 [0.64, 0.78]（右边栏）扫描垂直空白带；
    - 要求横跨分割线的正文行极少（<= max(1, 5% 正文行)），窄/宽两栏各 >= 4 行；
    - 两栏纵向 y 范围显著重叠（>= 35%）且跨度 >= 25% 页高；
    - 宽栏必须含宽行正文（最大行宽 >= 42% 页宽），且窄栏中选项行（A./B./C./D.）占比 < 50%；
    - 命中后：页顶边缘行 → 宽主栏（按 y 排序）→ 窄批注栏（按 y 排序）→ 页底边缘行，
      使主栏题干/答案/解析完全连续不被批注碎片剁碎，批注内容也完整保留。
    """
    if len(lines) < 8 or page_width <= 0 or page_height <= 0:
        return lines
    if not all('left' in line and 'right' in line for line in lines):
        return lines

    top_cut = page_height * EDGE_BAND_TOP
    bottom_cut = page_height * (1 - EDGE_BAND_BOTTOM)
    header_lines = [l for l in lines if l['bottom'] <= top_cut]
    footer_lines = [l for l in lines if l['top'] >= bottom_cut]
    body = [l for l in lines if l['bottom'] > top_cut and l['top'] < bottom_cut]
    if len(body) < 8:
        return lines

    tol = page_width * 0.015
    candidates = [round(0.22 + 0.02 * i, 2) for i in range(8)] + [
        round(0.64 + 0.02 * i, 2) for i in range(8)
    ]
    best: tuple[int, float, list[dict], list[dict], list[dict]] | None = None
    max_cross = max(1, int(len(body) * 0.05))

    for ratio in candidates:
        split_x = page_width * ratio
        left_side: list[dict] = []
        right_side: list[dict] = []
        crossing: list[dict] = []
        for l in body:
            if l['right'] <= split_x + tol:
                left_side.append(l)
            elif l['left'] >= split_x - tol:
                right_side.append(l)
            else:
                crossing.append(l)
        if len(crossing) > max_cross:
            continue
        if len(left_side) < 4 or len(right_side) < 4:
            continue
        is_left_sidebar = ratio < 0.5
        sidebar = left_side if is_left_sidebar else right_side
        main_col = right_side if is_left_sidebar else left_side

        # 宽主栏必须有足够宽的正文行（排除多列窄表）
        main_max_w = max((l['right'] - l['left']) for l in main_col) / page_width
        if main_max_w < 0.42:
            continue
        # 窄栏若主要是选项行（2x2 网格）或纯短表头，不切分
        side_opt_ratio = sum(1 for l in sidebar if is_option_line(l['text'])) / len(sidebar)
        if side_opt_ratio >= 0.45:
            continue
        # 两栏纵向跨度与重叠检查
        s_top, s_bot = min(l['top'] for l in sidebar), max(l['bottom'] for l in sidebar)
        m_top, m_bot = min(l['top'] for l in main_col), max(l['bottom'] for l in main_col)
        s_span = max(1.0, s_bot - s_top)
        m_span = max(1.0, m_bot - m_top)
        overlap = max(0.0, min(s_bot, m_bot) - max(s_top, m_top))
        if max(s_span, m_span) < page_height * 0.25:
            continue
        if overlap / min(s_span, m_span) < 0.35:
            continue

        # 选跨线最少、栏间分离最干净的切分点
        gap_score = abs(len(crossing)) * 1000 - overlap / page_height
        if best is None or (len(crossing), gap_score) < (best[0], best[1]):
            best = (len(crossing), gap_score, main_col, sidebar, crossing)

    if best is None:
        return lines

    _, _, main_col, sidebar, crossing = best
    by_y = lambda item: (item['top'], item['left'])
    main_ordered = sorted(main_col + crossing, key=by_y)
    side_ordered = sorted(sidebar, key=by_y)
    return sorted(header_lines, key=by_y) + main_ordered + side_ordered + sorted(footer_lines, key=by_y)


def ocr_page(engine: RapidOCR, image) -> list[dict]:
    result = engine(image)
    lines: list[dict] = []
    if result is None or result.txts is None:
        return lines
    for text, box, score in zip(result.txts, result.boxes, result.scores):
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        lines.append({
            'text': str(text).strip(),
            'left': min(xs),
            'right': max(xs),
            'top': min(ys),
            'bottom': max(ys),
            'score': float(score),
        })
    if isinstance(image, np.ndarray) and image.ndim >= 2:
        lines = order_ocr_lines(lines, int(image.shape[1]), int(image.shape[0]))
    return lines


def filter_lines(
    pages: list[list[dict]],
    heights: list[int | None],
    page_sources: list[str] | None = None,
) -> tuple[list[list[str]], dict]:
    """过滤页眉/页脚/页码/水印，统计质量指标（置信度只统计 OCR 页）"""
    total = len(pages)
    counts: dict[str, int] = {}
    for lines in pages:
        seen: set[str] = set()
        for line in lines:
            text = line['text']
            if not text or len(text) > REPEAT_MAX_LENGTH:
                continue
            if is_question_number(text) or is_structural_heading(text) or is_option_line(text):
                continue
            if any(char in REPEAT_EXCLUDED_CHARS for char in text):
                continue
            seen.add(repeat_key(text))
        for key in seen:
            counts[key] = counts.get(key, 0) + 1
    recurring: set[str] = set()
    if total >= REPEAT_MIN_PAGES:
        recurring = {
            key for key, count in counts.items() if count / total >= REPEAT_PAGE_RATIO
        }

    kept_pages: list[list[str]] = []
    ocr_scores: list[float] = []  # 只统计 OCR 页的识别行
    low_confidence_lines = 0
    ocr_line_count = 0
    removed_page_numbers = 0
    removed_noise_lines = 0

    for page_index, (lines, height) in enumerate(zip(pages, heights)):
        is_ocr_page = page_sources is None or (
            page_index < len(page_sources) and page_sources[page_index] == 'ocr'
        )
        kept: list[str] = []
        total_lines_in_page = len(lines)
        for line_idx, line in enumerate(lines):
            text = line['text']
            if not text:
                continue
            # 只统计 OCR 页的置信度（文字层页不参与，不抬高平均值）
            if is_ocr_page:
                ocr_scores.append(line['score'])
                ocr_line_count += 1
                if line['score'] < LOW_CONFIDENCE_THRESHOLD:
                    low_confidence_lines += 1

            # 孤立页码行「第 N 页」：位于页首/页尾边缘（无 height 的文字层按前/后 3 行判定）
            if PAGE_LABEL_PATTERN.match(text):
                near_edge = (
                    (line['top'] < height * EDGE_BAND_TOP or line['bottom'] > height * (1 - EDGE_BAND_BOTTOM))
                    if height
                    else (line_idx < 3 or line_idx >= total_lines_in_page - 3)
                )
                if near_edge:
                    removed_page_numbers += 1
                    continue

            # 纯数字行：只删除页码位置的，保护题号
            if re.match(r'^\d{1,3}$', text):
                if height:
                    in_top = line['top'] < height * EDGE_BAND_TOP
                    in_bottom = line['bottom'] > height * (1 - EDGE_BAND_BOTTOM)
                    if (in_top or in_bottom) and not is_question_number(text):
                        removed_page_numbers += 1
                        continue
                # 不在边缘位置 → 可能是题号，保留
                kept.append(text)
                continue

            if is_question_number(text) or is_structural_heading(text) or is_option_line(text):
                kept.extend(split_inline_options(text))
                continue

            if len(text) <= FRAGMENT_MAX_LENGTH and line['score'] < FRAGMENT_MIN_SCORE:
                continue

            if len(text) <= REPEAT_MAX_LENGTH and repeat_key(text) in recurring:
                removed_noise_lines += 1
                continue

            if height:
                if (line['top'] < height * EDGE_BAND_TOP
                        and line['bottom'] < height * EDGE_BAND_TOP):
                    removed_noise_lines += 1
                    continue
                if (line['top'] > height * (1 - EDGE_BAND_BOTTOM)
                        and line['bottom'] > height * (1 - EDGE_BAND_BOTTOM)):
                    removed_noise_lines += 1
                    continue

            kept.extend(split_inline_options(text))
        kept_pages.append(kept)

    avg_confidence = sum(ocr_scores) / len(ocr_scores) if ocr_scores else None
    low_conf_ratio = low_confidence_lines / ocr_line_count if ocr_line_count > 0 else 0
    return kept_pages, {
        'averageConfidence': round(avg_confidence, 3) if avg_confidence else None,
        'lowConfidenceLines': low_confidence_lines,
        'ocrLineCount': ocr_line_count,
        'lowConfidenceRatio': round(low_conf_ratio, 3),
        'removedPageNumbers': removed_page_numbers,
        'removedNoiseLines': removed_noise_lines,
    }


# ---- 结构解析模式（RapidDoc）：表格还原 + 图形保真 + 阅读顺序 ----
def normalize_rapiddoc_markdown(text: str) -> str:
    text = text.replace('\\~', '~')
    out_lines: list[str] = []
    for line in text.split('\n'):
        out_lines.extend(split_inline_options(line))
    return '\n'.join(out_lines)

def extract_regions(result) -> tuple[list, int]:
    """从 RapidDoc 输出提取版面块（类型/页码/坐标/图片路径/文本）。

    content_list_json 是阅读序的块列表，块带 type（text/image/table/discarded）、
    page_idx 与 bbox。discarded 即版面模型判定弃置的水印/页眉页脚。
    """
    blocks = getattr(result, 'content_list_json', None)
    if not isinstance(blocks, list):
        return [], 0
    regions = []
    pages = 0
    for block in blocks:
        if not isinstance(block, dict):
            continue
        page = int(block.get('page_idx') or 0)
        pages = max(pages, page + 1)
        regions.append({
            'type': str(block.get('type') or 'text'),
            'page': page,
            'bbox': [round(float(v)) for v in (block.get('bbox') or []) if isinstance(v, (int, float))],
            'imgPath': str(block.get('img_path') or ''),
            'text': str(block.get('text') or '')[:200],
        })
    return regions, pages


def _is_safe_edge_noise(text: str) -> bool:
    """校验候选噪声串是否可安全剥离：绝不放行纯数字/页码与套/章节结构标题。"""
    stripped = text.strip()
    if len(stripped) < 3:
        return False
    if NUMERIC_OR_PAGE_NOISE.match(stripped):
        return False
    if is_question_number(stripped) or is_structural_heading(stripped) or is_option_line(stripped):
        return False
    return True


def _is_inline_watermark_noise(text: str) -> bool:
    """允许从普通正文行内剥离的长页眉/宣传水印（防误伤正文短词与数字）。"""
    stripped = text.strip()
    if len(stripped) < 6 or not _is_safe_edge_noise(stripped):
        return False
    # 排除纯 ASCII 字母数字短串或含标点句末的普通句子
    if re.fullmatch(r'[A-Za-z0-9\s._-]+', stripped) and len(stripped) < 10:
        return False
    return True


def edge_noise_strings(regions: list) -> set:
    """跨页重复的页眉/页脚与 discarded 水印文本。

    只删「重复出现 + 位于页面边缘/被版面模型弃置」且通过安全校验的文本：
    - 绝不收纳纯数字/页码（如 016/105/600），防止挖空正文年份与统计数值；
    - 绝不收纳套标题/题号/章节标题（如「练习题 01套」）；
    - discarded 块文本（>=3 字符且非纯数字/结构标题）+ 在 >=3 个不同页面顶部（y1<160）
      重复出现的页眉短文本。
    """
    noise = {
        r['text'].strip()
        for r in regions
        if r['type'] == 'discarded' and _is_safe_edge_noise(r['text'])
    }
    top_pages: dict[str, set[int]] = {}
    for r in regions:
        bbox = r.get('bbox') or []
        if r['type'] == 'text' and len(bbox) == 4:
            y1 = bbox[3]
            text = r['text'].strip()
            if y1 < 160 and 3 <= len(text) <= 40 and _is_safe_edge_noise(text):
                top_pages.setdefault(text, set()).add(int(r.get('page', 0)))
    noise.update(text for text, pages in top_pages.items() if len(pages) >= 3)
    return noise


def _load_image_signature(img_path: Path) -> np.ndarray | None:
    if not img_path.is_file():
        return None
    try:
        from PIL import Image
        resample = getattr(getattr(Image, 'Resampling', Image), 'BILINEAR')
        with Image.open(img_path) as im:
            gray = im.convert('L').resize((16, 16), resample)
            return np.asarray(gray, dtype=np.float32)
    except Exception:
        return None


def _images_visually_similar(sig_a: np.ndarray, sig_b: np.ndarray) -> bool:
    """判断两张页顶候选小图是否视觉同源（容忍 1 格微偏移，排除同槽位不同内容题图）。"""
    std_a = float(sig_a.std())
    std_b = float(sig_b.std())
    if std_a < 5.0 and std_b < 5.0:
        return abs(float(sig_a.mean()) - float(sig_b.mean())) <= 15.0
    if std_a < 5.0 or std_b < 5.0:
        return False
    if abs(float(sig_a.mean()) - float(sig_b.mean())) > 35.0:
        return False
    core_a = sig_a[1:15, 1:15]
    da = core_a - core_a.mean()
    na = float(np.linalg.norm(da))
    if na < 1e-3:
        return False
    best_corr = -1.0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            patch_b = sig_b[1 + dy:15 + dy, 1 + dx:15 + dx]
            db = patch_b - patch_b.mean()
            nb = float(np.linalg.norm(db))
            if nb < 1e-3:
                continue
            corr = float(np.sum(da * db)) / (na * nb)
            if corr > best_corr:
                best_corr = corr
    return best_corr >= 0.78


def _collect_header_image_names(
    regions: list,
    images_dir: Path | None = None,
) -> set[str]:
    """识别跨页顶部边缘带视觉同源的重复页眉小图，将其 region 标为 discarded 并返回文件名集合。"""
    total_pages = max((int(r.get('page', 0)) for r in regions), default=-1) + 1
    min_repeat_pages = 2 if total_pages <= 3 else max(3, math.ceil(total_pages * 0.25))
    clusters: list[dict] = []
    for r in regions:
        bbox = r.get('bbox') or []
        if r.get('type') != 'image' or not r.get('imgPath') or len(bbox) != 4:
            continue
        x0, y0, x1, y1 = bbox
        w = x1 - x0
        h = y1 - y0
        if not (y1 < 155 and 0 < h < 130 and 0 < w < 420):
            continue
        page = int(r.get('page', 0))
        sig = _load_image_signature(images_dir / Path(r['imgPath']).name) if images_dir else None
        matched = None
        for cluster in clusters:
            rx0, ry0, rw, rh = cluster['ref']
            if not (abs(x0 - rx0) <= 35 and abs(y0 - ry0) <= 25 and abs(w - rw) <= 35 and abs(h - rh) <= 25):
                continue
            if sig is not None and cluster['sig'] is not None:
                if not _images_visually_similar(cluster['sig'], sig):
                    continue
            matched = cluster
            break
        if matched is None:
            clusters.append({'ref': (x0, y0, w, h), 'sig': sig, 'pages': {page}, 'items': [r]})
        else:
            matched['pages'].add(page)
            matched['items'].append(r)
            if matched['sig'] is None and sig is not None:
                matched['sig'] = sig
    header_imgs: set[str] = set()
    for cluster in clusters:
        if len(cluster['pages']) < min_repeat_pages:
            continue
        for r in cluster['items']:
            img_name = Path(r['imgPath']).name
            r['type'] = 'discarded'
            if img_name:
                header_imgs.add(img_name)
    return header_imgs


def _apply_edge_noise_to_markdown(
    markdown: str,
    line_noise: set[str],
    inline_noise: list[str],
    header_img_names: set[str],
) -> tuple[str, int, list[str]]:
    """按行剥离边缘噪声文本与重复页眉小图：绝不修改 HTML 表格内部，绝不对短纯数字做子串替换。"""
    removed = 0
    samples: list[str] = []
    out_lines: list[str] = []
    for raw_line in markdown.split('\n'):
        line = raw_line
        stripped = line.strip()
        if not stripped:
            out_lines.append('')
            continue
        # 1) 整行精确命中（兼容 Markdown 标题前缀 # ）
        plain = re.sub(r'^#{1,6}\s+', '', stripped).strip()
        if stripped in line_noise or plain in line_noise:
            removed += 1
            samples.append(plain)
            continue
        # 2) 非表格行才允许剥离长宣传水印片段（如页眉/微信水印粘在句尾）
        if not stripped.startswith(('<table', '|')):
            for text in inline_noise:
                if text in line:
                    occurrences = line.count(text)
                    line = line.replace(text, '')
                    removed += occurrences
                    samples.append(text)
            line = re.sub(r'[ \t]{2,}', ' ', line).rstrip()
            if not line.strip():
                continue
        out_lines.append(line)
    cleaned = '\n'.join(out_lines)
    for img_name in sorted(header_img_names):
        pattern = re.compile(r'!\[[^\]]*\]\([^)]*' + re.escape(img_name) + r'\)\s*')
        cleaned, n = pattern.subn('', cleaned)
        if n:
            removed += n
            samples.append(f'[header-img:{img_name}]')
    return cleaned, removed, samples


def strip_edge_noise(
    markdown: str,
    regions: list,
    images_dir: Path | None = None,
) -> tuple[str, int, list]:
    """从 markdown 中剥离边缘噪声文本与跨页重复的页眉小图，返回（新文本，剥离次数，样本）。"""
    # 整行精确匹配的噪声集合：安全噪声 + 偶发漏进正文成为独立行的纯数字/页码 discarded 块
    safe_noise = edge_noise_strings(regions)
    line_noise = set(safe_noise)
    for r in regions:
        if r.get('type') == 'discarded':
            t = str(r.get('text') or '').strip()
            if t and NUMERIC_OR_PAGE_NOISE.match(t) and not is_question_number(t):
                line_noise.add(t)
    inline_noise = sorted((t for t in safe_noise if _is_inline_watermark_noise(t)), key=len, reverse=True)
    header_imgs = _collect_header_image_names(regions, images_dir=images_dir)
    cleaned, removed, samples = _apply_edge_noise_to_markdown(
        markdown, line_noise, inline_noise, header_imgs
    )
    return cleaned, removed, samples[:10]


def can_use_text_layer_fast_path(pdf) -> tuple[bool, list[str]]:
    """判断 PDF 是否适合跳过 RapidDoc 直接走内嵌文字层快路径。

    条件：
    1. 总页数 > 0，且全部页面均有有效文字层（>= TEXT_LAYER_MIN_CHARS）；
    2. 排除整页覆盖背景水印（w>=85% 且 h>=85%）与页眉/页脚边缘小图（b>=88% 或 t<=12%）后，
       正文区域含中等以上尺寸内容图（面积 >=3%、宽 >=12%、高 >=8%）的页数占比 <= 15%（且 <=1 页或 <=15%）；
    这样纯文字层题本（如带整页底图水印的四海数量关系）可提速 ~35x 且彻底避开底图水印 OCR 污染，
    而富含图表/图推配图的文字层 PDF 仍正常走 RapidDoc。
    """
    import pypdfium2.raw as pdfium_c
    total_pages = len(pdf)
    if total_pages == 0:
        return False, []
    texts: list[str] = []
    body_image_pages = 0
    for page_index in range(total_pages):
        page = pdf[page_index]
        text = extract_text_layer(page)
        if len(text) < TEXT_LAYER_MIN_CHARS:
            return False, []
        texts.append(text)
        try:
            pw, ph = page.get_size()
            pw = max(1.0, float(pw))
            ph = max(1.0, float(ph))
            has_body_img = False
            for obj in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE]):
                left, bottom, right, top = obj.get_bounds()
                w_ratio = max(0.0, (right - left) / pw)
                h_ratio = max(0.0, (top - bottom) / ph)
                b_ratio = bottom / ph
                t_ratio = top / ph
                # 排除整页底图水印与极小占位对象
                if (w_ratio >= 0.85 and h_ratio >= 0.85) or w_ratio <= 0.02 or h_ratio <= 0.02:
                    continue
                # 排除页眉 / 页脚边缘带 Logo 与二维码
                if b_ratio >= 0.88 or t_ratio <= 0.12:
                    continue
                if w_ratio >= 0.12 and h_ratio >= 0.08 and (w_ratio * h_ratio) >= 0.03:
                    has_body_img = True
                    break
            if has_body_img:
                body_image_pages += 1
        except Exception:
            # 无法检查图片对象时保守回退结构解析
            return False, []
    max_allowed = max(1, int(total_pages * 0.15))
    return body_image_pages <= max_allowed, texts


def _write_page_manifest(output: Path, pages: list[dict]) -> None:
    try:
        (output.parent / 'images').mkdir(parents=True, exist_ok=True)
        (output.parent / 'images' / '_pages.json').write_text(
            json.dumps({'pages': pages}, ensure_ascii=False, sort_keys=True),
            encoding='utf-8',
        )
    except Exception:
        pass


def run_structured(source: Path, output: Path) -> int:
    try:
        from rapid_doc.main import RapidDoc
        from rapid_doc.data.data_reader_writer import FileBasedDataWriter
        from rapid_doc.backend.pipeline.pipeline_middle_json_mkcontent import union_make as pipeline_union_make
        from rapid_doc.utils.enum_class import MakeMode
    except ImportError:
        report({'done': True, 'structuredMissing': True, 'totalPages': 0, 'textLayerPages': 0,
                'ocrPages': 0, 'emptyPages': 1, 'ocrLineCount': 0, 'lowConfidenceLines': 0,
                'removedPageNumbers': 0, 'warnings': ['结构解析组件未安装'], 'characters': 0})
        return 3
    parent = output.parent
    images_dir = parent / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)

    # 预检查文字层：全文字层且正文无密集配图的 PDF 直接走内嵌文字层快路径，
    # 避免 RapidDoc 因整页水印底图误判为扫描件而强制全量 OCR（慢 30x+ 且把底图水印读进正文）
    total_pages = 0
    text_layer_pages = 0
    fast_texts: list[str] = []
    use_fast_path = False
    try:
        pdf = pdfium.PdfDocument(str(source))
        try:
            total_pages = len(pdf)
            use_fast_path, fast_texts = can_use_text_layer_fast_path(pdf)
            if use_fast_path:
                text_layer_pages = total_pages
            else:
                for page_index in range(total_pages):
                    if len(extract_text_layer(pdf[page_index])) >= TEXT_LAYER_MIN_CHARS:
                        text_layer_pages += 1
        finally:
            pdf.close()
    except Exception:
        use_fast_path = False

    if use_fast_path and fast_texts:
        pages_data = [
            [{'text': p.strip(), 'top': 0, 'bottom': 0, 'score': 1.0} for p in text.split('\n') if p.strip()]
            for text in fast_texts
        ]
        heights: list[int | None] = [None] * len(pages_data)
        page_sources = ['text-layer'] * len(pages_data)
        kept_pages, quality = filter_lines(pages_data, heights, page_sources)
        merged = '\n\n'.join('\n'.join(lines) for lines in kept_pages if lines)
        output.write_text(merged, encoding='utf-8')
        _write_page_manifest(
            output,
            [
                {'pageNumber': idx + 1, 'source': 'text-layer', 'lines': list(lines)}
                for idx, lines in enumerate(kept_pages)
                if lines
            ],
        )
        removed_total = quality['removedPageNumbers'] + quality['removedNoiseLines']
        report({
            'done': True,
            'structured': True,
            'characters': len(merged),
            'totalPages': total_pages,
            'textLayerPages': total_pages,
            'ocrPages': 0,
            'emptyPages': sum(1 for lines in kept_pages if not lines),
            'ocrLineCount': 0,
            'averageConfidence': None,
            'lowConfidenceLines': 0,
            'removedPageNumbers': quality['removedPageNumbers'],
            'tableRegions': 0,
            'figureRegions': 0,
            'discardedRegions': 0,
            'removedNoiseLines': quality['removedNoiseLines'],
            'warnings': [
                f'全文字层快速提取：{total_pages} 页直接采用内嵌文字层（跳过位图 OCR，避免底图水印污染）'
                + (f'，已清理页眉/页码 {removed_total} 处' if removed_total else '')
            ],
        })
        return 0

    doc = RapidDoc(table_enable=True, formula_enable=False, lang='ch',
                   ocr_config={'Global.use_cls': False},
                   output_dir=str(parent),
                   md_writer=FileBasedDataWriter(str(parent)),
                   image_writer=FileBasedDataWriter(str(images_dir)))
    result = doc(str(source))
    regions, region_pages = extract_regions(result)
    # 先把 RapidDoc 散落在 <output_dir>/<源名>/auto/images/ 的图片收拢到 images/，
    # 使 strip_edge_noise 能对页顶候选小图做视觉同源校验，同时让 markdown 引用与磁盘文件对齐
    for pattern in ('*/auto/images/*', '*/images/*'):
        for scattered in parent.glob(pattern):
            if scattered.is_file():
                shutil.copy2(str(scattered), str(images_dir / scattered.name))

    # 统一预计算整本噪声规则（跨页重复统计必须基于整本 regions），再按页产出严格行对齐的 _pages.json
    safe_noise = edge_noise_strings(regions)
    line_noise = set(safe_noise)
    for r in regions:
        if r.get('type') == 'discarded':
            t = str(r.get('text') or '').strip()
            if t and NUMERIC_OR_PAGE_NOISE.match(t) and not is_question_number(t):
                line_noise.add(t)
    inline_noise = sorted((t for t in safe_noise if _is_inline_watermark_noise(t)), key=len, reverse=True)
    header_imgs = _collect_header_image_names(regions, images_dir=images_dir)

    middle_pdf_info = (result.middle_json or {}).get('pdf_info') if isinstance(getattr(result, 'middle_json', None), dict) else None
    removed_noise = 0
    noise_samples: list[str] = []
    manifest_pages: list[dict] = []
    if isinstance(middle_pdf_info, list) and middle_pdf_info:
        page_markdowns: list[str] = []
        for idx, page_info in enumerate(middle_pdf_info):
            page_md = pipeline_union_make([page_info], MakeMode.MM_MD, 'images') or ''
            page_md = normalize_rapiddoc_markdown(page_md)
            page_md, page_removed, page_samples = _apply_edge_noise_to_markdown(
                page_md, line_noise, inline_noise, header_imgs
            )
            removed_noise += page_removed
            if len(noise_samples) < 10:
                noise_samples.extend(page_samples[: 10 - len(noise_samples)])
            non_empty = [ln.strip() for ln in page_md.split('\n') if ln.strip()]
            if non_empty:
                page_idx_val = page_info.get('page_idx')
                page_num = int(page_idx_val) + 1 if isinstance(page_idx_val, int) else idx + 1
                manifest_pages.append({
                    'pageNumber': page_num,
                    'source': 'structured',
                    'lines': non_empty,
                })
                page_markdowns.append(page_md.strip())
        markdown = '\n\n'.join(page_markdowns)
    else:
        markdown = normalize_rapiddoc_markdown(result.markdown)
        markdown, removed_noise, noise_samples = _apply_edge_noise_to_markdown(
            markdown, line_noise, inline_noise, header_imgs
        )
        noise_samples = noise_samples[:10]

    output.write_text(markdown, encoding='utf-8')
    if manifest_pages:
        _write_page_manifest(output, manifest_pages)

    # 版面块清单随图片归档走缓存（命中时随 images/ 一起恢复），图推绑定与质量评估依赖
    table_regions = sum(1 for r in regions if r['type'] == 'table')
    image_regions = sum(1 for r in regions if r['type'] == 'image' and r['imgPath'])
    discarded_regions = sum(1 for r in regions if r['type'] == 'discarded')
    try:
        (images_dir / '_regions.json').write_text(json.dumps({
            'pages': region_pages,
            'regions': regions,
            'removedNoise': removed_noise,
            'noiseSamples': noise_samples[:10],
        }, ensure_ascii=False), encoding='utf-8')
    except Exception:
        pass
    ocr_pages = max(0, total_pages - text_layer_pages)
    report({'done': True, 'structured': True, 'characters': len(markdown),
            'totalPages': total_pages,
            'textLayerPages': text_layer_pages, 'ocrPages': ocr_pages, 'emptyPages': 0,
            'ocrLineCount': 0,
            'averageConfidence': None, 'lowConfidenceLines': 0, 'removedPageNumbers': 0,
            'tableRegions': table_regions, 'figureRegions': image_regions,
            'discardedRegions': discarded_regions, 'removedNoiseLines': removed_noise,
            'warnings': ['结构解析模式：表格已还原为 Markdown 表格，图片保真存至 images/ 目录'
                         + (f'，文字层 {text_layer_pages} 页直接采用、位图 OCR {ocr_pages} 页' if total_pages else '')
                         + (f'，已剥离页眉/水印噪声 {removed_noise} 处' if removed_noise else '')]})
    return 0

def render_evidence_pages(source: Path, out_dir: Path, pages_arg: str, max_side: int = 1280) -> int:
    """按需渲染来源页预览（复用 pypdfium2，不引入新引擎）。

    pages_arg：逗号分隔的 1-based 页码。输出 evidence-p{N}.jpg（长边 ≤max_side、质量 80），
    确定性文件名；页码越界直接跳过。原 PDF 只读。
    max_side：默认 1280 兼容现有 evidence/ 来源预览；VLM 按页精校传 2000 提高统计表小字清晰度。
    """
    import pypdfium2 as pdfium
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted: set[int] = set()
    for part in pages_arg.split(','):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            continue
        if n >= 1:
            wanted.add(n)
    if not wanted:
        return 0
    document = pdfium.PdfDocument(str(source))
    try:
        total = len(document)
        for n in sorted(wanted):
            if n > total:
                continue
            page = document[n - 1]
            scale = float(max_side) / max(1.0, max(page.get_size()))
            bitmap = page.render(scale=scale)
            pil = bitmap.to_pil().convert('RGB')
            pil.save(out_dir / f'evidence-p{n}.jpg', 'JPEG', quality=80)
    finally:
        document.close()
    return 0


def main() -> int:
    if len(sys.argv) >= 5 and sys.argv[3] == '--render-evidence':
        source = Path(sys.argv[1]).resolve(strict=True)
        out_dir = Path(sys.argv[2]).resolve()
        if not source.is_file():
            raise ValueError('input must be a local regular file')
        max_side = 1280
        if len(sys.argv) >= 7 and sys.argv[5] == '--max-side':
            try:
                max_side = int(sys.argv[6])
            except ValueError:
                max_side = 1280
            max_side = max(640, min(2400, max_side))
        return render_evidence_pages(source, out_dir, sys.argv[4], max_side)
    if len(sys.argv) not in (3, 4):
        raise ValueError(
            'usage: ocr-worker.py <local-input> <markdown-output> [--structured] '
            '| ocr-worker.py <pdf> <out-dir> --render-evidence <pages-csv> [--max-side 640-2400]')

    source = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).resolve()
    if not source.is_file():
        raise ValueError('input must be a local regular file')
    structured_mode = len(sys.argv) == 4 and sys.argv[3] == '--structured'
    if structured_mode and source.suffix.lower() in IMAGE_SUFFIXES:
        raise ValueError('结构解析模式仅支持 PDF 输入')
    if structured_mode:
        return run_structured(source, output)

    output.parent.mkdir(parents=True, exist_ok=True)

    is_image = source.suffix.lower() in IMAGE_SUFFIXES
    engine = None  # 延迟初始化，纯文字层 PDF 不需要加载模型
    pages_data: list[list[dict]] = []
    heights: list[int | None] = []
    page_sources: list[str] = []  # 每页来源: 'text-layer' 或 'ocr'
    text_layer_pages = 0
    ocr_pages = 0
    empty_pages = 0
    warnings: list[str] = []

    if is_image:
        # 直接图片输入：必须 OCR
        from PIL import Image
        engine = RapidOCR()
        with Image.open(str(source)) as img:
            image_data = preprocess_for_ocr(np.asarray(img.convert('RGB')))
        height = int(image_data.shape[0])
        lines = ocr_page(engine, image_data)
        pages_data.append(lines)
        heights.append(height)
        page_sources.append('ocr')
        ocr_pages = 1
        if not lines:
            empty_pages = 1
            warnings.append('图片未识别到任何文字')
        report({'page': 1, 'total': 1, 'characters': sum(len(l['text']) for l in lines), 'source': 'ocr'})
    else:
        document = pdfium.PdfDocument(str(source))
        try:
            total_pages = len(document)
            for page_index in range(total_pages):
                page = document[page_index]

                # 先尝试文字层
                text = extract_text_layer(page)
                if len(text) >= TEXT_LAYER_MIN_CHARS:
                    # 有足够文字层，直接使用
                    text_layer_pages += 1
                    # 按段落分割文字层内容
                    paragraphs = [p.strip() for p in text.split('\n') if p.strip()]
                    pages_data.append([{'text': p, 'top': 0, 'bottom': 0, 'score': 1.0} for p in paragraphs])
                    heights.append(None)  # 文字层页面无高度信息
                    page_sources.append('text-layer')
                    report({'page': page_index + 1, 'total': total_pages,
                           'characters': len(text), 'source': 'text-layer'})
                    continue

                # 文字层不足，需要 OCR（正向 PDF 关闭 180° 方向分类器防数字倒翻与整行丢失）
                if engine is None:
                    engine = create_pdf_ocr_engine()
                bitmap = page.render(scale=RENDER_DPI / 72)
                image_data = preprocess_for_ocr(np.asarray(bitmap.to_pil().convert('RGB')))
                height = int(image_data.shape[0])
                lines = ocr_page(engine, image_data)
                pages_data.append(lines)
                heights.append(height)
                page_sources.append('ocr')
                ocr_pages += 1
                char_count = sum(len(l['text']) for l in lines)
                if char_count < 10:
                    empty_pages += 1
                    warnings.append(f'第 {page_index + 1} 页 OCR 结果过短（{char_count} 字符）')
                report({'page': page_index + 1, 'total': total_pages,
                       'characters': char_count, 'source': 'ocr'})
        finally:
            document.close()

    # 过滤并合并
    kept_pages, quality = filter_lines(pages_data, heights, page_sources)
    merged = '\n\n'.join('\n'.join(lines) for lines in kept_pages if lines)
    output.write_text(merged, encoding='utf-8')

    # 页清单 sidecar（确定性、无时间戳）：逐页记录过滤后的行内容，
    # 供导入管线建立「行 → 页」映射与来源证据——不改变 markdown 正文本身
    page_manifest = {
        'pages': [
            {
                'pageNumber': index + 1,
                'source': page_sources[index] if index < len(page_sources) else 'ocr',
                'lines': list(lines),
            }
            for index, lines in enumerate(kept_pages)
            if lines
        ]
    }
    try:
        (output.parent / 'images').mkdir(parents=True, exist_ok=True)
        (output.parent / 'images' / '_pages.json').write_text(
            json.dumps(page_manifest, ensure_ascii=False, sort_keys=True), encoding='utf-8')
    except Exception:
        pass

    # 质量评估
    if quality['averageConfidence'] and quality['averageConfidence'] < LOW_CONFIDENCE_THRESHOLD:
        warnings.append(f"OCR 平均置信度 {quality['averageConfidence']:.1%}，低于 {LOW_CONFIDENCE_THRESHOLD:.0%}，建议人工抽查")
    if quality['lowConfidenceRatio'] > LOW_CONFIDENCE_RATIO:
        warnings.append(f"低置信度行占比 {quality['lowConfidenceRatio']:.1%}，建议人工抽查")
    if empty_pages > 0 and empty_pages == len(pages_data):
        warnings.append('所有页面均未识别到有效文字')

    final_report = {
        'done': True,
        'characters': len(merged),
        'totalPages': len(pages_data),
        'textLayerPages': text_layer_pages,
        'ocrPages': ocr_pages,
        'emptyPages': empty_pages,
        'ocrLineCount': quality['ocrLineCount'],
        'averageConfidence': quality['averageConfidence'],
        'lowConfidenceLines': quality['lowConfidenceLines'],
        'removedPageNumbers': quality['removedPageNumbers'],
        'warnings': warnings[:5],
    }
    report(final_report)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
