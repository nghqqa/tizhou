// 转换引擎的 Python 运行时发现与兜底（依赖可注入，便于单测）。
// 覆盖三类真实用户场景（2026-11 用户反馈「转换环境安装不上」的根因）：
// 1. 装了 Python 但漏勾默认未选的「Add python.exe to PATH」，或开着应用装完没重启
//    （Electron 主进程 PATH 还是旧快照）：除 PATH 候选外补充扫描常见固定安装位置，
//    免重启即可发现新装的 Python；
// 2. 微软商店的 python.exe 是假快捷桩（执行只会跳商店页）：显式过滤 WindowsApps 路径；
// 3. 本机完全没有 Python：自动下载 python-build-standalone 的独立便携版 3.12 到
//    应用数据目录，SHA-256 硬校验 + 双源自动回退，不写注册表、不改系统环境。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LauncherCandidate {
  command: string
  args: string[]
}

/** 统一的子进程执行器契约：非 0 退出 / 启动失败一律 reject */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

export function parsePythonVersionOutput(
  text: string
): { major: number; minor: number } | undefined {
  const match = text.match(/Python\s+(\d+)\.(\d+)/i)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

// 转换组件（onnxruntime/rapidocr 等二进制轮子）最低要求 3.10
export function isSupportedPythonVersion(version: { major: number; minor: number }): boolean {
  return version.major === 3 && version.minor >= 10
}

// 微软商店的 python.exe 假快捷桩位于 WindowsApps 目录，执行只会弹出商店页
export function isWindowsAppsStub(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment.toLowerCase() === 'windowsapps')
}

// 固定安装目录的版本扫描顺序：3.12/3.13 二进制轮子最齐所以最优先；
// 3.14 较新、部分轮子还没跟上，排最后
const FIXED_VERSION_TAGS = ['312', '313', '311', '310', '314']
const UV_PYTHON_PREFIXES = ['3.12', '3.13', '3.11', '3.10', '3.14']

export interface PythonScanContext {
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  readdir: (path: string) => string[]
}

// 除 PATH 之外的 Windows python.exe / py.exe 固定位置候选
//（已过滤商店假桩与不存在的路径），按「全局启动器 → 版本化安装目录 → uv 管理」排序
export function windowsFixedPythonCandidates(context: PythonScanContext): LauncherCandidate[] {
  const { env, exists, readdir } = context
  const candidates: LauncherCandidate[] = []
  const pushExe = (path: string | undefined): void => {
    if (!path || !exists(path) || isWindowsAppsStub(path)) return
    if (candidates.some((candidate) => candidate.command.toLowerCase() === path.toLowerCase()))
      return
    candidates.push({ command: path, args: [] })
  }
  const localAppData = env.LOCALAPPDATA?.trim()
  const appData = env.APPDATA?.trim()
  const programFiles = env.ProgramFiles?.trim() || 'C:\\Program Files'
  const systemRoot = env.SystemRoot?.trim() || 'C:\\Windows'
  // 全局 py 启动器的两个常见落点
  pushExe(join(systemRoot, 'py.exe'))
  if (localAppData) pushExe(join(localAppData, 'Programs', 'Python', 'Launcher', 'py.exe'))
  // per-user / 全机器的版本化安装目录
  for (const tag of FIXED_VERSION_TAGS) {
    if (localAppData)
      pushExe(join(localAppData, 'Programs', 'Python', `Python${tag}`, 'python.exe'))
    pushExe(join(programFiles, `Python${tag}`, 'python.exe'))
  }
  // uv 管理的独立解释器（uv 只以 -V:Astral/... 标签注册 py 启动器，py -3 找不到）
  if (appData) {
    const uvRoot = join(appData, 'uv', 'python')
    let entries: string[] = []
    try {
      entries = readdir(uvRoot)
    } catch {
      entries = []
    }
    for (const prefix of UV_PYTHON_PREFIXES) {
      const matched = entries
        .filter((entry) => entry.toLowerCase().startsWith(`cpython-${prefix}`))
        .sort()
      for (const entry of matched) pushExe(join(uvRoot, entry, 'python.exe'))
    }
  }
  return candidates
}

// PATH 上的窄启动器候选；uv 等工具管理的 Python 只以 -V:Astral/... 标签注册，
// py -3 找不到，裸 py 会落到启动器默认环境
export function pathLauncherCandidates(platform: NodeJS.Platform): LauncherCandidate[] {
  return platform === 'win32'
    ? [
        { command: 'py', args: ['-3.12'] },
        { command: 'py', args: ['-3'] },
        { command: 'py', args: [] },
        { command: 'python', args: [] }
      ]
    : [
        { command: 'python3.12', args: [] },
        { command: 'python3', args: [] },
        { command: 'python', args: [] }
      ]
}

