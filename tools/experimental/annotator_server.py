# -*- coding: utf-8 -*-
"""Golden Set 本地离线标注工具（仅标准库，不调用任何外部 API）。

启动：
  <应用venv python> tools/experimental/annotator_server.py [端口，默认 8765]

浏览器打开 http://127.0.0.1:8765/
  - 左侧：300 DPI 原始页面渲染（缓存于 TIZHU_EXP_DIR/golden-renders/）；
  - 右侧：题号/题干/选项/答案/解析编辑，框选表格/图表/题干图/图片选项，
    标记水印/页眉/页脚区域，确认/待确认状态；
  - 保存：UTF-8 JSON（键序稳定、无时间戳），写入 docs/ocr-benchmark/golden/annotations/。
原 PDF 只读；不修改生产代码。
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gt_schema import validate  # noqa: E402

BENCH = REPO_ROOT / 'docs' / 'ocr-benchmark'
GOLDEN_DIR = BENCH / 'golden'
ANNOT_DIR = GOLDEN_DIR / 'annotations'
RENDER_DIR = Path(os.environ.get('TIZHU_EXP_DIR', 'E:/tizhou-ocr-bank/exp')) / 'golden-renders'
HTML_PATH = Path(__file__).resolve().parent / 'annotator.html'

RENDER_DPI = 300


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


def render_page_png(rel_path: str, page_number: int, page_id: str) -> Path:
    """300 DPI 渲染（磁盘缓存），坐标与 OCR 预填 bbox 同一坐标系。"""
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    dest = RENDER_DIR / f'{page_id}.png'
    if dest.is_file():
        return dest
    import cv2
    import numpy as np
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(resolve_pdf_path(rel_path))
    try:
        bitmap = doc[page_number - 1].render(scale=RENDER_DPI / 72)
        rgb = np.asarray(bitmap.to_pil().convert('RGB'))
    finally:
        doc.close()
    ok, encoded = cv2.imencode('.png', cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    if not ok:
        raise RuntimeError('渲染失败')
    dest.write_bytes(encoded.tobytes())
    return dest


def load_golden() -> dict:
    return json.loads((BENCH / 'golden-set.json').read_text(encoding='utf-8'))


def page_meta(golden: dict, page_id: str) -> dict | None:
    for page in golden['pages']:
        if page['pageId'] == page_id:
            return page
    return None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode('utf-8'),
                   'application/json; charset=utf-8')

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        golden = load_golden()
        if path in ('/', '/index.html'):
            self._send(200, HTML_PATH.read_bytes(), 'text/html; charset=utf-8')
        elif path == '/api/pages':
            pages = []
            for page in golden['pages']:
                anno = ANNOT_DIR / f"{page['pageId']}.json"
                pages.append({**page, 'status': (json.loads(anno.read_text(
                    encoding='utf-8'))['setStatus'] if anno.is_file() else '未标注')})
            self._json(200, {'pages': pages})
        elif path.startswith('/render/') and path.endswith('.png'):
            page_id = path[len('/render/'):-len('.png')]
            meta = page_meta(golden, page_id)
            if meta is None:
                self._json(404, {'error': 'unknown page'})
                return
            try:
                dest = render_page_png(meta['relPath'], meta['page'], page_id)
                self._send(200, dest.read_bytes(), 'image/png')
            except Exception as exc:
                self._json(500, {'error': str(exc)[:200]})
        elif path.startswith('/api/annotation/'):
            page_id = path.rsplit('/', 1)[-1]
            anno = ANNOT_DIR / f'{page_id}.json'
            if anno.is_file():
                self._send(200, anno.read_bytes(), 'application/json; charset=utf-8')
            else:
                self._json(200, {'exists': False})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith('/api/annotation/'):
            self._json(404, {'error': 'not found'})
            return
        page_id = path.rsplit('/', 1)[-1]
        golden = load_golden()
        if page_meta(golden, page_id) is None:
            self._json(404, {'error': 'unknown page'})
            return
        length = int(self.headers.get('Content-Length') or 0)
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception as exc:
            self._json(400, {'error': f'JSON 解析失败: {exc}'})
            return
        errors = validate(data, golden['pages'])
        if errors:
            self._json(400, {'error': '标注未通过 schema', 'details': errors})
            return
        # 稳定键序 + 无时间戳 → 可 diff
        ANNOT_DIR.mkdir(parents=True, exist_ok=True)
        dest = ANNOT_DIR / f'{page_id}.json'
        dest.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + '\n',
                        encoding='utf-8')
        self._json(200, {'saved': page_id, 'setStatus': data.get('setStatus')})

    def log_message(self, fmt, *args):  # 静默访问日志
        pass


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    if not (BENCH / 'golden-set.json').is_file():
        print('请先运行 golden_set.py 生成 golden-set.json', file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'标注工具: http://127.0.0.1:{port}/  (Ctrl+C 退出)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
