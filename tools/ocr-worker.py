from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from rapidocr import RapidOCR

RENDER_DPI = 200
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

# 完全相同（忽略空白）的短行在足够多页面重复出现，视为通栏页眉/水印
REPEAT_PAGE_RATIO = 0.5
REPEAT_MIN_PAGES = 4
REPEAT_MAX_LENGTH = 8
REPEAT_EXCLUDED_CHARS = ':：?？。！!，,'
# 识别置信度低且极短的行，多为竖排水印断字等碎片
FRAGMENT_MAX_LENGTH = 4
FRAGMENT_MIN_SCORE = 0.55

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


def ocr_page(engine: RapidOCR, image) -> list[dict]:
    result = engine(image)
    lines: list[dict] = []
    if result is None or result.txts is None:
        return lines
    for text, box, score in zip(result.txts, result.boxes, result.scores):
        ys = [float(point[1]) for point in box]
        lines.append({
            'text': str(text).strip(),
            'top': min(ys),
            'bottom': max(ys),
            'score': float(score),
        })
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

    for page_index, (lines, height) in enumerate(zip(pages, heights)):
        is_ocr_page = page_sources is None or (
            page_index < len(page_sources) and page_sources[page_index] == 'ocr'
        )
        kept: list[str] = []
        for line in lines:
            text = line['text']
            if not text:
                continue
            # 只统计 OCR 页的置信度（文字层页不参与，不抬高平均值）
            if is_ocr_page:
                ocr_scores.append(line['score'])
                ocr_line_count += 1
                if line['score'] < LOW_CONFIDENCE_THRESHOLD:
                    low_confidence_lines += 1

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

            if is_question_number(text):
                kept.append(text)
                continue

            if len(text) <= FRAGMENT_MAX_LENGTH and line['score'] < FRAGMENT_MIN_SCORE:
                continue

            if len(text) <= REPEAT_MAX_LENGTH and repeat_key(text) in recurring:
                continue

            if height:
                if (line['top'] < height * EDGE_BAND_TOP
                        and line['bottom'] < height * EDGE_BAND_TOP):
                    continue
                if (line['top'] > height * (1 - EDGE_BAND_BOTTOM)
                        and line['bottom'] > height * (1 - EDGE_BAND_BOTTOM)):
                    continue

            kept.append(text)
        kept_pages.append(kept)

    avg_confidence = sum(ocr_scores) / len(ocr_scores) if ocr_scores else None
    low_conf_ratio = low_confidence_lines / ocr_line_count if ocr_line_count > 0 else 0
    return kept_pages, {
        'averageConfidence': round(avg_confidence, 3) if avg_confidence else None,
        'lowConfidenceLines': low_confidence_lines,
        'ocrLineCount': ocr_line_count,
        'lowConfidenceRatio': round(low_conf_ratio, 3),
        'removedPageNumbers': removed_page_numbers,
    }


# ---- 结构解析模式（RapidDoc）：表格还原 + 图形保真 + 阅读顺序 ----
def normalize_rapiddoc_markdown(text: str) -> str:
    text = text.replace('\\~', '~')
    out_lines: list[str] = []
    for line in text.split('\n'):
        option_hits = [
            (m.start(1), m.group(1))
            for m in re.finditer(r'([A-D])[.、．]\s*[^0-9\s]', line)
        ]
        ordered = 'ABCD'
        picks: list[int] = []
        expect_idx = 0
        for pos, key in option_hits:
            if expect_idx < len(ordered) and key == ordered[expect_idx]:
                picks.append(pos)
                expect_idx += 1
        if len(picks) >= 2:
            parts: list[str] = []
            for i, pos in enumerate(picks):
                end = picks[i + 1] if i + 1 < len(picks) else len(line)
                parts.append(line[pos:end].strip())
            stem = line[: picks[0]].strip()
            if stem:
                parts.insert(0, stem)
            out_lines.extend(parts)
            continue
        out_lines.append(line)
    return '\n'.join(out_lines)

def run_structured(source: Path, output: Path) -> int:
    try:
        from rapid_doc.main import RapidDoc
        from rapid_doc.data.data_reader_writer import FileBasedDataWriter
    except ImportError:
        report({'done': True, 'structuredMissing': True, 'totalPages': 0, 'textLayerPages': 0,
                'ocrPages': 0, 'emptyPages': 1, 'ocrLineCount': 0, 'lowConfidenceLines': 0,
                'removedPageNumbers': 0, 'warnings': ['结构解析组件未安装'], 'characters': 0})
        return 3
    parent = output.parent
    images_dir = parent / 'images'
    images_dir.mkdir(parents=True, exist_ok=True)
    doc = RapidDoc(table_enable=True, formula_enable=False, lang='ch',
                   output_dir=str(parent),
                   md_writer=FileBasedDataWriter(str(parent)),
                   image_writer=FileBasedDataWriter(str(images_dir)))
    result = doc(str(source))
    markdown = normalize_rapiddoc_markdown(result.markdown)
    output.write_text(markdown, encoding='utf-8')
    total_pages = 0
    try:
        import pypdfium2 as pdfium_mod
        total_pages = len(pdfium_mod.PdfDocument(str(source)))
    except Exception:
        pass
    report({'done': True, 'structured': True, 'characters': len(markdown), 'totalPages': total_pages,
            'textLayerPages': 0, 'ocrPages': total_pages, 'emptyPages': 0, 'ocrLineCount': 0,
            'averageConfidence': None, 'lowConfidenceLines': 0, 'removedPageNumbers': 0,
            'warnings': ['结构解析模式：表格已还原为 Markdown 表格，图片保真存至 images/ 目录']})
    return 0

def main() -> int:
    if len(sys.argv) not in (3, 4):
        raise ValueError('usage: ocr-worker.py <local-input> <markdown-output> [--structured]')

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
            image_data = np.asarray(img.convert('RGB'))
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

                # 文字层不足，需要 OCR
                if engine is None:
                    engine = RapidOCR()
                bitmap = page.render(scale=RENDER_DPI / 72)
                image_data = np.asarray(bitmap.to_pil().convert('RGB'))
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
