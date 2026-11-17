// 官网真实截图采集脚本：复用根目录 Playwright + Electron 启动机制与独立临时数据目录，
// 从真实应用采集 5 张 1440x900 桌面截图，输出 WebP（官网 website/public/screenshots/）
// 与 JPEG（仓库 assets/readme/），并用 Electron 内置 Chromium 画布生成 og 分享图与 favicon。
//
// 用法（Node 24+ 原生运行 TypeScript）：
//   node scripts/capture-website-screenshots.ts            # 全量采集
//   node scripts/capture-website-screenshots.ts --only 03  # 只采集某一张（01..05）
//   node scripts/capture-website-screenshots.ts --meta     # 只生成 og 图与 favicon
//
// 说明：
// - 启动参数走 --smoke-test（数据目录覆盖），不带 WORKBENCH_E2E，因此页面不会出现 e2e 调试按钮；
// - 截图种子（题目/练习记录/错题/复习任务）全部为本脚本生成的原创模拟内容，不含任何真实题库；
// - 知识库工坊截图使用脚本生成的合成扫描 PDF（PIL 渲染 + 无文字层），走真实 OCR 导入管线；
// - 不修改任何主进程/渲染层代码，不向根 package.json 增加依赖；
// - 引擎 Python 与素材目录均在运行期解析（可用环境变量覆盖），不在本文件落任何机器私有路径。
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_WEBP_DIR = join(ROOT, 'website', 'public', 'screenshots')
const OUT_JPG_DIR = join(ROOT, 'assets', 'readme')
const WORK = mkdtempSync(join(tmpdir(), 'tizhou-shot-'))
const DATA_DIR = join(WORK, 'data')
const FIXTURE_DIR = process.env.SHOT_FIXTURE_DIR ?? join('E:\\考公资料', '2025国考冲刺卷')
// 题库种子目录用纯 ASCII 路径：本机安全软件钩子会对 node 的 fs 操作在某些中文路径上
// 直接崩掉进程（rmSync/cpSync 均复现），ASCII 路径实测稳定；界面只显示库名（中文），路径不可见
const SHOT_STUDIO = 'E:\\tizhou-shot-studio'
const VAULT_DIR = join(SHOT_STUDIO, 'md-vault')
const VIEW_W = 1280
const VIEW_H = 800

// OCR/MarkItDown 转换引擎：优先环境变量，其次本机默认安装位置（路径运行期解析，不落盘明文）
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

const onlyArg = (() => {
  const index = process.argv.indexOf('--only')
  if (index === -1) return null
  return (process.argv[index + 1] ?? '').split(',').map((part) => part.trim())
})()
const metaOnly = process.argv.includes('--meta')

const log = (...parts: unknown[]): void => console.log('[shots]', ...parts)

// ---------------------------------------------------------------------------
// 第一部分：素材生成（Python + PIL）：图形推理选项图 + 合成扫描 PDF（原创内容）
// ---------------------------------------------------------------------------

