import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'

/**
 * 利用离屏 BrowserWindow 与 Chromium printToPDF 将 HTML 字符串渲染为 A4 PDF 字节流。
 */
export async function renderHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const tempDir = mkdtempSync(join(tmpdir(), 'tizhou-pdf-'))
  const tempHtmlPath = join(tempDir, `${randomUUID()}.html`)
  writeFileSync(tempHtmlPath, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 1280,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false
    }
  })

  try {
    await win.loadFile(tempHtmlPath)
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: {
        top: 0.55,
        bottom: 0.65,
        left: 0.55,
        right: 0.55
      },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:9px;color:#78716c;text-align:center;font-family:Microsoft YaHei,sans-serif;">题舟 Tizhou · 第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>'
    })
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
}
