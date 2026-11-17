// VLM 按页精校 UI E2E：真实 Electron 实例 + 真实 OCR 导入管线（合成扫描 PDF）。
// 覆盖：模型设置页 VLM 开关的开启与持久化 → 工坊顶部开关与产物详情「VLM 按页精校」
// 的联动显隐（关闭时不出现精校按钮）→ 人工「编辑正文」保存后的往返持久化（UI 往返 + 磁盘文件）。
// 不调用真实模型服务：精校按钮只断言显隐联动，不触发推理。
// 引擎不可用时运行期跳过（打印警告，不计入真实闭环通过）。
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Page } from 'playwright'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, removeTempDataDir, type AppHandle } from './helpers'

const ENGINE_PYTHON =
  process.env.WORKBENCH_MARKITDOWN_PYTHON ??
  join(
    process.env.APPDATA ?? '',
    'tizhou',
    'knowledge-builder',
    'engine',
    '.venv',
    'Scripts',
    'python.exe'
  )

let engineAvailable = false
try {
  const probe = spawnSync(ENGINE_PYTHON, ['-c', 'import rapidocr, pypdfium2, PIL'], {
    stdio: 'ignore'
  })
  engineAvailable = probe.status === 0 && existsSync(ENGINE_PYTHON)
} catch {
  engineAvailable = false
}

const FIXTURE_DIR = join(tmpdir(), 'tizhou-e2e-vlm-src')
const MARKER = 'E2E-EDIT-MARKER 人工编辑往返校验'

let app: AppHandle | undefined
let dataDir: string | undefined
let suiteFailed = false