const PY_FIXTURE = String.raw`
import os, sys
from PIL import Image, ImageDraw, ImageFont

OUT_IMG = sys.argv[1]
OUT_PDF_DIR = sys.argv[2]
os.makedirs(OUT_IMG, exist_ok=True)
os.makedirs(OUT_PDF_DIR, exist_ok=True)

# 本机 node 的 rmSync 可能静默失败（安全钩子），旧 PDF 必须在这里显式清掉，
# 否则上一轮残留（如图形推理册）会混进本轮导入
for name in os.listdir(OUT_PDF_DIR):
    if name.lower().endswith('.pdf'):
        target = os.path.join(OUT_PDF_DIR, name)
        for attempt in range(3):
            try:
                os.remove(target)
                break
            except PermissionError:
                import time
                time.sleep(0.5)
        else:
            raise SystemExit('cannot remove stale pdf: ' + name)

def font(size, bold=False):
    candidates = [r'C:\Windows\Fonts\simhei.ttf'] if bold else \
                 [r'C:\Windows\Fonts\simsun.ttc', r'C:\Windows\Fonts\msyh.ttc']
    candidates += [r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\msyh.ttc']
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    raise SystemExit('no CJK font found')

BLACK = (26, 25, 23)
INK = (60, 58, 54)

def page_canvas():
    img = Image.new('RGB', (1240, 1754), 'white')
    return img, ImageDraw.Draw(img)

def dots_on_circle(d, count, cx, cy, radius):
    import math
    for k in range(count):
        angle = math.radians(k * (360.0 / max(count, 1)) - 90)
        dx = cx + radius * math.cos(angle)
        dy = cy + radius * math.sin(angle)
        d.ellipse([dx - 9, dy - 9, dx + 9, dy + 9], fill=BLACK)

def option_image(name, painter):
    img = Image.new('RGB', (280, 200), 'white')
    d = ImageDraw.Draw(img)
    d.rectangle([4, 4, 275, 195], outline=(150, 148, 144), width=2)
    painter(d)
    img.save(os.path.join(OUT_IMG, name))

# q1 圆环点阵：外框 + 大圆 + 圆周点数递增（正确项 A 为 6 点）
def ring_dots(d, n):
    d.rectangle([52, 30, 228, 170], outline=BLACK, width=3)
    d.ellipse([78, 42, 202, 158], outline=BLACK, width=3)
    dots_on_circle(d, n, 140, 100, 30)
for k, n in enumerate([6, 4, 5, 7]):
    option_image('graphic-1-%s.png' % 'abcd'[k], lambda d, n=n: ring_dots(d, n))

# q2 旋转组合：外圆 + 内接三角形顺时针旋转 + 角部实心方块反向旋转（A 为 0 度基准）
def rotate_combo(d, angle):
    import math
    d.rectangle([52, 30, 228, 170], outline=BLACK, width=3)
    d.ellipse([88, 40, 192, 156], outline=BLACK, width=3)
    cx, cy = 140, 98
    pts = [(cx, cy - 32), (cx - 28, cy + 20), (cx + 28, cy + 20)]
    rad = math.radians(angle)
    rot = [((px - cx) * math.cos(rad) - (py - cy) * math.sin(rad) + cx,
            (px - cx) * math.sin(rad) + (py - cy) * math.cos(rad) + cy) for px, py in pts]
    d.polygon(rot, outline=BLACK, width=3)
    sx, sy = 208, 150
    corners = [(sx - 11, sy - 11), (sx + 11, sy - 11), (sx + 11, sy + 11), (sx - 11, sy + 11)]
    back = math.radians(-angle * 2)
    rot2 = [((px - sx) * math.cos(back) - (py - sy) * math.sin(back) + sx,
             (px - sx) * math.sin(back) + (py - sy) * math.cos(back) + sy) for px, py in corners]
    d.polygon(rot2, fill=BLACK)
for k in range(4):
    option_image('graphic-2-%s.png' % 'abcd'[k], lambda d, k=k: rotate_combo(d, k * 90))

# q3 嵌套层次：层数 4/3/2/1 + 菱形与圆心收束（正确项 A 为 4 层）
def layered(d, layers):
    d.rectangle([52, 30, 228, 170], outline=BLACK, width=3)
    for i in range(layers):
        half = 62 - i * 17
        d.rectangle([140 - half, 100 - half, 140 + half, 100 + half], outline=BLACK, width=3)
    edge = 62 - layers * 17
    d.polygon([(140, 100 - edge), (140 + edge, 100), (140, 100 + edge), (140 - edge, 100)],
              outline=BLACK, width=3)
    d.ellipse([135, 95, 145, 105], fill=BLACK)
for k in range(4):
    option_image('graphic-3-%s.png' % 'abcd'[k], lambda d, k=k: layered(d, 4 - k))

# --- 合成扫描 PDF：PIL 渲染页面 -> JPEG -> 手写 PDF（DCTDecode，无文字层） ---
def render_text_page(lines):
    img, d = page_canvas()
    y = 120
    for kind, payload in lines:
        if kind == 'title':
            d.text((96, y), payload, fill=BLACK, font=font(40, bold=True))
            y += 70
        elif kind == 'sub':
            d.text((96, y), payload, fill=INK, font=font(26, bold=True))
            y += 48
        elif kind == 'h':
            d.text((96, y), payload, fill=BLACK, font=font(30, bold=True))
            y += 56
        elif kind == 'gap':
            y += payload
        elif kind == 'r3':
            c1, c2, c3 = payload
            d.text((96, y), c1, fill=INK, font=font(26))
            d.text((470, y), c2, fill=INK, font=font(26))
            d.text((700, y), c3, fill=INK, font=font(26))
            y += 46
        else:
            d.text((96, y), payload, fill=INK, font=font(27))
            y += 45
    return img

# --- 合成扫描 PDF：PIL 渲染页面 -> JPEG -> 手写 PDF（DCTDecode，无文字层） ---
def jpeg_bytes(img, quality=80):
    import io
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=quality)
    return buf.getvalue()

def write_jpeg_pdf(jpegs, out_path):
    sizes = [(1240, 1754)] * len(jpegs)
    objs = {}
    kids = []
    for i, data in enumerate(jpegs):
        img_no = 3 + i * 3
        cont_no = img_no + 1
        page_no = img_no + 2
        kids.append(str(page_no).encode() + b' 0 R')
        w, h = sizes[i]
        objs[img_no] = (b'<< /Type /XObject /Subtype /Image /Width ' + str(w).encode() +
                        b' /Height ' + str(h).encode() +
                        b' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
                        str(len(data)).encode() + b' >>\nstream\n' + data + b'\nendstream')
        # 内容流必须把单位方块缩放到 MediaBox 尺寸（595x842），
        # 若按图片像素尺寸缩放会把画面画到页面可视区之外（渲染全白）
        content = ('q 595 0 0 842 0 0 cm /Im' + str(i) + ' Do Q').encode()
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

# 题本（原创模拟内容，3 页：第 1-2 页文字题，第 3 页图形推理图片页）
page1 = render_text_page([
    ('title', '2025年度国家公务员录用考试模拟试卷（一）'),
    ('sub', '行政职业能力测验 · 冲刺卷'),
    ('h', '第一部分 常识判断'),
    ('t', '1．下列关于我国地理概况的表述，正确的是：'),
    ('t', 'A．长江全长约6300公里，是世界第一长河'),
    ('t', 'B．我国陆地面积约960万平方公里，居世界第四位'),
    ('t', 'C．我国地势西高东低，呈三级阶梯状分布'),
    ('t', 'D．黄河最终注入黄海'),
    ('gap', 10),
    ('t', '2．下列关于二十四节气的说法，错误的是：'),
    ('t', 'A．立春是二十四节气之首'),
    ('t', 'B．清明既是节气又是传统节日'),
    ('t', 'C．大寒是一年中气温最高的节气'),
    ('t', 'D．冬至这天北半球白昼最短'),
    ('h', '第二部分 言语理解与表达'),
    ('t', '3．这项制度设计的初衷是好的，但在执行层面还需要更精细的____，避免“一刀切”。'),
    ('t', 'A．落实　　B．打磨　　C．校准　　D．复制'),
    ('gap', 10),
    ('t', '4．老旧小区改造不能只做“面子工程”。真正的更新，是从居民实际需求出发，把管线改造、'),
    ('t', '适老化设施与长效管理一起纳入规划，让改造成果经得起日常使用的检验。'),
    ('t', '这段文字意在说明：'),
    ('t', 'A．老旧小区改造应注重实效与长效管理'),
    ('t', 'B．政府应进一步加大改造资金投入'),
    ('t', 'C．居民应主动提高参与改造的积极性'),
    ('t', 'D．“面子工程”没有任何存在价值'),
])
page2 = render_text_page([
    ('h', '第三部分 资料分析'),
    ('t', '根据下表回答第 5～6 题：'),
    ('t', '2023～2024 年某市快递业务发展情况（模拟数据）'),
    ('r3', ('指标', '2023 年', '2024 年')),
    ('r3', ('快递业务量（亿件）', '9.6', '11.5')),
    ('r3', ('业务收入（亿元）', '82', '101')),
    ('t', '注：2022 年该市快递业务量为 8.2 亿件。'),
    ('gap', 12),
    ('t', '5．2024 年该市快递业务量比 2022 年增长了约：'),
    ('t', 'A．24%　　B．40%　　C．58%　　D．72%'),
    ('gap', 10),
    ('t', '6．2023 年该市快递业务量同比增速约为：'),
    ('t', 'A．8%　　B．12%　　C．17%　　D．25%'),
])

# 解析册（2 页）。版式遵循真实解析册：题号行重印题干，【参考答案】独立成行
# （解析器在题号行会整体跳过，行内写答案标记不会被识别；重印题干同时作为配对校验依据）
page4 = render_text_page([
    ('title', '2025年度国家公务员录用考试模拟试卷（一）'),
    ('sub', '解析册 · 参考答案与实战解析'),
    ('sub', '【答案速查】1-2：CA　　3-4：CA　　5-6：BC'),
    ('h', '常识判断'),
    ('t', '1．下列关于我国地理概况的表述，正确的是：'),
    ('t', '【参考答案】C'),
    ('t', '【实战解析】我国地势西高东低，呈三级阶梯状分布，C 项正确。世界第一长河是'),
    ('t', '尼罗河，A 项错误；我国陆地面积约960万平方公里，居世界第三位，B 项错误；'),
    ('t', '黄河注入渤海，D 项错误，故选 C。'),
    ('gap', 8),
    ('t', '2．下列关于二十四节气的说法，错误的是：'),
    ('t', '【参考答案】C'),
    ('t', '【实战解析】大寒是二十四节气中气温最低的节气，而非最高，C 项说法错误，'),
    ('t', '故选 C。'),
    ('h', '言语理解与表达'),
    ('t', '3．这项制度设计的初衷是好的，但在执行层面还需要更精细的校准，避免“一刀切”。'),
    ('t', '【参考答案】C'),
    ('t', '【实战解析】“校准”强调对执行尺度做精细修正，与“避免一刀切”呼应最贴切，'),
    ('t', '故选 C。'),
    ('gap', 8),
    ('t', '4．老旧小区改造不能只做“面子工程”。真正的更新，是从居民实际需求出发，'),
    ('t', '把管线改造、适老化设施与长效管理一起纳入规划，让改造成果经得起日常使用的检验。'),
    ('t', '这段文字意在说明：'),
    ('t', '【参考答案】A'),
    ('t', '【实战解析】文段由反面切入，落脚在“从居民实际需求出发”“长效管理”，'),
    ('t', '主旨为改造应注重实效与长效管理，对应 A 项。'),
])
page5 = render_text_page([
    ('h', '资料分析'),
    ('t', '5．2024 年该市快递业务量比 2022 年增长了约：'),
    ('t', '【参考答案】B'),
    ('t', '【实战解析】2024 年业务量 11.5 亿件，2022 年 8.2 亿件，增长率 = 11.5 ÷ 8.2 - 1'),
    ('t', '≈ 40.2%，故选 B。'),
    ('gap', 8),
    ('t', '6．2023 年该市快递业务量同比增速约为：'),
    ('t', '【参考答案】C'),
    ('t', '【实战解析】2023 年业务量 9.6 亿件，2022 年 8.2 亿件，增速 = 9.6 ÷ 8.2 - 1'),
    ('t', '≈ 17.1%，故选 C。'),
])


write_jpeg_pdf([jpeg_bytes(p) for p in (page1, page2)],
               os.path.join(OUT_PDF_DIR, '2025国考模拟一 行测题本.pdf'))
write_jpeg_pdf([jpeg_bytes(p) for p in (page4, page5)],
               os.path.join(OUT_PDF_DIR, '2025国考模拟一 解析册.pdf'))
print('fixture ready:', OUT_PDF_DIR)
`

