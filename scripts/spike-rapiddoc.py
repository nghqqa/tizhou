# -*- coding: utf-8 -*-
"""Spike: rapid-doc on real 资料分析600题本篇.pdf pages with tables."""
import time

from rapid_doc.main import RapidDoc
from rapid_doc.data.data_reader_writer import FileBasedDataWriter

PDF = r'E:/BaiduNetdiskDownload/考公刷题本答案/资料分析600题/完整题本/资料分析600题本篇.pdf'
OUT_DIR = r'E:/tizhou-ocr-bank/rapiddoc-spike'

md_writer = FileBasedDataWriter(OUT_DIR)
img_writer = FileBasedDataWriter(OUT_DIR + '/images')

started = time.time()
doc = RapidDoc(
    table_enable=True,
    formula_enable=False,
    lang='ch',
    output_dir=OUT_DIR,
    md_writer=md_writer,
    image_writer=img_writer,
)
print('init secs:', round(time.time() - started, 1))

started = time.time()
output = doc(PDF, start_page_id=1, end_page_id=4)
print('process secs:', round(time.time() - started, 1))

md = output.markdown
print('fields:', [n for n in dir(output) if not n.startswith('_')])
print('table rows in md:', md.count('|---') + md.count('| ---'))
print('--- md 前 2200 字 ---')
print(md[:2200])
