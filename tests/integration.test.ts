import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EssaySaveController } from '../src/renderer/src/services/exam-essay-save'
import { parseOcrWorkerLine, type OcrQualityPayload } from '../src/shared/ocr-payload'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('v0.9.7: exam finish blocked by save failure', () => {
  it('exam.finish is not called when drain returns hasFailure=true', async () => {
    const finishSpy = vi.fn()
    const controller = new EssaySaveController(
      async () => {
        throw new Error('save failed')
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', '重要答案')
    await controller.flushPending()
    const result = await controller.drain()
    // Simulate finish() logic: only call finish if no failure
    if (!result.hasFailure) {
      finishSpy()
    }
    expect(result.hasFailure).toBe(true)
    expect(finishSpy).not.toHaveBeenCalled()
  })

  it('exam.finish is called after retryAll succeeds', async () => {
    const finishSpy = vi.fn()
    let callCount = 0
    const controller = new EssaySaveController(
      async () => {
        callCount++
        if (callCount === 1) throw new Error('first attempt fails')
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', '答案')
    await controller.flushPending()
    const failResult = await controller.drain()
    expect(failResult.hasFailure).toBe(true)
    // Don't call finish yet
    if (!failResult.hasFailure) finishSpy()
    expect(finishSpy).not.toHaveBeenCalled()
    // Retry and check again
    const retryResult = await controller.retryAll()
    expect(retryResult.hasFailure).toBe(false)
    if (!retryResult.hasFailure) finishSpy()
    expect(finishSpy).toHaveBeenCalledTimes(1)
  })

  it('two questions both fail, both retained, retryAll retries both', async () => {
    const savedQuestions = new Set<string>()
    let shouldFail = true
    const controller = new EssaySaveController(
      async (save) => {
        if (shouldFail) throw new Error('fail')
        savedQuestions.add(save.questionId)
      },
      () => {}
    )
    controller.markDirty('exam1', 'q1', 'A')
    await controller.flushPending()
    controller.markDirty('exam1', 'q2', 'B')
    await controller.flushPending()
    const failResult = await controller.drain()
    expect(failResult.failedQuestionIds).toContain('q1')
    expect(failResult.failedQuestionIds).toContain('q2')
    expect(failResult.failedQuestionIds).toHaveLength(2)
    // Retry all
    shouldFail = false
    const retryResult = await controller.retryAll()
    expect(retryResult.hasFailure).toBe(false)
    expect(savedQuestions).toContain('q1')
    expect(savedQuestions).toContain('q2')
  })
})

// OCR 引擎装在用户数据目录（约 200MB），CI runner 上不存在。
// 缺引擎时显式跳过真实 worker 集成测试（CI 属预期跳过）；本地安装转换引擎后照常运行。
const VENV_PYTHON = join(
  process.env.APPDATA ?? '',
  'tizhou',
  'knowledge-builder',
  'engine',
  '.venv',
  'Scripts',
  'python.exe'
)
const WORKER = join(process.cwd(), 'tools', 'ocr-worker.py')
const OCR_ENGINE_AVAILABLE = existsSync(VENV_PYTHON) && existsSync(WORKER)
if (!OCR_ENGINE_AVAILABLE) {
  console.warn(
    '[integration] OCR 引擎未安装——真实 worker 集成测试跳过（CI 环境属预期；本地安装转换引擎后会运行）'
  )
}

describe.skipIf(!OCR_ENGINE_AVAILABLE)('v0.9.7: real Python OCR worker integration', () => {
  function createTextPdf(dir: string): string {
    const pdfPath = join(dir, 'text-test.pdf')
    // Minimal valid PDF with text layer (Helvetica, single page)
    const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 290 >>
stream
BT /F1 12 Tf 50 700 Td (1. This is a test question about civil service examination.) Tj ET
BT /F1 12 Tf 50 670 Td (A. Option one for the question) Tj ET
BT /F1 12 Tf 50 640 Td (B. Option two for the question) Tj ET
BT /F1 12 Tf 50 610 Td (C. Option three for the question) Tj ET
BT /F1 12 Tf 50 580 Td (D. Option four for the question) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000250 00000 n 
0000000580 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
665
%%EOF`
    writeFileSync(pdfPath, content, 'binary')
    return pdfPath
  }

  function runWorker(inputPath: string, outputPath: string): string {
    const result = execFileSync(VENV_PYTHON, [WORKER, inputPath, outputPath], {
      timeout: 120000,
      encoding: 'utf8'
    })
    return result
  }

  function createScannedPdf(dir: string): string {
    const pdfPath = join(dir, 'scanned-test.pdf')
    // Create image-only PDF using Python PIL (image with text drawn on it)
    const script = `
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (1240, 1754), 'white')
draw = ImageDraw.Draw(img)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 28) if __import__('os').path.exists('C:/Windows/Fonts/msyh.ttc') else ImageFont.load_default()
draw.text((100, 200), '1. This is a scanned question about examination.', fill='black', font=font)
draw.text((100, 250), 'A. Scanned option one', fill='black', font=font)
draw.text((100, 300), 'B. Scanned option two', fill='black', font=font)
draw.text((100, 350), 'C. Scanned option three', fill='black', font=font)
draw.text((100, 400), 'D. Scanned option four', fill='black', font=font)
img.save(r'${pdfPath.replace(/\\/g, '\\\\')}', 'PDF', resolution=200)`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 30000 })
    return pdfPath
  }

  function createMixedPdf(dir: string): string {
    const pdfPath = join(dir, 'mixed-test.pdf')
    // Page 1: text layer, Page 2: scanned image
    const textPdf = createTextPdf(dir)
    const script = `
from PIL import Image, ImageDraw, ImageFont
import pypdfium2 as pdfium
img = Image.new('RGB', (1240, 1754), 'white')
draw = ImageDraw.Draw(img)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 28) if __import__('os').path.exists('C:/Windows/Fonts/msyh.ttc') else ImageFont.load_default()
draw.text((100, 200), '5. This is a scanned page in mixed PDF.', fill='black', font=font)
draw.text((100, 250), 'A. Mixed option one', fill='black', font=font)
draw.text((100, 300), 'B. Mixed option two', fill='black', font=font)
img_path = r'${join(dir, 'scan-page.pdf').replace(/\\/g, '\\\\')}'
img.save(img_path, 'PDF', resolution=200)
# Merge text PDF + scan PDF
pdf1 = pdfium.PdfDocument(r'${textPdf.replace(/\\/g, '\\\\')}')
pdf2 = pdfium.PdfDocument(img_path)
dest = pdfium.PdfDocument.new()
for src in [pdf1, pdf2]:
    for i in range(len(src)):
        dest.import_pages(src, [i])
dest.save(r'${pdfPath.replace(/\\/g, '\\\\')}')`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 30000 })
    return pdfPath
  }

  it('processes pure text-layer PDF and reports textLayerPages > 0', { timeout: 120000 }, () => {
    const dir = temporaryDirectory('tizhou-ocr-text-')
    const pdfPath = createTextPdf(dir)
    const outPath = join(dir, 'output.md')
    const stdout = runWorker(pdfPath, outPath)
    const lines = stdout.trim().split('\n')
    const lastLine = lines[lines.length - 1]
    const payload = parseOcrWorkerLine(lastLine)
    expect(payload?.type).toBe('quality')
    const quality = payload as OcrQualityPayload
    expect(quality.totalPages).toBe(1)
    expect(quality.textLayerPages).toBe(1)
    expect(quality.ocrPages).toBe(0)
    const content = readFileSync(outPath, 'utf8')
    expect(content).toContain('test question')
  })

  it('processes scanned PDF with OCR and reports ocrPages > 0', { timeout: 180000 }, () => {
    const dir = temporaryDirectory('tizhou-ocr-scan-')
    const pdfPath = createScannedPdf(dir)
    const outPath = join(dir, 'output.md')
    const stdout = runWorker(pdfPath, outPath)
    const lines = stdout.trim().split('\n')
    const lastLine = lines[lines.length - 1]
    const payload = parseOcrWorkerLine(lastLine)
    expect(payload?.type).toBe('quality')
    const quality = payload as OcrQualityPayload
    expect(quality.totalPages).toBe(1)
    expect(quality.ocrPages).toBe(1)
    expect(quality.textLayerPages).toBe(0)
    expect(quality.averageConfidence).toBeDefined()
    // Output should contain OCR-recognized text
    const content = readFileSync(outPath, 'utf8')
    expect(content.length).toBeGreaterThan(20)
  })

  it(
    'processes mixed PDF: text-layer page + scanned page in correct order',
    { timeout: 180000 },
    () => {
      const dir = temporaryDirectory('tizhou-ocr-mixed-')
      const pdfPath = createMixedPdf(dir)
      const outPath = join(dir, 'output.md')
      const stdout = runWorker(pdfPath, outPath)
      const lines = stdout.trim().split('\n')
      const lastLine = lines[lines.length - 1]
      const payload = parseOcrWorkerLine(lastLine)
      expect(payload?.type).toBe('quality')
      const quality = payload as OcrQualityPayload
      expect(quality.totalPages).toBe(2)
      expect(quality.textLayerPages).toBe(1)
      expect(quality.ocrPages).toBe(1)
      // Confidence should only be from OCR page, not text-layer
      expect(quality.averageConfidence).toBeDefined()
      expect(quality.ocrLineCount).toBeGreaterThan(0)
      // Output should contain both text-layer and OCR content
      const content = readFileSync(outPath, 'utf8')
      expect(content).toContain('test question') // from text layer
      expect(content).toContain('scanned page') // from OCR
    }
  )

  it('parses real worker output through shared parseOcrWorkerLine', { timeout: 120000 }, () => {
    const dir = temporaryDirectory('tizhou-ocr-shared-')
    const pdfPath = createTextPdf(dir)
    const outPath = join(dir, 'output.md')
    const stdout = runWorker(pdfPath, outPath)
    const lines = stdout.trim().split('\n')
    // Every JSON line should be parseable by the shared module
    let progressCount = 0
    let qualityCount = 0
    for (const line of lines) {
      const payload = parseOcrWorkerLine(line)
      if (!payload) continue
      if (payload.type === 'progress') progressCount++
      if (payload.type === 'quality') qualityCount++
    }
    expect(qualityCount).toBe(1) // Exactly one final report
    expect(progressCount).toBeGreaterThanOrEqual(1) // At least one progress event
  })

  it('preprocess_for_ocr 漂白浅灰与浅彩水印并保护深黑与彩色印刷文字', () => {
    const script = `
import importlib.util, numpy as np
spec = importlib.util.spec_from_file_location('ocr_worker', r'${WORKER.replace(/\\/g, '\\\\')}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# 轻微底灰扫描页（225）上的浅灰水印、浅彩水印、深黑字、蓝色重点字、亮红重点字
img = np.full((600, 600, 3), 225, dtype=np.uint8)
img[50:120, 50:300] = [210, 210, 210]    # 浅灰水印
img[150:220, 50:300] = [235, 170, 170]   # 浅粉水印
img[300:340, 50:300] = [25, 25, 25]      # 深黑印刷字
img[360:400, 50:300] = [40, 130, 235]    # 蓝色标题/重点字
img[420:460, 50:300] = [230, 80, 60]     # 亮红重点字
img[480:520, 50:300] = [140, 180, 230]   # 中饱和浅蓝印刷标题
img[530:570, 50:300] = [235, 140, 120]   # 中饱和浅红印刷重点字
out = mod.preprocess_for_ocr(img)
assert out.shape == img.shape and out.dtype == np.uint8
assert int(out[80, 150].min()) == 255
assert int(out[180, 150].min()) == 255
assert int(out[320, 150].max()) < 40
# 蓝字与亮红字不得被漂白或严重漂淡
assert int(out[380, 150, 0]) < 80 and int(out[380, 150, 2]) > 180
assert int(out[440, 150, 0]) > 180 and int(out[440, 150, 2]) < 100
# 中饱和浅蓝/浅红标题不得被水印漂白置白，保留可辨色彩对比度
assert int(out[500, 150, 0]) <= 150 and int(out[500, 150, 2]) >= 210
assert int(out[550, 150, 0]) >= 210 and int(out[550, 150, 2]) <= 135
assert mod.RENDER_DPI >= 260
`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 30000 })
  })

  it('strip_edge_noise 仅剔除同槽位跨页重复页眉小图，不误删正文图与页顶独立小图', () => {
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location('ocr_worker', r'${WORKER.replace(/\\/g, '\\\\')}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# 场景1：2页文档每页同槽位页眉 Logo 剔除、正文大图保留
regions = [
  {'type': 'image', 'page': 0, 'bbox': [50, 20, 180, 90], 'imgPath': 'images/logo1.png', 'text': ''},
  {'type': 'image', 'page': 1, 'bbox': [50, 22, 180, 92], 'imgPath': 'images/logo2.png', 'text': ''},
  {'type': 'image', 'page': 0, 'bbox': [100, 220, 800, 520], 'imgPath': 'images/chart.png', 'text': ''},
]
md = '![](images/logo1.png)\\n\\n正文\\n\\n![](images/chart.png)\\n\\n![](images/logo2.png)'
new_md, removed, _ = mod.strip_edge_noise(md, regions)
assert 'logo1.png' not in new_md and 'logo2.png' not in new_md
assert 'chart.png' in new_md and removed == 2
assert regions[0]['type'] == 'discarded' and regions[1]['type'] == 'discarded' and regions[2]['type'] == 'image'

# 场景2：多页文档中，同槽位重复>=3页的右上角二维码被剔除，但不同槽位的页顶图推小图必须保留
regions2 = [
  {'type': 'image', 'page': 0, 'bbox': [820, 18, 910, 108], 'imgPath': 'images/qr0.png', 'text': ''},
  {'type': 'image', 'page': 1, 'bbox': [822, 20, 912, 110], 'imgPath': 'images/qr1.png', 'text': ''},
  {'type': 'image', 'page': 2, 'bbox': [818, 19, 908, 109], 'imgPath': 'images/qr2.png', 'text': ''},
  {'type': 'image', 'page': 3, 'bbox': [60, 20, 260, 120], 'imgPath': 'images/top_q1.png', 'text': ''},
  {'type': 'image', 'page': 4, 'bbox': [420, 25, 620, 125], 'imgPath': 'images/top_q2.png', 'text': ''},
]
md2 = '\\n'.join(f'![]({r["imgPath"]})' for r in regions2)
new_md2, removed2, _ = mod.strip_edge_noise(md2, regions2)
assert removed2 == 3
assert 'qr0.png' not in new_md2 and 'qr1.png' not in new_md2 and 'qr2.png' not in new_md2
assert 'top_q1.png' in new_md2 and 'top_q2.png' in new_md2
assert regions2[3]['type'] == 'image' and regions2[4]['type'] == 'image'

# 场景3：提供真实图片目录时，同槽位跨 4 页的不同内容题图（视觉不同源）绝不被误删，
# 同槽位跨 4 页的相同页眉 Logo（允许微偏移）正常剔除
import tempfile, numpy as np
from pathlib import Path
from PIL import Image

with tempfile.TemporaryDirectory() as td:
  img_dir = Path(td)
  # 4 张视觉完全不同的题干几何小图，落在相同页顶左槽位
  for idx in range(4):
    canvas = np.full((64, 64), 255, dtype=np.uint8)
    if idx == 0:
      canvas[8:28, 8:56] = 20
    elif idx == 1:
      canvas[36:56, 8:56] = 20
    elif idx == 2:
      canvas[8:56, 8:26] = 20
    else:
      canvas[8:56, 38:56] = 20
    Image.fromarray(canvas, mode='L').save(img_dir / f'q_{idx}.png')
  # 4 张相同页眉 Logo（带 1px 微偏移），落在相同页顶右槽位
  base_logo = np.full((64, 64), 255, dtype=np.uint8)
  base_logo[12:52, 12:24] = 30
  base_logo[12:24, 12:52] = 30
  base_logo[36:52, 36:52] = 30
  for idx in range(4):
    shifted = np.roll(base_logo, shift=(idx % 2, (idx // 2) % 2), axis=(0, 1))
    Image.fromarray(shifted, mode='L').save(img_dir / f'logo_{idx}.png')
  regions3 = []
  for idx in range(4):
    regions3.append({'type': 'image', 'page': idx, 'bbox': [60, 20, 220, 110], 'imgPath': f'images/q_{idx}.png', 'text': ''})
    regions3.append({'type': 'image', 'page': idx, 'bbox': [820, 18, 910, 108], 'imgPath': f'images/logo_{idx}.png', 'text': ''})
  md3 = '\\n'.join(f'![]({r["imgPath"]})' for r in regions3)
  new_md3, removed3, _ = mod.strip_edge_noise(md3, regions3, images_dir=img_dir)
  assert removed3 == 4
  for idx in range(4):
    assert f'q_{idx}.png' in new_md3
    assert f'logo_{idx}.png' not in new_md3
    assert regions3[idx * 2]['type'] == 'image'
    assert regions3[idx * 2 + 1]['type'] == 'discarded'

# 场景4：无图片目录的 20 页长文档中，偶发 3 页落在同槽位（<25% 占比）不整簇误删
regions4 = [
  {'type': 'image', 'page': 0, 'bbox': [60, 20, 220, 110], 'imgPath': 'images/p0.png', 'text': ''},
  {'type': 'image', 'page': 6, 'bbox': [62, 22, 222, 112], 'imgPath': 'images/p6.png', 'text': ''},
  {'type': 'image', 'page': 12, 'bbox': [58, 19, 218, 109], 'imgPath': 'images/p12.png', 'text': ''},
  {'type': 'text', 'page': 19, 'bbox': [60, 300, 900, 360], 'text': '末页正文'},
]
md4 = '\\n'.join(f'![]({r["imgPath"]})' for r in regions4 if r['type'] == 'image')
new_md4, removed4, _ = mod.strip_edge_noise(md4, regions4)
assert removed4 == 0
assert 'p0.png' in new_md4 and 'p6.png' in new_md4 and 'p12.png' in new_md4
`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 30000 })
  })

  it('strip_edge_noise 绝不因纯数字页码/套标题 discarded 块挖空正文年份或表格数值', () => {
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location('ocr_worker', r'${WORKER.replace(/\\/g, '\\\\')}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
regions = [
  {'type': 'discarded', 'page': 0, 'bbox': [50, 940, 100, 970], 'imgPath': '', 'text': '016'},
  {'type': 'discarded', 'page': 1, 'bbox': [50, 940, 100, 970], 'imgPath': '', 'text': '105'},
  {'type': 'discarded', 'page': 0, 'bbox': [60, 20, 200, 60], 'imgPath': '', 'text': '练习题 01套'},
  {'type': 'discarded', 'page': 0, 'bbox': [500, 20, 900, 60], 'imgPath': '', 'text': '一手最全公考资源加微信 SYA547'},
]
md = '\\n'.join([
  '# 练习题 01套',
  '2015～2016年中国生活服务电商市场交易规模统计表',
  '<table><tr><td>长春</td><td>2.016</td><td>1050</td></tr></table>',
  '7.（2018国考）如按2016年移动出行市场同比增长趋势估算，增速105%： 一手最全公考资源加微信 SYA547',
  '016',
])
cleaned, removed, _ = mod.strip_edge_noise(md, regions)
assert '练习题 01套' in cleaned
assert '2015～2016年' in cleaned
assert '<td>2.016</td><td>1050</td>' in cleaned
assert '如按2016年移动出行市场' in cleaned
assert '增速105%' in cleaned
assert '一手最全公考资源加微信 SYA547' not in cleaned
# 孤立页码行 016 整行剔除，不影响正文 2016
assert [l.strip() for l in cleaned.splitlines() if l.strip() == '016'] == []
assert removed >= 2
`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 30000 })
  })

  it('split_inline_options 支持 A-B / C-D / 题干+A-D 拆分，且不误伤正文与表格', () => {
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location('ocr_worker', r'${WORKER.replace(/\\/g, '\\\\')}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.split_inline_options('A．75 本 B．77 本') == ['A．75 本', 'B．77 本']
assert mod.split_inline_options('C. 352.5 D. 290.2') == ['C. 352.5', 'D. 290.2']
assert mod.split_inline_options('之比是？A. 7:2 B. 4:1C. 15:4 D. 17:8') == [
  '之比是？', 'A. 7:2', 'B. 4:1', 'C. 15:4', 'D. 17:8'
]
assert mod.split_inline_options('B. 6920C. 7712 D. 7800') == ['B. 6920', 'C. 7712', 'D. 7800']
assert mod.split_inline_options('以下是？A. A>B>C B. A>C>BC. B>C>A D. C>B>A') == [
  '以下是？', 'A. A>B>C', 'B. A>C>B', 'C. B>C>A', 'D. C>B>A'
]
assert mod.split_inline_options('问总收入多少？ A. 100 B. 200 C. 300 D. 400') == [
  '问总收入多少？', 'A. 100', 'B. 200', 'C. 300', 'D. 400'
]
# 正文中间偶发 B. ... C. ... 不误切
body = '据统计B. 某人认为C. 某事不符合要求'
assert mod.split_inline_options(body) == [body]
# 表格行不切
tbl = '<table><tr><td>A. 1</td><td>B. 2</td></tr></table>'
assert mod.split_inline_options(tbl) == [tbl]
# filter_lines 对文字层跨页长页眉与孤立第N页生效，同时拆开同行横排选项
pages = [
  [
    {'text': '关注“花生十三”公众号，每日图推、类比、速算等', 'top': 0, 'bottom': 0, 'score': 1.0},
    {'text': f'第 {i + 1} 页', 'top': 0, 'bottom': 0, 'score': 1.0},
    {'text': f'{i + 1}. 题目{i + 1}？', 'top': 0, 'bottom': 0, 'score': 1.0},
    {'text': 'A. 10 B. 20', 'top': 0, 'bottom': 0, 'score': 1.0},
    {'text': 'C. 30 D. 40', 'top': 0, 'bottom': 0, 'score': 1.0},
  ]
  for i in range(4)
]
kept, quality = mod.filter_lines(pages, [None] * 4, ['text-layer'] * 4)
assert quality['removedPageNumbers'] == 4
assert quality['removedNoiseLines'] == 4
assert kept[0] == ['1. 题目1？', 'A. 10', 'B. 20', 'C. 30', 'D. 40']
# 正向 PDF OCR 引擎默认关闭 180° 方向分类器（防纯数字倒翻与整行丢失）
engine = mod.create_pdf_ocr_engine()
assert engine.use_cls is False
`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 60000 })
  })

  it(
    'run_structured 对纯文字层 PDF 走快路径并输出与正文严格对齐的 _pages.json',
    { timeout: 60000 },
    () => {
      const dir = temporaryDirectory('tizhou-ocr-struct-fast-')
      const fixturePdf = join(process.cwd(), 'fixtures', 'text-only.pdf')
      const outPath = join(dir, 'output.md')
      const stdout = execFileSync(VENV_PYTHON, [WORKER, fixturePdf, outPath, '--structured'], {
        timeout: 60000,
        encoding: 'utf8'
      })
      const lastLine = stdout.trim().split('\n').pop() ?? ''
      const payload = parseOcrWorkerLine(lastLine)
      expect(payload?.type).toBe('quality')
      const quality = payload as OcrQualityPayload
      expect(quality.ocrPages).toBe(0)
      expect(quality.textLayerPages).toBeGreaterThan(0)
      const mdLines = readFileSync(outPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const manifest = JSON.parse(readFileSync(join(dir, 'images', '_pages.json'), 'utf8')) as {
        pages: Array<{ pageNumber: number; lines: string[] }>
      }
      const manifestLines = manifest.pages.flatMap((page) => page.lines)
      expect(manifestLines).toEqual(mdLines)
    }
  )

  it('order_ocr_lines 精准分离左右交替边栏批注，且绝不误切单栏或 2×2 选项页', () => {
    const script = `
import importlib.util
spec = importlib.util.spec_from_file_location('ocr_worker', r'${WORKER.replace(/\\/g, '\\\\')}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

W, H = 2000, 2800
# 场景1：左侧批注栏（x: 120..500）+ 右侧主解析栏（x: 620..1850），交错排列
left_sidebar_lines = [
  {'text': '1. 2021年全国发电量约多少：', 'left': 620, 'right': 1750, 'top': 350, 'bottom': 390, 'score': 0.99},
  {'text': '①花生批注：', 'left': 120, 'right': 360, 'top': 370, 'bottom': 405, 'score': 0.98},
  {'text': 'A. 6570', 'left': 650, 'right': 850, 'top': 420, 'bottom': 455, 'score': 0.99},
  {'text': 'B=8059 R=4.5%', 'left': 120, 'right': 420, 'top': 435, 'bottom': 465, 'score': 0.98},
  {'text': '【参考答案】C', 'left': 650, 'right': 1020, 'top': 500, 'bottom': 535, 'score': 0.99},
  {'text': '800 36 -30', 'left': 130, 'right': 390, 'top': 520, 'bottom': 555, 'score': 0.97},
  {'text': '【实战解析】定位材料第一段，求得A≈7710，选C。', 'left': 620, 'right': 1840, 'top': 580, 'bottom': 620, 'score': 0.99},
  {'text': 'A≈7710', 'left': 140, 'right': 340, 'top': 610, 'bottom': 645, 'score': 0.98},
  {'text': '2. 2022年用电量增长多少：', 'left': 620, 'right': 1720, 'top': 1150, 'bottom': 1190, 'score': 0.99},
  {'text': '②花生批注：415份数法', 'left': 120, 'right': 460, 'top': 1180, 'bottom': 1215, 'score': 0.98},
]
ordered_l = mod.order_ocr_lines(left_sidebar_lines, W, H)
texts_l = [x['text'] for x in ordered_l]
assert texts_l[:5] == [
  '1. 2021年全国发电量约多少：',
  'A. 6570',
  '【参考答案】C',
  '【实战解析】定位材料第一段，求得A≈7710，选C。',
  '2. 2022年用电量增长多少：',
]
assert texts_l[5] == '①花生批注：'

# 场景2：右侧批注栏（x: 1500..1880）+ 左侧主解析栏（x: 150..1360）
right_sidebar_lines = [
  {'text': '1. 某高校有甲乙丙三个专业，男女人数之比是？', 'left': 150, 'right': 1340, 'top': 350, 'bottom': 390, 'score': 0.99},
  {'text': '①花生批注：', 'left': 1520, 'right': 1760, 'top': 370, 'bottom': 405, 'score': 0.98},
  {'text': '【参考答案】D', 'left': 150, 'right': 520, 'top': 500, 'bottom': 535, 'score': 0.99},
  {'text': '赋值法使用时机：', 'left': 1520, 'right': 1860, 'top': 520, 'bottom': 555, 'score': 0.98},
  {'text': '【实战解析】根据比例赋值总人数200人，得17:8。', 'left': 150, 'right': 1350, 'top': 620, 'bottom': 660, 'score': 0.99},
  {'text': '①只有比例关系', 'left': 1520, 'right': 1850, 'top': 640, 'bottom': 675, 'score': 0.98},
  {'text': '2. 第二题题干内容测试长度足够长', 'left': 150, 'right': 1200, 'top': 1150, 'bottom': 1190, 'score': 0.99},
  {'text': '②无具体数字', 'left': 1520, 'right': 1820, 'top': 1170, 'bottom': 1205, 'score': 0.98},
]
ordered_r = mod.order_ocr_lines(right_sidebar_lines, W, H)
assert [x['text'] for x in ordered_r[:4]] == [
  '1. 某高校有甲乙丙三个专业，男女人数之比是？',
  '【参考答案】D',
  '【实战解析】根据比例赋值总人数200人，得17:8。',
  '2. 第二题题干内容测试长度足够长',
]

# 场景3：普通单栏题本（题干横跨全宽 + 2x2 选项）绝不误切
single_col = [
  {'text': '1. 下列关于经济发展的说法正确的一项是哪一项？', 'left': 150, 'right': 1800, 'top': 350, 'bottom': 390, 'score': 0.99},
  {'text': 'A. 10%', 'left': 180, 'right': 400, 'top': 420, 'bottom': 455, 'score': 0.99},
  {'text': 'B. 20%', 'left': 1050, 'right': 1280, 'top': 420, 'bottom': 455, 'score': 0.99},
  {'text': 'C. 30%', 'left': 180, 'right': 400, 'top': 480, 'bottom': 515, 'score': 0.99},
  {'text': 'D. 40%', 'left': 1050, 'right': 1280, 'top': 480, 'bottom': 515, 'score': 0.99},
  {'text': '2. 下列关于社会治理的表述不正确的是哪一项？', 'left': 150, 'right': 1780, 'top': 600, 'bottom': 640, 'score': 0.99},
  {'text': 'A. 选项甲', 'left': 180, 'right': 420, 'top': 680, 'bottom': 715, 'score': 0.99},
  {'text': 'B. 选项乙', 'left': 1050, 'right': 1300, 'top': 680, 'bottom': 715, 'score': 0.99},
  {'text': 'C. 选项丙', 'left': 180, 'right': 420, 'top': 740, 'bottom': 775, 'score': 0.99},
  {'text': 'D. 选项丁', 'left': 1050, 'right': 1300, 'top': 740, 'bottom': 775, 'score': 0.99},
]
assert [x['text'] for x in mod.order_ocr_lines(single_col, W, H)] == [x['text'] for x in single_col]

# 场景4：高频【参考答案】B 等解析结构标签跨 ≥50% 页出现时绝不可被 filter_lines 当作页眉误删
sol_pages = [
  [
    {'text': '花生十三言语理解解析', 'left': 700, 'right': 1200, 'top': 40, 'bottom': 75, 'score': 0.99},
    {'text': f'{i + 1}. 某题干示例文本用于测试解析过滤逻辑。', 'left': 150, 'right': 1300, 'top': 300, 'bottom': 340, 'score': 0.99},
    {'text': '【参考答案】B', 'left': 150, 'right': 480, 'top': 380, 'bottom': 420, 'score': 0.99},
    {'text': '【题型与文段类型】中心理解，总分结构', 'left': 150, 'right': 850, 'top': 430, 'bottom': 470, 'score': 0.99},
    {'text': '【实战解析】文段开篇提出核心观点，对应 B 项。', 'left': 150, 'right': 1200, 'top': 490, 'bottom': 530, 'score': 0.99},
  ]
  for i in range(6)
]
kept_sol, _ = mod.filter_lines(sol_pages, [H] * 6, ['ocr'] * 6)
assert all('【参考答案】B' in p for p in kept_sol), f'lost answer line: {kept_sol}'
assert all('花生十三言语理解解析' not in p for p in kept_sol), f'header not removed: {kept_sol}'
`
    execFileSync(VENV_PYTHON, ['-c', script], { timeout: 30000 })
  })
})
