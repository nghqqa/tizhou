# 生成带文字层的最小多页 PDF（仅标准库：手写 PDF 对象，每页一个文字流）。
# 用途：E2E 动态夹具——正式导入管线可从中提取文字（markitdown/文字层路径），
# 从而在真实管线（导入→解析→审核→证据渲染）中验证来源证据链路。
import sys
from pathlib import Path

def make_pdf(pages_text: list[str], out_path: str) -> None:
    """每页一个 Content Stream，文字用 Tj 运算符内嵌（Latin-1 可编码即可）。"""
    objects = []  # (obj_no, body_str)
    # 1: Catalog, 2: Pages, 3: Font
    objects.append((1, '<< /Type /Catalog /Pages 2 0 R >>'))
    kids = ' '.join(f'{4 + i * 2} 0 R' for i in range(len(pages_text)))
    objects.append((2, f'<< /Type /Pages /Kids [{kids}] /Count {len(pages_text)} >>'))
    objects.append((3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))
    for index, text in enumerate(pages_text):
        page_no = 4 + index * 2
        content_no = page_no + 1
        objects.append((page_no, f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_no} 0 R >>'))
        # 每行 14pt 垂直排布（720 向下递减）
        lines = text.split('\n')
        stream_parts = ['BT /F1 11 Tf']
        y = 800
        for line in lines:
            safe = line.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')
            stream_parts.append(f'1 0 0 1 40 {y} Tm ({safe}) Tj')
            y -= 16
        stream_parts.append('ET')
        stream = '\n'.join(stream_parts)
        objects.append((content_no, f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream'))
    # 序列化
    out = ['%PDF-1.4']
    offsets = {}
    for obj_no, body in objects:
        offsets[obj_no] = sum(len(line) + 1 for line in out)
        out.append(f'{obj_no} 0 obj\n{body}\nendobj')
    xref_pos = sum(len(line) + 1 for line in out)
    max_no = max(no for no, _ in objects)
    out.append(f'xref\n0 {max_no + 1}')
    out.append('0000000000 65535 f ')
    for no in range(1, max_no + 1):
        out.append(f'{offsets.get(no, 0):010d} 00000 n ')
    out.append(f'trailer\n<< /Size {max_no + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF')
    Path(out_path).write_bytes('\n'.join(out).encode('latin-1', errors='replace'))

if __name__ == '__main__':
    out = sys.argv[1]
    pages = sys.argv[2:] if len(sys.argv) > 2 else ['Page 1 default text']
    make_pdf(pages, out)
    print(f'written: {out} ({len(pages)} pages)')
