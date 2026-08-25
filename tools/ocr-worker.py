from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image
from rapidocr import RapidOCR

RENDER_DPI = 200
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'}
# 顶部/底部边缘带占比：整行落在带内视为页眉/页脚。实测模板页眉位于 5%-9%，正文最早 10.5%
EDGE_BAND_TOP = 0.10
EDGE_BAND_BOTTOM = 0.07
# 完全相同（忽略空白）的短行在足够多页面重复出现，视为通栏页眉/水印；
# 奇偶页页眉交替时单侧重复率约 50%，阈值据此放宽，且排除带标点的题干问句
REPEAT_PAGE_RATIO = 0.5
REPEAT_MIN_PAGES = 4
REPEAT_MAX_LENGTH = 8
REPEAT_EXCLUDED_CHARS = ':：?？。！!，,'
# 识别置信度低且极短的行，多为竖排水印断字等碎片
FRAGMENT_MAX_LENGTH = 4
FRAGMENT_MIN_SCORE = 0.55
PAGE_NUMBER_PATTERN = re.compile(r'^\d{1,3}$')


def report(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def repeat_key(text: str) -> str:
    return re.sub(r'\s+', '', text)


def recognize_page(engine: RapidOCR, image: object, height: int | None) -> list[dict]:
    result = engine(image)
    lines: list[dict] = []
    if result is None or result.txts is None:
        return lines
    for text, box, score in zip(result.txts, result.boxes, result.scores):
        ys = [float(point[1]) for point in box]
        lines.append(
            {
                'text': str(text).strip(),
                'top': min(ys),
                'bottom': max(ys),
                'score': float(score),
            }
        )
    if height is None and lines:
        height = int(max(line['bottom'] for line in lines)) or None
    return lines


def filter_lines(pages: list[list[dict]], heights: list[int | None]) -> list[list[str]]:
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
            key
            for key, count in counts.items()
            if count / total >= REPEAT_PAGE_RATIO
        }

    kept_pages: list[list[str]] = []
    for lines, height in zip(pages, heights):
        kept: list[str] = []
        for line in lines:
            text = line['text']
            if not text:
                continue
            if PAGE_NUMBER_PATTERN.match(text):
                continue
            if len(text) <= FRAGMENT_MAX_LENGTH and line['score'] < FRAGMENT_MIN_SCORE:
                continue
            if len(text) <= REPEAT_MAX_LENGTH and repeat_key(text) in recurring:
                continue
            if height:
                # 仅当整行都落在边缘带内才剔除，压线但延伸进正文的行保留
                if line['top'] < height * EDGE_BAND_TOP and line['bottom'] < height * EDGE_BAND_TOP:
                    continue
                if (
                    line['top'] > height * (1 - EDGE_BAND_BOTTOM)
                    and line['bottom'] > height * (1 - EDGE_BAND_BOTTOM)
                ):
                    continue
            kept.append(text)
        kept_pages.append(kept)
    return kept_pages


def main() -> int:
    if len(sys.argv) != 3:
        raise ValueError('usage: ocr-worker.py <local-input> <markdown-output>')

    source = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).resolve()
    if not source.is_file():
        raise ValueError('input must be a local regular file')

    engine = RapidOCR()
    is_image = source.suffix.lower() in IMAGE_SUFFIXES
    image_height: int | None = None
    if is_image:
        with Image.open(str(source)) as opener:
            image_height = opener.height
    document = None if is_image else pdfium.PdfDocument(str(source))
    try:
        total = 1 if is_image else len(document)
        pages: list[list[dict]] = []
        heights: list[int | None] = []
        for index in range(total):
            if is_image:
                image: object = str(source)
                height = image_height
            else:
                bitmap = document[index].render(scale=RENDER_DPI / 72)
                rendered = np.asarray(bitmap.to_pil().convert('RGB'))
                image = rendered
                height = int(rendered.shape[0])
            lines = recognize_page(engine, image, height)
            pages.append(lines)
            heights.append(height)
            report(
                {
                    'page': index + 1,
                    'total': total,
                    'characters': sum(len(line['text']) for line in lines),
                }
            )
    finally:
        if document is not None:
            document.close()

    kept_pages = filter_lines(pages, heights)
    merged = '\n\n'.join('\n'.join(lines) for lines in kept_pages if lines)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(merged, encoding='utf-8')
    report({'done': True, 'characters': len(merged)})
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
