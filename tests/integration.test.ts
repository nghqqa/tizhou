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
})
