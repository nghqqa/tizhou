import time
from rapid_doc.main import RapidDoc
from rapid_doc.data.data_reader_writer import FileBasedDataWriter

for name in ['资料分析600题本篇', '资料分析600题解析篇']:
    pdf = r'E:/BaiduNetdiskDownload/考公刷题本答案/资料分析600题/完整题本/' + name + '.pdf'
    out = r'E:/tizhou-ocr-bank/rapiddoc-ziliao/' + name
    md_writer = FileBasedDataWriter(out)
    img_writer = FileBasedDataWriter(out + '/images')
    started = time.time()
    doc = RapidDoc(table_enable=True, formula_enable=False, lang='ch',
                   output_dir=out, md_writer=md_writer, image_writer=img_writer)
    result = doc(pdf)
    print(name, 'done:', round(time.time() - started, 1), 's | md:', len(result.markdown), 'chars')