/** 生成合成扫描 PDF 素材（题本 3 题 + 解析册，图片页走真实 OCR 管线；依赖 PIL） */
function makeFixture(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const script = join(FIXTURE_DIR, '.gen.py')
  writeFileSync(
    script,
    String.raw`
import os, sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

def font(size, bold=False):
    paths = [r'C:\Windows\Fonts\simhei.ttf'] if bold else [r'C:\Windows\Fonts\simsun.ttc']
    for path in paths:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    raise SystemExit('no CJK font')

INK = (60, 58, 54)
BLACK = (26, 25, 23)

def render(lines):
    img = Image.new('RGB', (1240, 1754), 'white')
    d = ImageDraw.Draw(img)
    y = 120
    for size, bold, text in lines:
        d.text((96, y), text, fill=BLACK if bold else INK, font=font(size, bold))
        y += int(size * 1.7)
    return img

def jpeg(img):
    import io
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=80)
    return buf.getvalue()

def write_pdf(jpegs, out_path):
    objs = {}
    kids = []
    for i, data in enumerate(jpegs):
        img_no = 3 + i * 3
        cont_no = img_no + 1
        page_no = img_no + 2
        kids.append(str(page_no).encode() + b' 0 R')
        w, h = 1240, 1754
        objs[img_no] = (b'<< /Type /XObject /Subtype /Image /Width ' + str(w).encode() +
                        b' /Height ' + str(h).encode() +
                        b' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
                        str(len(data)).encode() + b' >>\nstream\n' + data + b'\nendstream')
        # 缩放到 MediaBox 尺寸，避免画面画出可视区
        content = b'q 595 0 0 842 0 0 cm /Im' + str(i).encode() + b' Do Q'
        objs[cont_no] = (b'<< /Length ' + str(len(content)).encode() +
                         b' >>\nstream\n' + content + b'\nendstream')
        objs[page_no] = (b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im' +
                         str(i).encode() + b' ' + str(img_no).encode() + b' 0 R >> >> /Contents ' +
                         str(cont_no).encode() + b' 0 R >>')
    out = bytearray(b'%PDF-1.4\n')
    offsets = {}
    order = [1, 2] + [n for i in range(len(jpegs)) for n in (3 + i * 3, 4 + i * 3, 5 + i * 3)]
    objs[1] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objs[2] = (b'<< /Type /Pages /Kids [' + b' '.join(kids) +
               b' ] /Count ' + str(len(jpegs)).encode() + b' >>')
    for no in order:
        offsets[no] = len(out)
        out += str(no).encode() + b' 0 obj\n' + objs[no] + b'\nendobj\n'
    xref_pos = len(out)
    out += (b'xref\n0 ' + str(len(order) + 1).encode() + b'\n0000000000 65535 f \n')
    for no in range(1, len(order) + 1):
        out += ('%010d 00000 n ' % offsets[no]).encode() + b'\n'
    out += (b'trailer\n<< /Size ' + str(len(order) + 1).encode() +
            b' /Root 1 0 R >>\nstartxref\n' + str(xref_pos).encode() + b'\n%%EOF')
    with open(out_path, 'wb') as fh:
        fh.write(bytes(out))

page1 = render([
    (40, True, '2026年度公务员录用考试模拟试卷（E2E 卷）'),
    (26, True, '第一部分 资料分析'),
    (26, False, '根据下表回答第 1～2 题：'),
    (26, False, '2025～2026 年某市快递业务发展情况（模拟数据）'),
    (26, False, '注：2024 年该市快递业务量为 8.2 亿件。'),
    (24, False, '1．该市快递业务量已从 2024 年的 8.2 亿件增至 2026 年的 11.5 亿件，2026 年比 2024 年增长了约：'),
    (24, False, 'A．24%'),
    (24, False, 'B．40%'),
    (24, False, 'C．58%'),
    (24, False, 'D．72%'),
    (24, False, '2．已知 2025 年该市快递业务量为 9.6 亿件，其同比增速约为：'),
    (24, False, 'A．8%'),
    (24, False, 'B．12%'),
    (24, False, 'C．17%'),
    (24, False, 'D．25%'),
    (24, False, '3．下列关于二十四节气的说法，错误的是：'),
    (24, False, 'A．立春是二十四节气之首'),
    (24, False, 'B．清明既是节气又是传统节日'),
    (24, False, 'C．大寒是一年中气温最高的节气'),
    (24, False, 'D．冬至这天北半球白昼最短'),
])
page2 = render([
    (40, True, '2026年度公务员录用考试模拟试卷（E2E 卷）'),
    (26, True, '解析册 · 参考答案与实战解析'),
    (26, False, '1．该市快递业务量已从 2024 年的 8.2 亿件增至 2026 年的 11.5 亿件，2026 年比 2024 年增长了约：'),
    (26, False, '【参考答案】B'),
    (26, False, '【实战解析】2026 年 11.5 亿件，2024 年 8.2 亿件，增长率约 40.2%，故选 B。'),
    (26, False, '2．已知 2025 年该市快递业务量为 9.6 亿件，其同比增速约为：'),
    (26, False, '【参考答案】C'),
    (26, False, '【实战解析】2025 年 9.6 亿件，2024 年 8.2 亿件，增速约 17.1%，故选 C。'),
    (26, False, '3．下列关于二十四节气的说法，错误的是：'),
    (26, False, '【参考答案】C'),
    (26, False, '【实战解析】大寒是气温最低的节气而非最高，C 项错误，故选 C。'),
])

write_pdf([jpeg(page1)], os.path.join(OUT, '2026模拟 题本.pdf'))
write_pdf([jpeg(page2)], os.path.join(OUT, '2026模拟 解析册.pdf'))
print('fixture ready')
`,
    'utf8'
  )
  const r = spawnSync(ENGINE_PYTHON, [script, FIXTURE_DIR], { encoding: 'utf8' })
  rmSync(script, { force: true })
  if (r.status !== 0) {
    throw new Error(`素材生成失败：${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  }
}

/** 等待元素出现后 DOM 级点击（绕过 Playwright 命中测试抖动） */
async function clickDomByTestId(page: Page, testId: string, index = 0): Promise<void> {
  await page.waitForFunction(
    ({ probe, want }) => document.querySelectorAll(`[data-testid="${probe}"]`).length > want,
    { probe: testId, want: index },
    { timeout: 30_000 }
  )
  const ok = await page.evaluate(
    ({ probe, want }) => {
      const node = document.querySelectorAll(`[data-testid="${probe}"]`)[want]
      if (!(node instanceof HTMLElement)) return false
      node.click()
      return true
    },
    { probe: testId, want: index }
  )
  expect(ok, 'DOM 点击失败：' + testId).toBe(true)
}

async function clickDomByText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (probe: string) =>
      [...document.querySelectorAll('button')].some((node) =>
        (node.textContent ?? '').includes(probe)
      ),
    text,
    { timeout: 30_000 }
  )
  const ok = await page.evaluate((probe: string) => {
    const node = [...document.querySelectorAll('button')].find((item) =>
      (item.textContent ?? '').includes(probe)
    )
    if (!(node instanceof HTMLElement)) return false
    node.click()
    return true
  }, text)
  expect(ok, 'DOM 点击失败：' + text).toBe(true)
}

/** Fluent v9 Switch：data-testid 落在 primary slot（即内层 input）；真实点击 + 轮询确认 */
async function toggleSwitchAndWait(
  page: Page,
  testId: string,
  expected: 'true' | 'false'
): Promise<void> {
  // 对 input 本身发起真实鼠标事件（force 跳过可见性检查），React onChange 可靠触发
  await page.locator(`[data-testid="${testId}"]`).first().click({ force: true })
  const wantChecked = expected === 'true'
  await page.waitForFunction(
    ({ probe, want }) => {
      const input = document.querySelector(`[data-testid="${probe}"]`) as HTMLInputElement | null
      return input?.checked === want
    },
    { probe: testId, want: wantChecked },
    { timeout: 15_000 }
  )
}

async function switchChecked(page: Page, testId: string): Promise<boolean> {
  // data-testid 即内层 input（Fluent v9 Switch primary slot），直接读 checked 属性
  return page.evaluate((probe: string) => {
    const input = document.querySelector(`[data-testid="${probe}"]`) as HTMLInputElement | null
    return input?.checked === true
  }, testId)
}

/** 等待导入产物卡片出现（含「切走再切回」重新拉取兜底） */
async function waitArtifacts(page: Page): Promise<void> {
  try {
    await page.getByTestId('builder-artifact-item').first().waitFor({ timeout: 240_000 })
  } catch {
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      window.location.hash = '#/knowledge-builder'
    })
    await page.getByTestId('builder-artifact-item').first().waitFor({ timeout: 120_000 })
  }
  await page.waitForTimeout(2_000)
}

describe('VLM 按页精校 UI 联动与人工编辑往返（真实 OCR 导入管线）', () => {
  beforeAll(async () => {
    if (!engineAvailable) return
    makeFixture()
    app = await launchApp()
    dataDir = app.dataDir
  }, 150_000)

  afterAll(async () => {
    if (app) {
      const dir = app.dataDir
      await closeApp(app)
      app = undefined
      if (!suiteFailed) await removeTempDataDir(dir)
      else console.error(`[e2e] 用例失败，保留数据目录供诊断：${dir}`)
    }
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
  })

  function itE2E(name: string, fn: (page: Page) => Promise<void>, timeout = 420_000): void {
    it(
      name,
      async () => {
        if (!engineAvailable) {
          console.warn('[e2e] 引擎不可用，跳过 VLM UI 用例')
          return
        }
        if (!app) throw new Error('应用未启动')
        onTestFailed(() => {
          suiteFailed = true
        })
        await fn(app.page)
      },
      timeout
    )
  }

  itE2E(
    '模型设置页 VLM 开关：默认关闭，开启并持久化',
    async (page) => {
      await page.getByRole('link', { name: '模型设置' }).click()
      await page.getByTestId('vlm-enable-switch').waitFor({ timeout: 30_000 })
      expect(await switchChecked(page, 'vlm-enable-switch')).toBe(false)
      await toggleSwitchAndWait(page, 'vlm-enable-switch', 'true')
      // 持久化：切走再切回，开关仍为开启
      await page.getByRole('link', { name: '今日工作台' }).click()
      await page.getByRole('link', { name: '模型设置' }).click()
      await page.getByTestId('vlm-enable-switch').waitFor({ timeout: 30_000 })
      expect(await switchChecked(page, 'vlm-enable-switch')).toBe(true)
    },
    120_000
  )

  itE2E('工坊顶部开关与详情精校按钮联动显隐：开启出现，关闭隐藏并出现提示', async (page) => {
    await page.getByRole('link', { name: '知识库工坊' }).click()
    const dirInput = page.getByLabel('原料目录')
    await dirInput.waitFor({ timeout: 30_000 })
    await dirInput.fill(FIXTURE_DIR)
    await clickDomByText(page, '扫描')
    await page.getByText('可转换文件').waitFor({ timeout: 30_000 })
    await clickDomByText(page, '全选')
    await page.getByTestId('rights-confirm').check({ force: true })
    await clickDomByText(page, '开始导入')
    await waitArtifacts(page)

    // 顶部开关应与模型设置联动（上一用例已开启）：进入工坊即为开启态
    expect(await switchChecked(page, 'workshop-vlm-switch')).toBe(true)
    // 选中第一个产物：开启态 + 来源页证据 → 详情出现精校按钮
    await clickDomByTestId(page, 'builder-artifact-select')
    await page.getByTestId('artifact-actions-row').waitFor({ timeout: 30_000 })
    await page.getByTestId('vlm-proofread-button').waitFor({ timeout: 20_000 })

    // 工坊顶部开关关闭 → 精校按钮隐藏，出现「开启顶部开关」提示
    await toggleSwitchAndWait(page, 'workshop-vlm-switch', 'false')
    await page.getByTestId('vlm-proofread-button').waitFor({ state: 'detached', timeout: 20_000 })
    await page.getByText('开启顶部「VLM 按页精校」开关后').first().waitFor({ timeout: 10_000 })

    // 重新开启 → 按钮恢复
    await toggleSwitchAndWait(page, 'workshop-vlm-switch', 'true')
    await page.getByTestId('vlm-proofread-button').waitFor({ timeout: 20_000 })
  })

  itE2E('人工「编辑正文」保存后往返持久化（UI 往返 + 磁盘文件）', async (page) => {
    await clickDomByTestId(page, 'builder-artifact-select')
    await clickDomByTestId(page, 'edit-markdown-button')
    const editor = page.getByTestId('manual-editor')
    await editor.waitFor({ timeout: 20_000 })
    const before = await editor.inputValue()
    expect(before.trim().length).toBeGreaterThan(0)
    await editor.fill(before + '\n\n' + MARKER)
    await clickDomByText(page, '保存正文')
    await page.getByText('正文已保存。').first().waitFor({ timeout: 30_000 })

    // UI 往返：切走再切回（重挂载重新拉取任务与产物），编辑内容仍在
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await page.waitForTimeout(800)
    await page.evaluate(() => {
      window.location.hash = '#/knowledge-builder'
    })
    await page.getByTestId('builder-artifact-item').first().waitFor({ timeout: 60_000 })
    await clickDomByTestId(page, 'builder-artifact-select')
    await clickDomByTestId(page, 'edit-markdown-button')
    await editor.waitFor({ timeout: 20_000 })
    expect(await editor.inputValue()).toContain(MARKER)

    // 磁盘持久化：任务目录中的产物 md 包含编辑标记
    expect(dataDir).toBeTruthy()
    const jobsDir = join(dataDir!, 'knowledge-builder', 'jobs')
    expect(existsSync(jobsDir), '任务目录不存在').toBe(true)
    let found = false
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (readFileSync(full, 'utf8').includes(MARKER)) {
          // 产物内容持久化在 artifacts/*.json 的 markdown 字段里，不限扩展名
          found = true
        }
      }
    }
    walk(jobsDir)
    expect(found, '任务目录中未找到包含编辑标记的产物 md').toBe(true)
  })
})