// 候选启动器双重校验：版本 ≥3.10，且 stdlib 的 venv 模块可导入
//（排除缺失 venv 的残缺发行版——没有 venv 就建不出独立虚拟环境）
export async function validatePythonLauncher(
  runner: CommandRunner,
  candidate: LauncherCandidate
): Promise<boolean> {
  try {
    const { stdout, stderr } = await runner(candidate.command, [...candidate.args, '--version'], {
      timeout: 10_000
    })
    const version = parsePythonVersionOutput(`${stdout}\n${stderr}`)
    if (!version || !isSupportedPythonVersion(version)) return false
    await runner(candidate.command, [...candidate.args, '-c', 'import venv'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

// 深度发现可用的 Python 启动器：PATH 候选优先（尊重用户已有配置），
// Windows 下再扫固定安装位置兜底；每个候选都要通过版本与 venv 双重校验
export async function findPythonLauncher(options: {
  runner: CommandRunner
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  readdir?: (path: string) => string[]
  extraCandidates?: LauncherCandidate[]
}): Promise<LauncherCandidate> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const scanContext: PythonScanContext = {
    env,
    exists: options.exists ?? existsSync,
    readdir: options.readdir ?? safeReadDir
  }
  const candidates = [
    ...(options.extraCandidates ?? []),
    ...pathLauncherCandidates(platform),
    ...(platform === 'win32' ? windowsFixedPythonCandidates(scanContext) : [])
  ]
  for (const candidate of candidates) {
    if (await validatePythonLauncher(options.runner, candidate)) return candidate
  }
  throw new Error('未找到可用的 Python 3.10 或更高版本（需支持 venv 模块）')
}

export interface PortableArchiveSource {
  label: string
  url: string
}

export interface PortableArchiveSpec {
  version: string
  buildTag: string
  fileName: string
  expectedBytes: number
  expectedSha256: string
  sources: PortableArchiveSource[]
}

// 独立便携版 Python 3.12（python-build-standalone install_only_stripped 构建）：
// 双源已实测可用——国内主源走 npmmirror CDN，国际备源是同构建的 GitHub Release
export const PORTABLE_PYTHON: PortableArchiveSpec = {
  version: '3.12.16',
  buildTag: '20261110',
  fileName: 'cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
  expectedBytes: 22_365_213,
  expectedSha256: '355ee61b8207b91574491b1c6dc9b0ebb4408fc56bfafe498f3ef439314b52dc',
  sources: [
    {
      label: 'npmmirror CDN',
      url: 'https://registry.npmmirror.com/-/binary/python-build-standalone/20261110/cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
    },
    {
      label: 'GitHub Release',
      url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
    }
  ]
}

// Windows 下裸调 'tar' 可能命中 PATH 里排在前面的 GNU tar（如 Git\usr\bin\tar.exe），
// 它会把 `C:\...` 里的 `C:` 当远端主机报 `Cannot connect to C: resolve failed`；
// 因此 win32 固定优先用系统自带的 System32\tar.exe，缺失才回退 PATH 裸名
export function resolveTarCommand(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return 'tar'
  const systemTar = join(env.SystemRoot?.trim() || 'C:\\Windows', 'System32', 'tar.exe')
  return exists(systemTar) ? systemTar : 'tar'
}

// 下载进度映射：独立运行时下载占安装总进度 1% → 12%，pip 各阶段在其后顺延
export const PORTABLE_DOWNLOAD_PHASE = '下载独立 Python 3.12 运行时（约 21 MB）'

export function portableDownloadPercent(downloaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 12
  return Math.max(1, Math.min(12, 1 + Math.round((11 * downloaded) / total)))
}

export interface ArchiveIntegrity {
  bytes: number
  digest: string
  expectedBytes: number
  expectedSha256: string
}

// 下载完整性硬校验：字节数与 SHA-256 双重核对，任何一项不符立即拦截
export function assertPortableArchiveIntegrity(integrity: ArchiveIntegrity): void {
  if (integrity.bytes !== integrity.expectedBytes)
    throw new Error(
      `下载不完整：期望 ${integrity.expectedBytes} 字节，实际 ${integrity.bytes} 字节`
    )
  if (integrity.digest.toLowerCase() !== integrity.expectedSha256.toLowerCase())
    throw new Error('下载内容校验失败：SHA-256 与预期不符（可能被网络中间层篡改）')
}

// 流式下载 + 边下边算 SHA-256：不把整包读进内存。
// timeoutMs（默认 180 秒）经 AbortSignal 同时兜住连接建立与中途断流挂起——
// 否则主源半途卡死会永久占用 installing 状态且无法回退备源。
export async function downloadFileStreaming(
  url: string,
  targetPath: string,
  options: {
    fetchFn?: typeof fetch
    totalBytes?: number
    timeoutMs?: number
    onBytes?: (downloaded: number, total: number) => void
  } = {}
): Promise<{ bytes: number; digest: string }> {
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000)
  })
  if (!response.ok || !response.body) {
    // 释放未消费的响应体，避免底层连接悬挂
    await response.body?.cancel().catch(() => {})
    throw new Error(`下载请求失败：HTTP ${response.status || '无响应体'}`)
  }
  const total = (options.totalBytes ?? Number(response.headers.get('content-length'))) || 0
  const source = Readable.fromWeb(
    response.body as unknown as import('node:stream/web').ReadableStream
  )
  const digest = createHash('sha256')
  let bytes = 0
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    digest.update(chunk)
    options.onBytes?.(bytes, total)
  })
  await pipeline(source, createWriteStream(targetPath))
  return { bytes, digest: digest.digest('hex') }
}

