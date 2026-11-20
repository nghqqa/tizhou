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
})