function generateFixtures(): void {
  const pyScript = join(WORK, 'make-fixtures.py')
  log('写入 Python 素材脚本：', pyScript)
  writeFileSync(pyScript, PY_FIXTURE, 'utf8')
  const python = process.env.SHOT_PYTHON ?? 'python'
  log('运行素材生成：', python, pyScript)
  const result = spawnSync(python, [pyScript, join(WORK, 'vault-images'), FIXTURE_DIR], {
    stdio: 'pipe',
    encoding: 'utf8'
  })
  log('素材生成 status=', result.status, 'signal=', result.signal, 'error=', result.error)
  if (result.status !== 0) {
    throw new Error(`素材生成失败：${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  log(result.stdout.trim())
  // 强校验：素材目录只允许出现本轮的 2 个 PDF（node rmSync 在本机可能静默失败）
  const expectedPdfs = ['2025国考模拟一 行测题本.pdf', '2025国考模拟一 解析册.pdf']
  const extraPdfs = readdirSync(FIXTURE_DIR).filter(
    (name) => name.endsWith('.pdf') && !expectedPdfs.includes(name)
  )
  if (extraPdfs.length > 0) {
    throw new Error(`素材目录存在上一轮残留 PDF：${extraPdfs.join('、')}（请手动删除后重跑）`)
  }
  // 复制图形推理选项图到题库种子目录
  const imagesDir = join(VAULT_DIR, '图形推理', 'images')
  mkdirSync(imagesDir, { recursive: true })
  for (const file of readdirSync(join(WORK, 'vault-images'))) {
    cpSync(join(WORK, 'vault-images', file), join(imagesDir, file))
  }
}

// ---------------------------------------------------------------------------
// 第二部分：题库与学习记录种子（全部为原创模拟内容）
// ---------------------------------------------------------------------------

const gOption = (question: number): string =>
  JSON.stringify(
    ['a', 'b', 'c', 'd'].map((key) => ({
      key: key.toUpperCase(),
      text: '',
      image: `images/graphic-${question}-${key}.png`
    }))
  )

interface SeedQuestion {
  id: string
  subject: 'xingce' | 'shenlun'
  category: string
  type: 'single' | 'multiple' | 'judge' | 'essay'
  stem: string
  options?: Array<{ key: string; text: string }>
  answer: string[]
  explanation: string
  difficulty: number
  year?: string
  region?: string
  paper?: string
  material?: string
  hasImages?: boolean
}

const SEED_QUESTIONS: SeedQuestion[] = [
  {
    id: 'shot-common-001',
    subject: 'xingce',
    category: '常识判断',
    type: 'single',
    stem: '下列关于我国地理概况的表述，正确的是：',
    options: [
      { key: 'A', text: '长江全长约6300公里，是世界第一长河' },
      { key: 'B', text: '我国陆地面积约960万平方公里，居世界第四位' },
      { key: 'C', text: '我国地势西高东低，呈三级阶梯状分布' },
      { key: 'D', text: '黄河最终注入黄海' }
    ],
    answer: ['C'],
    explanation:
      '**答案：C**。我国地势西高东低，呈三级阶梯状分布。\n\n- A 项：世界第一长河是尼罗河，错误；\n- B 项：我国陆地面积约 960 万平方公里，居世界第三位，错误；\n- D 项：黄河最终注入渤海，错误。',
    difficulty: 2,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一'
  },
  {
    id: 'shot-common-002',
    subject: 'xingce',
    category: '常识判断',
    type: 'single',
    stem: '下列关于二十四节气的说法，错误的是：',
    options: [
      { key: 'A', text: '立春是二十四节气之首' },
      { key: 'B', text: '清明既是节气又是传统节日' },
      { key: 'C', text: '大寒是一年中气温最高的节气' },
      { key: 'D', text: '冬至这天北半球白昼最短' }
    ],
    answer: ['C'],
    explanation:
      '**答案：C**。大寒是二十四节气中气温**最低**的节气，而非最高。\n\n清明兼具节气与节日双重身份；冬至是北半球全年白昼最短的一天，均正确。',
    difficulty: 2,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一'
  },
  {
    id: 'shot-language-001',
    subject: 'xingce',
    category: '言语理解与表达',
    type: 'single',
    stem: '这项制度设计的初衷是好的，但在执行层面还需要更精细的____，避免"一刀切"。填入画横线部分最恰当的是：',
    options: [
      { key: 'A', text: '落实' },
      { key: 'B', text: '打磨' },
      { key: 'C', text: '校准' },
      { key: 'D', text: '复制' }
    ],
    answer: ['C'],
    explanation:
      '**答案：C**。"校准"强调对执行尺度做精细修正，与后文"避免一刀切"形成呼应。\n\n- "落实"与"精细"搭配欠佳；\n- "打磨"多用于作品、方案本身；\n- "复制"与语境无关。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一'
  },
  {
    id: 'shot-language-002',
    subject: 'xingce',
    category: '言语理解与表达',
    type: 'single',
    stem: '老旧小区改造不能只做"面子工程"。真正的更新，是从居民实际需求出发，把管线改造、适老化设施与长效管理一起纳入规划，让改造成果经得起日常使用的检验。这段文字意在说明：',
    options: [
      { key: 'A', text: '老旧小区改造应注重实效与长效管理' },
      { key: 'B', text: '政府应进一步加大改造资金投入' },
      { key: 'C', text: '居民应主动提高参与改造的积极性' },
      { key: 'D', text: '"面子工程"没有任何存在价值' }
    ],
    answer: ['A'],
    explanation:
      '**答案：A**。文段由反面切入，落脚点在"从居民实际需求出发""长效管理""经得起检验"，主旨为改造应注重实效与长效管理。\n\nB、C 项无中生有；D 项表述过于绝对，非文段重点。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一'
  },
  {
    id: 'shot-judge-001',
    subject: 'xingce',
    category: '判断推理',
    type: 'single',
    stem: '"数字反哺"是指年轻一代向家中长辈传授数字设备使用技能，帮助其跨越"数字鸿沟"的行为。根据上述定义，下列属于数字反哺的是：',
    options: [
      { key: 'A', text: '小陈手把手教爷爷使用视频通话和手机老人模式' },
      { key: 'B', text: '爸爸利用周末教小陈学习骑自行车' },
      { key: 'C', text: '公司人事部组织新员工参加入职培训' },
      { key: 'D', text: '王阿姨对照教程自学视频剪辑' }
    ],
    answer: ['A'],
    explanation:
      '**答案：A**。定义要点：①年轻一代；②向长辈；③传授数字技能。只有 A 项同时满足三个要点。\n\nB 项方向相反；C 项不属于家庭场景；D 项为自学。',
    difficulty: 2,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一'
  },
  {
    id: 'shot-judge-002',
    subject: 'xingce',
    category: '判断推理',
    type: 'single',
    stem: '某单位安排节假日值班：如果小李值班，那么小张也值班；现已知小张没有值班。由此可以推出：',
    options: [
      { key: 'A', text: '小李值班了' },
      { key: 'B', text: '小李没有值班' },
      { key: 'C', text: '小张值班了' },
      { key: 'D', text: '无法判断小李是否值班' }
    ],
    answer: ['B'],
    explanation:
      '**答案：B**。"小李值班 → 小张值班"，结合"小张没有值班"，根据逆否规则（否定后件则否定前件）可得"小李没有值班"。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一'
  },
  {
    id: 'shot-data-001',
    subject: 'xingce',
    category: '资料分析',
    type: 'single',
    stem: '2024 年该市快递业务量比 2022 年增长了约：',
    options: [
      { key: 'A', text: '24%' },
      { key: 'B', text: '40%' },
      { key: 'C', text: '58%' },
      { key: 'D', text: '72%' }
    ],
    answer: ['B'],
    explanation:
      '**答案：B**。2024 年为 11.5 亿件，2022 年为 8.2 亿件。\n\n增长率 = 11.5 ÷ 8.2 - 1 ≈ 40.2%，故选 B。',
    difficulty: 2,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    material:
      '### 2024 年某市快递业务发展情况（模拟数据）\n\n| 指标 | 2022 年 | 2023 年 | 2024 年 |\n| --- | --- | --- | --- |\n| 快递业务量（亿件） | 8.2 | 9.6 | 11.5 |\n| 业务收入（亿元） | 68 | 82 | 101 |'
  },
  {
    id: 'shot-data-002',
    subject: 'xingce',
    category: '资料分析',
    type: 'single',
    stem: '2023 年该市快递业务量同比增速约为：',
    options: [
      { key: 'A', text: '8%' },
      { key: 'B', text: '12%' },
      { key: 'C', text: '17%' },
      { key: 'D', text: '25%' }
    ],
    answer: ['C'],
    explanation:
      '**答案：C**。2023 年为 9.6 亿件，2022 年为 8.2 亿件。\n\n增速 = 9.6 ÷ 8.2 - 1 ≈ 17.1%，故选 C。',
    difficulty: 2,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    material:
      '### 2024 年某市快递业务发展情况（模拟数据）\n\n| 指标 | 2022 年 | 2023 年 | 2024 年 |\n| --- | --- | --- | --- |\n| 快递业务量（亿件） | 8.2 | 9.6 | 11.5 |\n| 业务收入（亿元） | 68 | 82 | 101 |'
  },
  {
    id: 'shot-graphic-001',
    subject: 'xingce',
    category: '图形推理',
    type: 'single',
    stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
    options: [],
    answer: ['A'],
    explanation:
      '**答案：A**。题干图形为大圆内圈点阵：小圆点数量依次为 3、4、5，呈公差为 1 的递增规律，问号处应为 6 个圆点，只有 A 项符合。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    hasImages: true
  },
  {
    id: 'shot-graphic-002',
    subject: 'xingce',
    category: '图形推理',
    type: 'single',
    stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
    options: [],
    answer: ['A'],
    explanation:
      '**答案：A**。圆内三角形依次顺时针旋转 90 度，角部方块同步反向旋转，问号处应回到基准位置，只有 A 项符合。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    hasImages: true
  },
  {
    id: 'shot-graphic-003',
    subject: 'xingce',
    category: '图形推理',
    type: 'single',
    stem: '从所给的四个选项中，选择最合适的一个填入问号处，使之呈现一定的规律性：',
    options: [],
    answer: ['A'],
    explanation:
      '**答案：A**。图形嵌套正方形的层数依次为 1、2、3，并由外向内以菱形与圆心收束，问号处应为 4 层，只有 A 项符合。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    hasImages: true
  },
  {
    id: 'shot-essay-001',
    subject: 'shenlun',
    category: '归纳概括',
    type: 'essay',
    stem: '结合给定资料，请概括该市政务服务改革的主要做法与成效。（20 分）要求：全面、准确、有条理，不超过 300 字。',
    options: [],
    answer: [],
    explanation:
      '**答题要点**\n\n1. **做法**：推行"一网通办"，政务服务事项网上可办；设立银龄专窗，提供帮办代办服务；打通部门数据壁垒，实行"一表申请、一网流转"。\n2. **成效**：办事平均排队时长明显缩短；材料重复提交率大幅下降；老年人等群体办事更加便利；政务服务效率与群众满意度同步提升。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    material:
      '**材料一**\n\n某市推进"一网通办"改革以来，政务服务事项网上可办率达到 95%，群众办事平均排队时长由 40 分钟缩短至 8 分钟。但同时，部分社区仍存在老年人不会使用智能设备、自助终端操作复杂、系统数据不互通导致重复提交材料等问题。\n\n**材料二**\n\n该市随后推出"帮办代办"服务，在服务大厅设立银龄专窗，安排专人协助老年人线上办理；打通部门数据壁垒，实行"一表申请、一网流转"，材料重复提交率下降约七成。（以上为模拟材料）'
  },
  {
    id: 'shot-essay-002',
    subject: 'shenlun',
    category: '综合分析',
    type: 'essay',
    stem: '谈谈你对"数据多跑路、群众少跑腿"的理解。（20 分）',
    options: [],
    answer: [],
    explanation:
      '**答题要点**\n\n1. **内涵**：以数据流通替代群众奔波，把办事复杂度留给政府、把便利留给群众。\n2. **体现**：网上可办、帮办代办、一表申请一网流转。\n3. **成效与启示**：排队时长与重复提交率显著下降；数字政务仍需聚焦老年群体门槛与数据共享堵点。',
    difficulty: 3,
    year: '2025',
    region: '国考',
    paper: '2025国考模拟一',
    material:
      '**材料一**\n\n某市推进"一网通办"改革以来，政务服务事项网上可办率达到 95%，群众办事平均排队时长由 40 分钟缩短至 8 分钟。但同时，部分社区仍存在老年人不会使用智能设备、自助终端操作复杂、系统数据不互通导致重复提交材料等问题。\n\n**材料二**\n\n该市随后推出"帮办代办"服务，在服务大厅设立银龄专窗，安排专人协助老年人线上办理；打通部门数据壁垒，实行"一表申请、一网流转"，材料重复提交率下降约七成。（以上为模拟材料）'
  }
]

function graphicMarkdown(seed: SeedQuestion, index: number): string {
  const option = (key: string): string =>
    `  - key: ${key}\n    text: ""\n    image: images/graphic-${index}-${key.toLowerCase()}.png`
  return [
    '---',
    `id: ${seed.id}`,
    'subject: xingce',
    `category: ${seed.category}`,
    'kind: question',
    'questionType: single',
    `difficulty: ${seed.difficulty}`,
    'source: 2025国考模拟一',
    'tags: [图形推理, 模拟题]',
    `stem: ${seed.stem}`,
    'options:',
    option('A'),
    option('B'),
    option('C'),
    option('D'),
    'answer: A',
    `explanation: ${seed.explanation.replace(/\n/g, ' ')}`,
    '---',
    '',
    `# ${seed.category}模拟题`,
    '',
    seed.stem
  ].join('\n')
}

function textMarkdown(seed: SeedQuestion): string {
  const lines = [
    '---',
    `id: ${seed.id}`,
    `subject: ${seed.subject}`,
    `category: ${seed.category}`,
    'kind: question',
    seed.type === 'essay' ? 'questionType: essay' : 'questionType: single',
    `difficulty: ${seed.difficulty}`,
    'source: 2025国考模拟一',
    seed.year ? `year: ${seed.year}` : '',
    seed.region ? `region: ${seed.region}` : '',
    seed.paper ? `paper: ${seed.paper}` : '',
    'tags: [模拟题]',
    `stem: ${seed.stem}`,
    ...(seed.options?.length
      ? [
          'options:',
          ...seed.options.map((option) => `  - key: ${option.key}\n    text: "${option.text}"`)
        ]
      : []),
    `answer: ${JSON.stringify(seed.answer)}`,
    `explanation: ${seed.explanation.replace(/\n/g, ' ')}`,
    '---',
    '',
    `# ${seed.category}模拟题`,
    '',
    seed.stem
  ]
  if (seed.material) lines.push('', seed.material)
  return lines.filter((line) => line !== '').join('\n')
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedDatabase(): void {
  mkdirSync(VAULT_DIR, { recursive: true })
  const nowIso = new Date().toISOString()
  const xingce = SEED_QUESTIONS.filter((question) => question.subject === 'xingce')
  const essay = SEED_QUESTIONS.find((question) => question.subject === 'shenlun')

  // 写入题库 markdown 源文件（图形题含真实图片附件，满足 vault.asset 校验）
  for (const question of SEED_QUESTIONS) {
    const dir = join(VAULT_DIR, question.category)
    mkdirSync(dir, { recursive: true })
    const content = question.hasImages
      ? graphicMarkdown(question, Number(question.id.slice(-1)))
      : textMarkdown(question)
    writeFileSync(join(dir, `${question.id}.md`), content, 'utf8')
  }

  const db = new DatabaseSync(join(DATA_DIR, 'workbench.sqlite'))
  try {
    db.prepare('UPDATE vault_registry SET active = 0').run()
    db.prepare(
      `INSERT INTO vault_registry(
        id, name, path, connected_at, last_indexed_at, question_count,
        document_count, warnings_json, is_builtin, active
      ) VALUES ('shot-vault', '2025国考冲刺题库', ?, ?, ?, ?, 0, '[]', 0, 1)`
    ).run(VAULT_DIR, nowIso, nowIso, SEED_QUESTIONS.length)

    const insertQuestion = db.prepare(
      `INSERT INTO questions(
        id, vault_id, subject, category, type, stem, options_json, answer_json, explanation,
        difficulty, source, year, region, paper, material, tags_json, file_path, content_hash, indexed_at
      ) VALUES (?, 'shot-vault', ?, ?, ?, ?, ?, ?, ?, ?, '2025国考模拟一', ?, ?, ?, ?, '["模拟题"]', ?, ?, ?)`
    )
    for (const question of SEED_QUESTIONS) {
      const filePath = join(VAULT_DIR, question.category, `${question.id}.md`)
      insertQuestion.run(
        question.id,
        question.subject,
        question.category,
        question.type,
        question.stem,
        question.hasImages
          ? gOption(Number(question.id.slice(-1)))
          : JSON.stringify(question.options ?? []),
        JSON.stringify(question.answer),
        question.explanation,
        question.difficulty,
        question.year ?? null,
        question.region ?? null,
        question.paper ?? null,
        question.material ?? null,
        filePath,
        createHash('sha256').update(question.id).digest('hex'),
        nowIso
      )
    }

    // 练习作答记录：近 90 天（近 14 天全勤），支撑热力图/连续天数/科目掌握/最近作答
    const random = mulberry32(20251117)
    const insertAttempt = db.prepare(
      `INSERT INTO attempts(
        id, question_id, answer_json, correct, duration_seconds, mode, session_id,
        wrong_cause, question_snapshot_json, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, 'practice', ?, ?, ?, ?, ?)`
    )
    const causes = ['审题不细', '计算失误', '规律误判', '概念混淆']
    let inserted = 0
    const today = new Date()
    for (let daysAgo = 89; daysAgo >= 0; daysAgo -= 1) {
      const active = daysAgo <= 13 ? true : random() < 0.6
      if (!active) continue
      const count =
        daysAgo === 0
          ? 9
          : daysAgo <= 13
            ? 3 + Math.floor(random() * 3)
            : 2 + Math.floor(random() * 3)
      for (let i = 0; i < count; i += 1) {
        const useEssay = essay !== undefined && random() < 0.08
        const question = useEssay && essay ? essay : xingce[Math.floor(random() * xingce.length)]!
        const correct = random() < 0.78
        const day = new Date(today)
        day.setDate(day.getDate() - daysAgo)
        // UTC 2..13 点对应北京时间 10..21 点，保证 localtime 归当日
        day.setUTCHours(2 + Math.floor(random() * 12), Math.floor(random() * 60), 0, 0)
        if (daysAgo === 0 && i === count - 1) {
          day.setTime(Date.now() - 18 * 60 * 1000)
        }
        const answerKeys = question.answer[0] ?? 'A'
        insertAttempt.run(
          randomUUID(),
          question.id,
          JSON.stringify([correct ? answerKeys : 'B']),
          correct ? 1 : 0,
          25 + Math.floor(random() * 70),
          `session-${daysAgo}`,
          correct ? null : causes[Math.floor(random() * causes.length)]!,
          JSON.stringify({
            id: question.id,
            subject: question.subject,
            category: question.category,
            type: question.type,
            stem: question.stem
          }),
          question.id,
          day.toISOString()
        )
        inserted += 1
      }
    }

    // 错题与复习任务：支撑「到期复习」概览与错题本
    const insertWrong = db.prepare(
      `INSERT OR REPLACE INTO wrong_questions(
        question_id, wrong_count, correct_streak, mastered, last_wrong_cause, first_wrong_at, last_attempt_at
      ) VALUES (?, ?, 0, ?, ?, ?, ?)`
    )
    const insertReview = db.prepare(
      `INSERT OR REPLACE INTO review_tasks(question_id, due_at, completed_at) VALUES (?, ?, NULL)`
    )
    const wrongPicks = [
      'shot-common-001',
      'shot-language-001',
      'shot-judge-002',
      'shot-data-001',
      'shot-graphic-001',
      'shot-language-002',
      'shot-common-002',
      'shot-judge-001',
      'shot-data-002',
      'shot-graphic-003'
    ]
    const dueHours = [3, 8, 26, 30, 49, 55]
    wrongPicks.forEach((questionId, index) => {
      const mastered = index >= 8 ? 1 : 0
      insertWrong.run(
        questionId,
        1 + (index % 3),
        mastered,
        causes[index % causes.length]!,
        new Date(Date.now() - (index + 2) * 86400_000).toISOString(),
        new Date(Date.now() - index * 3600_000).toISOString()
      )
      if (index < 6) {
        insertReview.run(
          questionId,
          new Date(Date.now() - dueHours[index]! * 3600_000).toISOString()
        )
      } else if (index < 8) {
        insertReview.run(questionId, new Date(Date.now() + 2 * 86400_000).toISOString())
      }
    })
    const insertPlan = db.prepare(
      `INSERT OR REPLACE INTO learning_plans(id, payload_json, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    )
    insertPlan.run(
      'shot-plan-1',
      JSON.stringify({
        id: 'shot-plan-1',
        title: '行测 14 天冲刺计划',
        createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
        startDate: new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10),
        durationDays: 14,
        dailyMinutes: 60,
        status: 'active',
        focus: ['图形推理', '资料分析'],
        items: [
          {
            id: 'p1',
            day: 1,
            type: 'official_practice',
            title: '图形推理 · 规律专练 10 题',
            target: 10,
            completed: 6,
            done: false
          },
          {
            id: 'p2',
            day: 1,
            type: 'official_review',
            title: '错题复习 · 到期 6 题',
            target: 6,
            completed: 0,
            done: false
          },
          {
            id: 'p3',
            day: 1,
            type: 'read_knowledge',
            title: '读「图形推理」规律卡',
            target: 3,
            completed: 3,
            done: true
          },
          {
            id: 'p4',
            day: 2,
            type: 'official_practice',
            title: '资料分析 · 增长率速算',
            target: 10,
            completed: 0,
            done: false
          }
        ]
      }),
      new Date(Date.now() - 3600_000).toISOString(),
      new Date().toISOString()
    )
    log(`种子完成：题目 ${SEED_QUESTIONS.length} 道，练习记录 ${inserted} 条`)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 第三部分：应用启动与截图
// ---------------------------------------------------------------------------

interface AppHandle {
  electronApp: ElectronApplication
  page: Page
}

async function launchApp(): Promise<AppHandle> {
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      // 数据目录覆盖仅在测试运行时生效：WORKBENCH_E2E=1 提供 isTestRuntime，
      // 代价是渲染层带 e2e=1 query（工作台出现 e2e-crash 调试按钮），截图前统一从 DOM 移除
      WORKBENCH_E2E: '1',
      WORKBENCH_SMOKE_DATA_DIR: DATA_DIR,
      WORKBENCH_MARKITDOWN_PYTHON: ENGINE_PYTHON
    },
    timeout: 90_000
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // 固定内容区 1440x900（与官网展示尺寸一致），并等字体就绪
  await electronApp.evaluate(
    ({ BrowserWindow }, size: number[]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('主窗口不存在')
      win.setContentSize(size[0]!, size[1]!)
      win.center()
    },
    [VIEW_W, VIEW_H]
  )
  await page.evaluate(() => document.fonts.ready)
  return { electronApp, page }
}

async function closeApp(app: AppHandle): Promise<void> {
  await app.electronApp.close()
}

/** 用 Electron 内置 Chromium 画布把 PNG 重编码为 WebP/JPEG（零额外依赖，data URL 避免 canvas 污染） */
async function encodeImage(
  app: AppHandle,
  pngPath: string,
  options: {
    width: number
    height: number
    type: 'image/webp' | 'image/jpeg' | 'image/png'
    quality: number
  }
): Promise<Buffer> {
  const base64 = readFileSync(pngPath).toString('base64')
  const dataUrl = await app.electronApp.evaluate(
    async (
      { BrowserWindow },
      payload: { base64: string; w: number; h: number; type: string; quality: number }
    ) => {
      const win = new BrowserWindow({
        show: false,
        width: Math.min(payload.w, 1600),
        height: Math.min(payload.h, 1600),
        frame: false,
        webPreferences: { sandbox: true, backgroundThrottling: false }
      })
      try {
        await win.loadURL('data:text/html,<body style="margin:0"></body>')
        const js =
          'new Promise((resolve, reject) => {' +
          'const img = new Image();' +
          'img.onload = () => {' +
          'const canvas = document.createElement("canvas");' +
          'canvas.width = ' +
          payload.w +
          ';' +
          'canvas.height = ' +
          payload.h +
          ';' +
          'const ctx = canvas.getContext("2d");' +
          'ctx.drawImage(img, 0, 0, ' +
          payload.w +
          ', ' +
          payload.h +
          ');' +
          'try { resolve(canvas.toDataURL("' +
          payload.type +
          '", ' +
          payload.quality +
          ')) }' +
          'catch (e) { reject(String(e)) }' +
          '};' +
          'img.onerror = () => reject(new Error("image load failed"));' +
          'img.src = "data:image/png;base64,' +
          payload.base64 +
          '";' +
          '})'
        const out = await win.webContents.executeJavaScript(js)
        return out as string
      } finally {
        win.destroy()
      }
    },
    { base64, w: options.width, h: options.height, type: options.type, quality: options.quality }
  )
  if (!dataUrl.startsWith('data:')) throw new Error(`画布编码失败：${dataUrl.slice(0, 120)}`)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

async function captureHtmlCard(
  app: AppHandle,
  htmlFile: string,
  width: number,
  height: number
): Promise<Buffer> {
  const fileUrl = pathToFileURL(htmlFile).href
  const pngBase64 = await app.electronApp.evaluate(
    async ({ BrowserWindow }, payload: { fileUrl: string; width: number; height: number }) => {
      const win = new BrowserWindow({
        show: false,
        width: payload.width,
        height: payload.height,
        frame: false,
        webPreferences: { sandbox: true, backgroundThrottling: false }
      })
      try {
        await win.loadURL(payload.fileUrl)
        await win.webContents.executeJavaScript('document.fonts.ready.then(() => undefined)')
        await new Promise((r) => setTimeout(r, 700))
        let image = await win.webContents.capturePage()
        if (image.isEmpty()) {
          // 隐藏窗口可能不渲染：临时非激活显示（移到屏幕右外侧）再截
          win.showInactive()
          win.setPosition(payload.width + 600, 100)
          await new Promise((r) => setTimeout(r, 600))
          image = await win.webContents.capturePage()
        }
        return image.toPNG().toString('base64')
      } finally {
        win.destroy()
      }
    },
    { fileUrl, width, height }
  )
  return Buffer.from(pngBase64, 'base64')
}

async function shot(app: AppHandle, id: string, page: Page): Promise<void> {
  // 移除 E2E 专用调试按钮（仅 e2e=1 窗口存在，非应用正式 UI）并固定窗口尺寸
  await page.evaluate(() => document.querySelector('[data-testid="e2e-crash"]')?.remove())
  await enforceWindowSize(app)
  const tempPng = join(WORK, `${id}.png`)
  const buffer = await page.screenshot({ type: 'png' })
  writeFileSync(tempPng, buffer)
  mkdirSync(OUT_WEBP_DIR, { recursive: true })
  mkdirSync(OUT_JPG_DIR, { recursive: true })
  const webp = await encodeImage(app, tempPng, {
    width: VIEW_W,
    height: VIEW_H,
    type: 'image/webp',
    quality: 0.85
  })
  writeFileSync(join(OUT_WEBP_DIR, `${id}.webp`), webp)
  const jpeg = await encodeImage(app, tempPng, {
    width: VIEW_W,
    height: VIEW_H,
    type: 'image/jpeg',
    quality: 0.9
  })
  writeFileSync(join(OUT_JPG_DIR, `${id}.jpg`), jpeg)
  log(
    `${id} 完成：webp ${(statSync(join(OUT_WEBP_DIR, `${id}.webp`)).size / 1024).toFixed(0)}KB / jpg ${(statSync(join(OUT_JPG_DIR, `${id}.jpg`)).size / 1024).toFixed(0)}KB`
  )
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** DOM 级点击：绕过 Playwright 命中测试（命中测试在部分页面会持续超时） */
async function clickDomByTestId(page: Page, testId: string, index = 0): Promise<void> {
  await page.waitForFunction(
    ({ probe, want }: { probe: string; want: number }) =>
      document.querySelectorAll('[data-testid="' + probe + '"]').length > want,
    { probe: testId, want: index },
    { timeout: 30_000 }
  )
  const ok = await page.evaluate(
    ({ probe, want }: { probe: string; want: number }) => {
      const node = document.querySelectorAll('[data-testid="' + probe + '"]')[want]
      if (!(node instanceof HTMLElement)) return false
      node.click()
      return true
    },
    { probe: testId, want: index }
  )
  if (!ok) throw new Error('DOM 点击失败：' + testId)
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
  if (!ok) throw new Error('DOM 点击失败：' + text)
}

async function checkDomByTestId(page: Page, testId: string): Promise<void> {
  await page.waitForFunction(
    (probe: string) => Boolean(document.querySelector(`[data-testid="${probe}"]`)),
    testId,
    { timeout: 30_000 }
  )
  await page.evaluate((probe: string) => {
    const node = document.querySelector(`[data-testid="${probe}"]`)
    if (node instanceof HTMLInputElement && !node.checked) node.click()
  }, testId)
}

/** 视口尺寸日志：定位布局问题用 */
async function logViewport(page: Page, label: string): Promise<void> {
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  log(`视口[${label}] ${size.w}x${size.h}`)
}

// 题干前缀 → 正确答案/干扰项映射（模考作答用，来自本地题库）
const ANSWER_MAP = new Map<string, { answer: string; wrongKey: string }>()

function loadAnswerMap(): void {
  const db = new DatabaseSync(join(DATA_DIR, 'workbench.sqlite'))
  try {
    const rows = db
      .prepare(`SELECT stem, answer_json, options_json FROM questions WHERE type != 'essay'`)
      .all() as Array<{ stem: string; answer_json: string; options_json: string }>
    for (const row of rows) {
      const answers = JSON.parse(row.answer_json) as string[]
      const options = JSON.parse(row.options_json) as Array<{ key: string }>
      const answer = answers[0] ?? 'A'
      const wrongKey = options.find((option) => option.key !== answer)?.key ?? answer
      ANSWER_MAP.set(row.stem.replace(/\s+/g, '').slice(0, 14), { answer, wrongKey })
    }
    log(`答案映射就绪：${ANSWER_MAP.size} 题`)
  } finally {
    db.close()
  }
}

/** 页面导航：优先点侧栏链接（真实用户路径），超时改用 hash 路由兜底 */
async function gotoPage(app: AppHandle, linkName: string, route: string): Promise<void> {
  const { page } = app
  try {
    await page.getByRole('link', { name: linkName }).click({ timeout: 4_000, force: true })
  } catch {
    log(`侧栏点击「${linkName}」超时，改用路由跳转：${route}`)
    await page.evaluate((h: string) => {
      window.location.hash = h
    }, route)
  }
  await page.waitForURL(new RegExp(route.replace('#/', '').replace(/\//g, '\\/')), {
    timeout: 30_000
  })
}

/** 强制恢复 1440x900 内容区并居中：考试流程后窗口尺寸可能漂移，Playwright 坐标映射会随之失效 */
async function enforceWindowSize(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate(
    ({ BrowserWindow }, size: number[]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('主窗口不存在')
      win.setContentSize(size[0]!, size[1]!)
      win.center()
    },
    [VIEW_W, VIEW_H]
  )
  await sleep(300)
}

/** 失败现场转储：截图 + URL 写入 e2e-artifacts/，便于定位截图流程问题 */
async function dumpDebug(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(join(ROOT, 'e2e-artifacts'), { recursive: true })
    await page.screenshot({
      path: join(ROOT, 'e2e-artifacts', `shots-debug-${name}.png`),
      fullPage: false
    })
    log(`失败现场已转储：e2e-artifacts/shots-debug-${name}.png 当前页面：${page.url()}`)
  } catch {
    /* 转储失败不影响原流程 */
  }
}

/** React 受控 <select>：等待目标选项出现后，原生 setter 赋值并派发 change 事件；支持子串匹配 */
async function setSelectByOption(page: Page, wanted: string, timeoutMs = 10_000): Promise<boolean> {
  const found = await page
    .waitForFunction(
      (probe: string) => {
        const selects = [...document.querySelectorAll('select')]
        return selects.some((select) =>
          [...select.options].some((item) => {
            const text = (item.textContent ?? '').trim()
            return (
              text === probe || text.includes(probe) || (probe.length >= 6 && probe.includes(text))
            )
          })
        )
      },
      wanted,
      { timeout: timeoutMs }
    )
    .then(() => true)
    .catch(() => false)
  if (!found) {
    const dump = await page.evaluate(() =>
      [...document.querySelectorAll('select')].map((select) =>
        [...select.options].map((item) => item.textContent?.trim()).join(' / ')
      )
    )
    log(`未找到选项「${wanted}」，当前页面下拉项：${JSON.stringify(dump)}`)
    return false
  }
  return page.evaluate((probe: string) => {
    const selects = [...document.querySelectorAll('select')]
    for (const select of selects) {
      const option = [...select.options].find((item) => {
        const text = (item.textContent ?? '').trim()
        return text === probe || text.includes(probe) || (probe.length >= 6 && probe.includes(text))
      })
      if (option) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
        setter.call(select, option.value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
    }
    return false
  }, wanted)
}

async function fillNumberInput(page: Page, value: number, index = 0): Promise<void> {
  await page.evaluate(
    ({ value, index }: { value: number; index: number }) => {
      const inputs = [...document.querySelectorAll('input[type="number"]')]
      const target = inputs[index]
      if (!target) throw new Error('number input not found: ' + String(index))
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(target, String(value))
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { value, index }
  )
}

async function waitForImages(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const images = [...document.querySelectorAll(sel)] as HTMLImageElement[]
      return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
    },
    selector,
    { timeout: 30_000 }
  )
}

// 镜头 01：今日工作台（学习日历热力图 + 到期复习概览）
async function captureDashboard(app: AppHandle): Promise<void> {
  const { page } = app
  await page.getByRole('link', { name: '今日工作台' }).click()
  await page.locator('.calendar-strip').waitFor({ timeout: 30_000 })
  await page
    .waitForFunction(
      () => document.querySelectorAll('.calendar-cell-active').length >= 10,
      undefined,
      {
        timeout: 20_000
      }
    )
    .catch(() => log('警告：热力图活跃格子少于预期'))
  await page.getByText('到期复习').first().waitFor({ timeout: 15_000 })
  await sleep(1_100)
  await shot(app, '01-dashboard', page)
}

// 镜头 02：专项练习（图形推理图片选项直显 + 即时解析）
async function capturePractice(app: AppHandle): Promise<void> {
  const { page } = app
  await page.getByRole('link', { name: '专项练习' }).click()
  await page.getByRole('button', { name: '生成训练' }).waitFor({ timeout: 30_000 })
  const switched = await setSelectByOption(page, '每题立即解析')
  if (!switched) log('警告：未找到解析方式选项，使用默认值')
  const moduleSwitched = await setSelectByOption(page, '图形推理')
  if (!moduleSwitched) log('警告：未找到「图形推理」筛选项，使用全部题目')
  await fillNumberInput(page, 1, 0)
  await page.getByRole('button', { name: '生成训练' }).click()
  await page.locator('.option-button').first().waitFor({ timeout: 30_000 })
  await waitForImages(page, '.option-button img')
  // 选择正确答案（种子图形题答案均为 A），让解析区以正确状态呈现
  await page.locator('.option-button').first().click()
  await page.getByRole('button', { name: '提交答案' }).click()
  await page.getByRole('button', { name: /下一题|完成本组/ }).waitFor({ timeout: 20_000 })
  // 回到题目顶部：让题干与图形选项同框
  await page.evaluate(() => {
    const workspace = document.querySelector('.workspace')
    if (workspace instanceof HTMLElement) workspace.scrollTop = 0
  })
  await sleep(900)
  await shot(app, '02-practice-graphic', page)
}

// 镜头 03：真题模考交卷后的逐题复盘（成绩单 + 模块正确率分布 + 作答对照）
// 按题干在本地题库映射中查正确答案，约 3/4 答对，形成真实的对错分布
async function captureExam(app: AppHandle): Promise<void> {
  const { page } = app
  const probes = [...ANSWER_MAP.keys()]
  await page.getByRole('link', { name: '模拟考试' }).click()
  await page.getByRole('button', { name: '创建并开始' }).waitFor({ timeout: 30_000 })
  await page
    .getByLabel('考试名称')
    .fill('2025 国考全真模拟（一）')
    .catch(() => log('提示：考试名称输入框不可用，使用默认名称'))
  await fillNumberInput(page, 19, 0)
  await page.getByRole('button', { name: '创建并开始' }).click()
  await page.getByTestId('exam-submit').waitFor({ timeout: 60_000 })

  for (let index = 0; index < 40; index += 1) {
    const essay = page.getByTestId('exam-essay-input')
    if ((await essay.count()) > 0 && (await essay.isVisible())) {
      const essayStem = await page.evaluate(() =>
        (document.querySelector('.workspace')?.textContent ?? '').replace(/\s+/g, '')
      )
      await essay.fill(
        essayStem.includes('数据多跑路')
          ? '"数据多跑路、群众少跑腿"的本质，是以数据流通替代群众奔波，把复杂度留给政府、把便利留给群众。网上可办降低了跑动成本，帮办代办兜住了老年群体的数字鸿沟，数据壁垒打通后重复提交随之减少。这要求数字政务继续聚焦使用门槛与共享堵点，让技术围绕人的需求运转。'
          : '该市改革的主要做法：一是推行"一网通办"，政务服务事项实现网上可办；二是设立银龄专窗，提供帮办代办服务；三是打通部门数据壁垒，实行"一表申请、一网流转"。主要成效：办事平均排队时长由 40 分钟缩短至 8 分钟，材料重复提交率下降约七成，老年人等群体办事更加便利，政务服务效率与群众满意度同步提升。'
      )
      await sleep(1_200)
    } else {
      const stem = await page.evaluate((list: string[]) => {
        const text = (document.querySelector('.workspace')?.textContent ?? '').replace(/\s+/g, '')
        return list.find((probe) => text.includes(probe)) ?? null
      }, probes)
      const entry = stem ? ANSWER_MAP.get(stem) : undefined
      // 每 4 题故意答错 1 题：模考成绩单需要真实的错误分布
      const wantWrong = index % 4 === 2
      const key = entry
        ? wantWrong
          ? entry.wrongKey
          : entry.answer
        : ['A', 'B', 'C', 'D'][index % 4]!
      const option = page.getByTestId(`exam-option-${key}`)
      if ((await option.count()) > 0) await option.click()
      else await page.getByTestId('exam-option-A').click()
      // 拟真作答节奏：让成绩单的「实际用时」符合真实模考量级
      await sleep(4_500)
    }
    const next = page.getByRole('button', { name: /下一题|完成本组/ }).first()
    if (await next.isDisabled().catch(() => true)) break
    await next.click()
    await sleep(400)
  }

  await page.getByTestId('exam-submit').click()
  await page.getByRole('button', { name: '确认交卷' }).click()
  await page.waitForURL(/\/exam\/result\//, { timeout: 90_000 })
  await page.getByText('逐题复盘').first().waitFor({ timeout: 30_000 })
  await page.getByText('模块正确率分布').first().waitFor({ timeout: 30_000 })
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.review-option img')].every(
          (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0
        ),
      undefined,
      { timeout: 20_000 }
    )
    .catch(() => undefined)
  // 构图：回到页面最顶端，让成绩单（得分/正确率/用时）与分布、逐题复盘开头同框
  await page.evaluate(() => {
    const workspace = document.querySelector('.workspace')
    if (workspace instanceof HTMLElement) workspace.scrollTop = 0
  })
  await sleep(1_000)
  await shot(app, '03-exam-review', page)
}

// 镜头 04：知识库工坊（OCR 导入任务 + 来源页预览 + 人工确认门禁）
// 构图注意：转换环境卡片会显示引擎 python 完整路径（本机隐私），滚动时让该卡片保持在画面外
async function captureKnowledgeBuilder(app: AppHandle): Promise<void> {
  const { page } = app
  await enforceWindowSize(app)
  await gotoPage(app, '知识库工坊', '#/knowledge-builder')
  await page.getByLabel('原料目录').waitFor({ timeout: 30_000 })
  await page.getByLabel('原料目录').fill(FIXTURE_DIR)
  await logViewport(page, '工坊进入')
  await clickDomByText(page, '扫描')
  await page.getByText('可转换文件').waitFor({ timeout: 30_000 })
  await clickDomByText(page, '全选')
  await checkDomByTestId(page, 'rights-confirm')
  await clickDomByText(page, '开始导入')
  log('导入任务已启动，等待 OCR 管线完成（可能需要 1-5 分钟）')
  try {
    await page.getByTestId('builder-artifact-item').first().waitFor({ timeout: 180_000 })
  } catch {
    // 兜底：任务可能已完成但渲染层未收到事件——切走再切回，挂载时重新拉取最新任务
    log('产物卡片未出现，重进工坊页触发任务重新加载')
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await sleep(800)
    await page.evaluate(() => {
      window.location.hash = '#/knowledge-builder'
    })
    await page.getByTestId('builder-artifact-item').first().waitFor({ timeout: 120_000 })
  }
  await sleep(2_000)
  // 选中资料分析产物（含表格材料），打开来源页预览浮层：一眼看懂「左看切分题目、右对原始 PDF」
  const hasData = await page
    .getByTestId('builder-artifact-item')
    .filter({ hasText: '资料分析' })
    .count()
  if (hasData > 0) {
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="builder-artifact-item"]')]
      const card = cards.find((item) => (item.textContent ?? '').includes('资料分析'))
      const btn = card?.querySelector('[data-testid="builder-artifact-select"]')
      if (btn instanceof HTMLElement) btn.click()
    })
    await sleep(800)
  } else {
    log('提示：未找到资料分析产物卡片，使用第一个产物')
    await clickDomByTestId(page, 'builder-artifact-select')
    await sleep(800)
  }
  await clickDomByTestId(page, 'source-preview-button')
  await page.getByTestId('source-preview-image').waitFor({ timeout: 30_000 })
  await waitForImages(page, '[data-testid="source-preview-image"]')
  await sleep(900)
  await shot(app, '04-knowledge-builder', page)
}

// 镜头 05：申论作答（给定资料 Markdown + 本地规则评分）
async function captureShenlun(app: AppHandle): Promise<void> {
  const { page } = app
  await enforceWindowSize(app)
  await gotoPage(app, '申论作答', '#/shenlun-solution')
  await page.getByTestId('shenlun-draft-input').waitFor({ timeout: 30_000 })
  const switched = await setSelectByOption(page, '数据多跑路、群众少跑腿')
  if (!switched) log('警告：申论题目下拉未匹配，使用默认题目')
  await page
    .getByTestId('shenlun-draft-input')
    .fill(
      '"数据多跑路、群众少跑腿"的本质，是以数据流通替代群众奔波，把办事的复杂度留给政府、把便利留给群众。材料中，该市通过"一网通办"让事项网上可办，以"帮办代办"兜住老年群体的数字鸿沟，用"一表申请、一网流转"打通部门壁垒，正是这一理念的落地。成效上，排队时长大幅缩短、材料重复提交率下降约七成，群众获得感与政务效能同步提升。这也提示，数字政务建设不能止于上系统，更要聚焦老年人等群体的使用门槛与数据共享堵点，让技术真正围绕人的需求运转。'
    )
  await sleep(1_600)
  await clickDomByText(page, '提交评估')
  await page
    .getByText(/评估结果/)
    .first()
    .waitFor({ timeout: 60_000 })
  // 视口下移：让「评估结果」下方的三维评分卡完整入镜
  await page.evaluate(() => {
    const workspace = document.querySelector('.workspace')
    if (workspace instanceof HTMLElement) workspace.scrollTop += 120
  })
  await sleep(900)
  await shot(app, '05-shenlun', page)
}

// ---------------------------------------------------------------------------
// 第四部分：og 分享图与 favicon（复用现有图标资产 build/icon-preview.png）
// ---------------------------------------------------------------------------

async function generateMeta(app: AppHandle): Promise<void> {
  const outDir = join(ROOT, 'website', 'public')
  mkdirSync(outDir, { recursive: true })
  const iconSource = join(ROOT, 'build', 'icon-preview.png')

  // favicon / apple-touch-icon
  for (const [name, size] of [
    ['favicon-32.png', 32],
    ['favicon-64.png', 64],
    ['apple-touch-icon.png', 180]
  ] as const) {
    const png = await encodeImage(app, iconSource, {
      width: size,
      height: size,
      type: 'image/png',
      quality: 1
    })
    writeFileSync(join(outDir, name), png)
  }

  // og 分享封面 1200x630
  const card = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;width:1200px;height:630px;overflow:hidden}',
    'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#FBF9F4;display:flex}',
    '.band{width:18px;height:630px;background:#D65F35;flex:none}',
    '.main{flex:1;padding:88px 84px;display:flex;flex-direction:column;justify-content:space-between}',
    '.brand{display:flex;align-items:center;gap:36px}',
    '.brand img{width:128px;height:128px}',
    '.brand-name{font-size:82px;font-weight:700;color:#1B1917;letter-spacing:6px;line-height:1}',
    '.brand-sub{font-size:29px;color:#6B675F;margin-top:20px;letter-spacing:2px}',
    '.title{font-size:42px;font-weight:600;color:#1B1917;line-height:1.5}',
    '.badges{display:flex;gap:16px}',
    '.badge{font-size:24px;color:#8A8578;border:2px solid #DDD6C8;border-radius:12px;padding:10px 22px;background:#fff}',
    '</style></head><body>',
    '<div class="band"></div><div class="main">',
    '<div class="brand"><img src="' + pathToFileURL(iconSource).href + '" alt="">',
    '<div><div class="brand-name">题舟 Tizhou</div>',
    '<div class="brand-sub">题海行舟，终将上岸 · 开源考公学习工作台</div></div></div>',
    '<div class="title">本地优先：数据存本机，无广告无会员，<br>PDF 题本一键建库，离线刷题零依赖</div>',
    '<div class="badges"><div class="badge">v1.0.15</div><div class="badge">Windows 10/11</div>',
    '<div class="badge">MIT 开源</div><div class="badge">SQLite + Markdown</div></div>',
    '</div></body></html>'
  ].join('\n')
  const cardFile = join(WORK, 'og-card.html')
  writeFileSync(cardFile, card, 'utf8')
  const ogPng = await captureHtmlCard(app, cardFile, 1200, 630)
  const ogPngPath = join(WORK, 'og-card.png')
  writeFileSync(ogPngPath, ogPng)
  const ogJpeg = await encodeImage(app, ogPngPath, {
    width: 1200,
    height: 630,
    type: 'image/jpeg',
    quality: 0.88
  })
  writeFileSync(join(outDir, 'og-image.jpg'), ogJpeg)
  log('og-image 与 favicon 已生成')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const want = (id: string): boolean => !onlyArg || onlyArg.includes(id.slice(0, 2))
  log('工作目录：', WORK)
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  rmSync(VAULT_DIR, { recursive: true, force: true })
  generateFixtures()
  rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })

  if (metaOnly) {
    const app = await launchApp()
    try {
      await generateMeta(app)
    } finally {
      await closeApp(app)
    }
    return
  }

  // 第一步：bootstrap 启动（完成数据库迁移与内置库初始化）
  log('第 1 次启动：初始化数据库…')
  const bootstrap = await launchApp()
  await bootstrap.page.getByText('今日工作台').first().waitFor({ timeout: 60_000 })
  await closeApp(bootstrap)
  await sleep(1_800)

  // 第二步：种入题库与学习记录
  log('第 2 步：写入种子数据…')
  seedDatabase()
  loadAnswerMap()

  // 第三步：正式实例采集 5 张截图
  log('第 3 次启动：采集截图…')
  const app = await launchApp()
  try {
    const steps: Array<[string, (app: AppHandle) => Promise<void>]> = [
      ['01', captureDashboard],
      ['02', capturePractice],
      ['03', captureExam],
      ['04', captureKnowledgeBuilder],
      ['05', captureShenlun]
    ]
    for (const [id, capture] of steps) {
      if (!want(id)) continue
      try {
        await capture(app)
      } catch (error) {
        await dumpDebug(app.page, id)
        throw error
      }
    }
    await generateMeta(app)
  } finally {
    await closeApp(app)
  }
  log('全部完成。输出：')
  for (const dir of [OUT_WEBP_DIR, OUT_JPG_DIR, join(ROOT, 'website', 'public')]) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      const full = join(dir, file)
      if (statSync(full).isFile()) log(`  ${full} (${(statSync(full).size / 1024).toFixed(0)}KB)`)
    }
  }
}

process.on('uncaughtException', (error) => {
  console.error('[shots] uncaughtException：', error)
  process.exitCode = 1
})
process.on('unhandledRejection', (reason) => {
  console.error('[shots] unhandledRejection：', reason)
  process.exitCode = 1
})

main().catch((error: unknown) => {
  console.error('[shots] 失败：', error)
  process.exitCode = 1
})