export interface PortableRuntimeOptions {
  runtimeRoot: string
  runner: CommandRunner
  platform?: NodeJS.Platform
  /** 测试注入用：替换归档规格与下载实现；生产恒用 PORTABLE_PYTHON + 流式下载 */
  archive?: PortableArchiveSpec
  fetchFn?: typeof fetch
  downloadTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  downloadArchive?: (
    source: PortableArchiveSource,
    targetPath: string,
    onBytes: (downloaded: number, total: number) => void
  ) => Promise<{ bytes: number; digest: string }>
  exists?: (path: string) => boolean
  mkdir?: (path: string) => void
  rmTree?: (path: string) => void
  moveDir?: (from: string, to: string) => void
  onProgress?: (phase: string, percent: number) => void
}

async function pythonRuntimeUsable(runner: CommandRunner, pythonExe: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await runner(pythonExe, ['--version'], { timeout: 30_000 })
    const version = parsePythonVersionOutput(`${stdout}\n${stderr}`)
    if (!version || !isSupportedPythonVersion(version)) return false
    await runner(pythonExe, ['-c', 'import venv'], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

// 本机无可用 Python 时的零门槛兜底：下载独立便携版 3.12 到应用数据目录
//（不写注册表、不改 PATH），字节数 + SHA-256 硬校验，双源自动回退，
// 用 Windows 10/11 系统自带的 tar.exe 解压并原子落到 runtimeRoot/python。
// 已安装且校验通过时直接复用，不重复下载。
export async function ensurePortablePythonRuntime(
  options: PortableRuntimeOptions
): Promise<string> {
  if ((options.platform ?? process.platform) !== 'win32')
    throw new Error('独立 Python 运行时仅支持 Windows')
  const runtimeRoot = options.runtimeRoot
  const exists = options.exists ?? existsSync
  const mkdir = options.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const rmTree =
    options.rmTree ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  const moveDir = options.moveDir ?? ((from: string, to: string) => renameSync(from, to))
  const onProgress = options.onProgress ?? (() => {})
  const archive = options.archive ?? PORTABLE_PYTHON
  const targetExe = join(runtimeRoot, 'python', 'python.exe')
  if (exists(targetExe)) {
    if (await pythonRuntimeUsable(options.runner, targetExe)) return targetExe
    rmTree(runtimeRoot) // 半残的旧运行时整体清掉重来
  }
  mkdir(runtimeRoot)
  const problems: string[] = []
  for (const [index, source] of archive.sources.entries()) {
    // 归档与解压产物是不可信的外部数据：各自放在独立的全新目录里
    const downloadDir = join(runtimeRoot, `download-${index}`)
    const extractDir = join(runtimeRoot, `extract-${index}`)
    const archivePath = join(downloadDir, archive.fileName)
    mkdir(downloadDir)
    mkdir(extractDir)
    try {
      const reportProgress = (downloaded: number, total: number): void =>
        onProgress(PORTABLE_DOWNLOAD_PHASE, portableDownloadPercent(downloaded, total))
      onProgress(PORTABLE_DOWNLOAD_PHASE, 1)
      const { bytes, digest } = options.downloadArchive
        ? await options.downloadArchive(source, archivePath, reportProgress)
        : await downloadFileStreaming(source.url, archivePath, {
            fetchFn: options.fetchFn,
            totalBytes: archive.expectedBytes,
            timeoutMs: options.downloadTimeoutMs,
            onBytes: reportProgress
          })
      assertPortableArchiveIntegrity({
        bytes,
        digest,
        expectedBytes: archive.expectedBytes,
        expectedSha256: archive.expectedSha256
      })
      onProgress('解压独立 Python 运行时', 12)
      await options.runner(
        resolveTarCommand(options.env ?? process.env, exists, options.platform),
        ['-xzf', archivePath, '-C', extractDir],
        { timeout: 300_000 }
      )
      const extractedExe = join(extractDir, 'python', 'python.exe')
      const probe = await options.runner(extractedExe, ['--version'], { timeout: 30_000 })
      if (!parsePythonVersionOutput(`${probe.stdout}\n${probe.stderr}`))
        throw new Error('解压产物缺少可执行的 python.exe')
      rmTree(join(runtimeRoot, 'python'))
      moveDir(join(extractDir, 'python'), join(runtimeRoot, 'python'))
      return targetExe
    } catch (error) {
      problems.push(`${source.label}：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      rmTree(downloadDir)
      rmTree(extractDir)
    }
  }
  throw new Error(
    `独立 Python 运行时下载失败（已尝试 ${archive.sources.length} 个下载源）：${problems.join('；')}`
  )
}

// 安装入口的启动器解析：优先本机深度发现；Windows 下完全找不到时
// 自动回退下载便携运行时（其他平台保持原有报错）
export async function resolveInstallLauncher(options: {
  findLocal: () => Promise<LauncherCandidate>
  ensurePortable: () => Promise<LauncherCandidate>
  platform?: NodeJS.Platform
}): Promise<LauncherCandidate> {
  try {
    return await options.findLocal()
  } catch (localError) {
    if ((options.platform ?? process.platform) !== 'win32') throw localError
    return options.ensurePortable()
  }
}

// 半残 .venv 自愈：首次 venv 在拷贝 python.exe 之后、ensurepip 完成之前被杀软
// 拦截/中断，会留下「有 python.exe 没有 pip」的残缺环境；此前仅凭 python.exe
// 存在就跳过创建，重试会永久卡在 No module named pip。
// 策略：pip 可用直接过；否则 ensurepip 就地补装并复验；仍不行删目录重建 venv
//（venv 创建失败也清理后重试一次）；最终必须 pip 可用才放行进入装包阶段。
export async function ensureVirtualEnvironment(options: {
  runner: CommandRunner
  launcher: LauncherCandidate
  environment: string
  pythonPath: string
  exists?: (path: string) => boolean
  rmTree?: (path: string) => void
  mkdir?: (path: string) => void
}): Promise<void> {
  const { runner, launcher, environment, pythonPath } = options
  const exists = options.exists ?? existsSync
  const rmTree =
    options.rmTree ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  const mkdir = options.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const pipUsable = async (): Promise<boolean> => {
    try {
      await runner(pythonPath, ['-m', 'pip', '--version'], { timeout: 60_000 })
      return true
    } catch {
      return false
    }
  }
  const createVenv = async (): Promise<void> => {
    mkdir(dirname(environment))
    await runner(launcher.command, [...launcher.args, '-m', 'venv', environment], {
      timeout: 120_000
    })
  }
  if (exists(pythonPath)) {
    if (await pipUsable()) return
    // 先试 ensurepip 就地补装（保留已有 site-packages，比重建快得多）
    try {
      await runner(pythonPath, ['-m', 'ensurepip', '--upgrade'], { timeout: 180_000 })
      if (await pipUsable()) return
    } catch {
      // 落入重建
    }
  }
  rmTree(environment)
  try {
    await createVenv()
  } catch {
    // 杀软占用 / 首次创建被打断：清理残缺目录后再试一次
    rmTree(environment)
    await createVenv()
  }
  if (await pipUsable()) return
  try {
    await runner(pythonPath, ['-m', 'ensurepip', '--upgrade'], { timeout: 180_000 })
  } catch {
    // 最终校验会给出明确的失败原因
  }
  if (!(await pipUsable()))
    throw new Error(
      '虚拟环境重建后 pip 仍不可用，常见原因是杀毒软件拦截了应用数据目录，请将其加入白名单后重试'
    )
}
