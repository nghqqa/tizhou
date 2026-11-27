import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  KnowledgeBuildFile,
  KnowledgeEngineStatus,
  OcrQualityReport
} from '../../../shared/contracts'
import { parseOcrWorkerLine } from '../../../shared/ocr-payload'
import { PIP_MIRRORS } from '../../../shared/pip-mirrors'
import {
  CPU_ONNXRUNTIME_SPEC,
  DIRECTML_PACKAGE,
  pickGpuAdapter,
  setRapidocrDmlEnabled
} from '../ocr-accelerator'
import {
  PipSourceFailure,
  envPipIndexUrl,
  installWithMirrorQueue,
  mirrorById,
  mirrorQueueFromProbes,
  normalizeMirrorPreference,
  pipMirrorFailureHint,
  probeMirror,
  type PipSource
} from '../pip-mirror'
import {
  ensurePortablePythonRuntime,
  ensureVirtualEnvironment,
  findPythonLauncher as findPythonLauncherCandidate,
  resolveInstallLauncher,
  type CommandRunner
} from '../python-runtime'
import {
  MARKITDOWN_VERSION,
  OCR_PACKAGES,
  STRUCTURED_PACKAGE,
  SUPPORTED_EXTENSIONS
} from './constants'
import { atomicWriteFile } from './markdown-helpers'

const execFileAsync = promisify(execFile)

export interface EngineManagerHost {
  hasRunningJob: () => boolean
  setRunningChild: (child?: ReturnType<typeof spawn>) => void
  pipInstallWithProgress: (
    pythonPath: string,
    spec: string,
    base: number,
    span: number,
    phase: string
  ) => Promise<void>
  runPipInstall: (
    pythonPath: string,
    spec: string,
    source: PipSource,
    base: number,
    span: number,
    phase: string
  ) => Promise<void>
}

export class KnowledgeEngineManager {
  private installing = false
  private installProgress?: { phase: string; percent: number }
  private engineCache?: KnowledgeEngineStatus
  private gpuAdapterProbe?: Promise<string | undefined>
  private resolvedMirrorQueue?: PipSource[]

  constructor(
    private readonly engineDirectory: string,
    private readonly resourceDirectory: string
  ) {}

  async engineStatus(): Promise<KnowledgeEngineStatus> {
    const progress = this.installing ? this.installProgress : undefined
    if (
      this.engineCache?.available &&
      this.engineCache.pythonPath &&
      existsSync(this.engineCache.pythonPath)
    ) {
      const cachedPythonPath = this.engineCache.pythonPath
      return {
        ...this.engineCache,
        ocrAccelerator: this.ocrAcceleratorMode(),
        gpuAdapterName: await this.detectGpuAdapter(),
        pipMirrorId: this.pipMirrorPreference(),
        structuredParseAvailable: await this.structuredParseAvailable(cachedPythonPath),
        installing: this.installing,
        installProgress: progress
      }
    }
    const candidates = this.pythonCandidates()
    for (const pythonPath of candidates) {
      if (!existsSync(pythonPath)) continue
      const version = await this.markitdownVersion(pythonPath)
      if (version) {
        const structuredParseAvailable = await this.structuredParseAvailable(pythonPath)
        this.engineCache = {
          available: true,
          installing: this.installing,
          version,
          pythonPath,
          ocrAvailable: await this.ocrComponentsAvailable(pythonPath),
          structuredParseAvailable,
          message: `MarkItDown ${version} 已就绪`,
          supportedExtensions: [...SUPPORTED_EXTENSIONS]
        }
        return {
          ...this.engineCache,
          ocrAccelerator: this.ocrAcceleratorMode(),
          gpuAdapterName: await this.detectGpuAdapter(),
          pipMirrorId: this.pipMirrorPreference(),
          structuredParseAvailable,
          installProgress: progress
        }
      }
    }
    return {
      available: false,
      installing: this.installing,
      ocrAvailable: false,
      pipMirrorId: this.pipMirrorPreference(),
      structuredParseAvailable: false,
      message: '尚未安装独立 MarkItDown 转换环境',
      supportedExtensions: [...SUPPORTED_EXTENSIONS],
      installProgress: progress
    }
  }

  async installEngine(host: EngineManagerHost): Promise<KnowledgeEngineStatus> {
    if (this.installing) throw new Error('转换引擎正在安装，请稍候')
    if (host.hasRunningJob()) throw new Error('知识构建任务运行时不能更新转换引擎')
    this.installing = true
    try {
      this.installProgress = { phase: '正在定位 Python 环境', percent: 2 }
      const launcher = await resolveInstallLauncher({
        findLocal: () => this.findPythonLauncher(),
        ensurePortable: () => this.ensurePortableLauncher()
      })
      const environment = join(this.engineDirectory, '.venv')
      const pythonPath = this.managedPythonPath()
      this.installProgress = { phase: '创建独立虚拟环境', percent: 13 }
      await ensureVirtualEnvironment({
        runner: this.commandRunner(),
        launcher,
        environment,
        pythonPath
      })
      const firstSource = (await this.resolveMirrorQueue())[0]
      this.installProgress = { phase: `安装源：${firstSource?.label ?? '自动'}`, percent: 14 }
      await host.pipInstallWithProgress(
        pythonPath,
        `markitdown[pdf,docx,pptx,xlsx,xls,outlook]==${MARKITDOWN_VERSION}`,
        15,
        20,
        '安装文档转换组件 MarkItDown'
      )
      await host.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[0]!,
        36,
        20,
        '安装 OCR 组件 RapidOCR（含识别模型）'
      )
      await host.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[1]!,
        56,
        30,
        '安装推理运行时 onnxruntime（体积较大）'
      )
      await host.pipInstallWithProgress(
        pythonPath,
        OCR_PACKAGES[2]!,
        86,
        5,
        '安装 PDF 渲染组件 pypdfium2'
      )
      await host.pipInstallWithProgress(
        pythonPath,
        STRUCTURED_PACKAGE,
        91,
        5,
        '安装文档结构解析组件 RapidDoc（表格还原）'
      )
      this.installProgress = { phase: '验证安装结果', percent: 97 }
      this.engineCache = undefined
      const status = await this.engineStatus()
      if (!status.available) throw new Error('安装命令已结束，但 MarkItDown 无法导入')
      this.installProgress = { phase: '安装完成', percent: 100 }
      return status
    } catch (error) {
      throw new Error(`转换引擎安装失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      this.installing = false
    }
  }

  async installGpuAccelerator(host: EngineManagerHost): Promise<KnowledgeEngineStatus> {
    if (this.installing) throw new Error('转换引擎正在安装，请稍候')
    if (host.hasRunningJob()) throw new Error('知识构建任务运行时不能更新转换引擎')
    this.installing = true
    let pythonPathForRollback = ''
    let uninstalledCpu = false
    try {
      const current = await this.engineStatus()
      if (!current.available || !current.ocrAvailable || !current.pythonPath)
        throw new Error('请先安装转换引擎与 OCR 组件，再启用 GPU 加速')
      const pythonPath = current.pythonPath
      pythonPathForRollback = pythonPath
      this.installProgress = { phase: '卸载 CPU 推理后端 onnxruntime', percent: 8 }
      await execFileAsync(pythonPath, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime'], {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      })
      uninstalledCpu = true
      await host.pipInstallWithProgress(
        pythonPath,
        DIRECTML_PACKAGE,
        25,
        55,
        '安装 DirectML 推理后端（DX12 显卡通用）'
      )
      this.installProgress = { phase: '启用 GPU 推理开关', percent: 86 }
      this.setRapidocrDml(true)
      this.installProgress = { phase: '验证 GPU 推理是否真实生效', percent: 92 }
      if (!(await this.probeDml(pythonPath))) {
        this.installProgress = { phase: 'GPU 未生效，自动回退 CPU 推理后端', percent: 95 }
        await execFileAsync(pythonPath, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime-directml'], {
          timeout: 180_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024
        })
        await host.pipInstallWithProgress(
          pythonPath,
          CPU_ONNXRUNTIME_SPEC,
          95,
          3,
          '回退安装 CPU 推理后端 onnxruntime'
        )
        uninstalledCpu = false
        this.setRapidocrDml(false)
        this.engineCache = undefined
        throw new Error(
          '本机显卡不支持 DirectML 加速，已自动回退 CPU 后端（识别质量与速度不受影响）'
        )
      }
      uninstalledCpu = false
      this.engineCache = undefined
      this.installProgress = { phase: 'GPU 加速已启用', percent: 100 }
      return await this.engineStatus()
    } catch (error) {
      if (uninstalledCpu && pythonPathForRollback) {
        try {
          await host.pipInstallWithProgress(
            pythonPathForRollback,
            CPU_ONNXRUNTIME_SPEC,
            90,
            8,
            '安装失败，正在恢复 CPU 推理后端 onnxruntime'
          )
        } catch {
          // 恢复尽力而为，不掩盖原始失败原因
        }
        this.setRapidocrDml(false)
      }
      this.engineCache = undefined
      if (error instanceof Error && error.message.startsWith('本机显卡不支持')) throw error
      if (error instanceof Error && error.message.startsWith('请先安装转换引擎')) throw error
      throw new Error(
        `GPU 加速组件安装失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    } finally {
      this.installing = false
    }
  }

  async removeGpuAccelerator(host: EngineManagerHost): Promise<KnowledgeEngineStatus> {
    if (this.installing) throw new Error('转换引擎正在安装，请稍候')
    if (host.hasRunningJob()) throw new Error('知识构建任务运行时不能更新转换引擎')
    this.installing = true
    try {
      const current = await this.engineStatus()
      if (!current.available || !current.pythonPath)
        throw new Error('转换引擎尚未安装，无需移除 GPU 加速')
      if (!this.dmlInstalled()) throw new Error('当前未启用 GPU 加速')
      const pythonPath = current.pythonPath
      this.installProgress = { phase: '卸载 DirectML 推理后端', percent: 15 }
      await execFileAsync(pythonPath, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime-directml'], {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      })
      this.installProgress = { phase: '恢复 CPU 推理后端 onnxruntime', percent: 45 }
      await host.pipInstallWithProgress(
        pythonPath,
        CPU_ONNXRUNTIME_SPEC,
        45,
        40,
        '恢复 CPU 推理后端 onnxruntime'
      )
      this.installProgress = { phase: '恢复 CPU 推理开关', percent: 90 }
      this.setRapidocrDml(false)
      this.engineCache = undefined
      this.installProgress = { phase: '已恢复 CPU 推理', percent: 100 }
      return await this.engineStatus()
    } catch (error) {
      this.engineCache = undefined
      if (
        error instanceof Error &&
        (error.message.startsWith('转换引擎尚未安装') || error.message.startsWith('当前未启用'))
      ) {
        throw error
      }
      throw new Error(
        `GPU 加速组件移除失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    } finally {
      this.installing = false
    }
  }

  ocrAcceleratorMode(): 'cpu' | 'dml' {
    return this.dmlInstalled() && this.dmlEnabled() ? 'dml' : 'cpu'
  }

  async setPipMirror(mirrorId: string): Promise<void> {
    const preference = normalizeMirrorPreference(mirrorId)
    atomicWriteFile(
      this.mirrorPreferencePath(),
      JSON.stringify({ mirrorId: preference, updatedAt: new Date().toISOString() }, null, 2)
    )
    this.resolvedMirrorQueue = undefined
  }

  async resolveMirrorQueue(): Promise<PipSource[]> {
    if (this.resolvedMirrorQueue) return this.resolvedMirrorQueue
    const fromEnv = envPipIndexUrl()
    if (fromEnv)
      return (this.resolvedMirrorQueue = [{ url: fromEnv, label: '环境变量 PIP_INDEX_URL' }])
    const preference = this.pipMirrorPreference()
    if (preference !== 'auto') {
      const mirror = mirrorById(preference)
      if (mirror)
        return (this.resolvedMirrorQueue = [{ url: mirror.indexUrl, label: mirror.label }])
    }
    const probes = await Promise.all(
      PIP_MIRRORS.map(async (mirror) => {
        const startedAt = Date.now()
        const reachable = await probeMirror(mirror.indexUrl)
        return { ...mirror, reachable, elapsedMs: Date.now() - startedAt }
      })
    )
    const queue = mirrorQueueFromProbes(probes).map((mirror) => ({
      url: mirror.indexUrl,
      label: mirror.label
    }))
    return (this.resolvedMirrorQueue = queue)
  }

  promoteMirrorSource(source: PipSource): void {
    const queue = this.resolvedMirrorQueue
    if (!queue) return
    const rest = queue.filter((item) => item.url !== source.url)
    this.resolvedMirrorQueue = [source, ...rest]
  }

  async pipInstallWithProgress(
    runPipInstall: (
      pythonPath: string,
      spec: string,
      source: PipSource,
      base: number,
      span: number,
      phase: string
    ) => Promise<void>,
    pythonPath: string,
    spec: string,
    base: number,
    span: number,
    phase: string
  ): Promise<void> {
    const queue = await this.resolveMirrorQueue()
    this.installProgress = { phase, percent: base }
    await installWithMirrorQueue({
      queue,
      run: (source) => runPipInstall(pythonPath, spec, source, base, span, phase),
      onSourceFailure: (_failed, next) => {
        this.installProgress = {
          phase: `${phase}（当前源安装失败，自动切换至 ${next.label} 重试…）`,
          percent: base
        }
      },
      onSourceSuccess: (source) => this.promoteMirrorSource(source),
      buildHint: (combinedOutput) => {
        if (envPipIndexUrl()) return undefined
        return pipMirrorFailureHint(combinedOutput, this.pipMirrorPreference())
      }
    })
  }

  runPipInstall(
    pythonPath: string,
    spec: string,
    source: PipSource,
    base: number,
    span: number,
    phase: string
  ): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        pythonPath,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--index-url', source.url, spec],
        {
          windowsHide: true,
          shell: false,
          env: { ...process.env, PIP_NO_INPUT: '1', PYTHONUTF8: '1' }
        }
      )
      let stderr = ''
      let stdoutTail = ''
      let buffer = ''
      let collected = 0
      let finished = 0
      const timer = setTimeout(() => child.kill(), 20 * 60_000)
      const update = (): void => {
        const fraction = collected > 0 ? Math.min(1, finished / collected) : 0
        this.installProgress = {
          phase,
          percent: Math.max(base, Math.min(base + span, Math.round(base + span * fraction)))
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutTail = `${stdoutTail}${chunk}`.slice(-20_000)
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (/^Collecting /.test(line)) collected += 1
          else if (/^(Downloading |Using cached )/.test(line)) {
            finished += 1
            update()
          } else if (/^Successfully installed /.test(line)) {
            finished = collected
            update()
          }
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolvePromise()
        const output = [stderr.trim(), stdoutTail.trim()].filter(Boolean).join('\n')
        reject(new PipSourceFailure(output || `pip 进程退出码 ${code ?? '未知'}`))
      })
    })
  }

  async spawnMarkitdownConvert(
    pythonPath: string,
    workerPath: string,
    sourcePath: string,
    outputPath: string,
    setRunningChild: (child?: ReturnType<typeof spawn>) => void
  ): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(pythonPath, [workerPath, sourcePath, outputPath], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      })
      setRunningChild(child)
      let stderr = ''
      const timer = setTimeout(() => child.kill(), 10 * 60_000)
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        setRunningChild(undefined)
        if (code === 0 && existsSync(outputPath)) resolvePromise()
        else reject(new Error(stderr.trim() || `MarkItDown 进程退出码 ${code ?? '未知'}`))
      })
    })
  }

  async spawnStructuredConvert(
    pythonPath: string,
    sourcePath: string,
    rawPath: string,
    setRunningChild: (child?: ReturnType<typeof spawn>) => void
  ): Promise<{ ok: boolean; quality?: OcrQualityReport }> {
    return new Promise((resolvePromise) => {
      const workerPath = this.ocrWorkerPath()
      const child = spawn(pythonPath, [workerPath, sourcePath, rawPath, '--structured'], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      setRunningChild(child)
      let done = false
      let quality: OcrQualityReport | undefined
      let stdoutBuffer = ''
      const handleLine = (line: string): void => {
        const parsed = parseOcrWorkerLine(line)
        if (parsed?.type === 'quality') {
          done = true
          quality = parsed
        }
      }
      const finish = (ok: boolean): void => {
        setRunningChild(undefined)
        resolvePromise({ ok, quality })
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) handleLine(line)
      })
      child.stderr.on('data', (chunk: string) => {
        void chunk
      })
      const timer = setTimeout(() => child.kill(), 60 * 60_000)
      child.once('error', () => {
        clearTimeout(timer)
        finish(false)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer)
        finish(done && code === 0)
      })
    })
  }

  async spawnOcrConvert(
    file: KnowledgeBuildFile,
    pythonPath: string,
    sourcePath: string,
    outputPath: string,
    onProgressSave: () => void,
    setRunningChild: (child?: ReturnType<typeof spawn>) => void
  ): Promise<OcrQualityReport | undefined> {
    const worker = this.ocrWorkerPath()
    let qualityReport: OcrQualityReport | undefined
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(pythonPath, [worker, sourcePath, outputPath], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      })
      setRunningChild(child)
      let stderr = ''
      let stdoutBuffer = ''
      const timer = setTimeout(() => child.kill(), 45 * 60_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const payload = parseOcrWorkerLine(line)
          if (!payload) continue
          if (payload.type === 'quality') {
            qualityReport = payload
            continue
          }
          if (payload.type === 'progress') {
            const source = payload.source === 'text-layer' ? '文字层' : 'OCR'
            file.message = `第 ${payload.page}/${payload.total} 页 · ${source}`
            onProgressSave()
          }
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        setRunningChild(undefined)
        if (stdoutBuffer.trim()) {
          const payload = parseOcrWorkerLine(stdoutBuffer)
          if (payload?.type === 'quality') {
            qualityReport = payload
          }
        }
        if (code === 0 && existsSync(outputPath)) resolvePromise()
        else reject(new Error(stderr.trim() || `OCR 进程退出码 ${code ?? '未知'}`))
      })
    })
    return qualityReport
  }

  workerPath(): string {
    const candidates = [
      join(this.resourceDirectory, 'tools', 'markitdown-worker.py'),
      resolve(process.cwd(), 'tools', 'markitdown-worker.py')
    ]
    const path = candidates.find((candidate) => existsSync(candidate))
    if (!path) throw new Error('MarkItDown 本地转换脚本缺失')
    return path
  }

  ocrWorkerPath(): string {
    const candidates = [
      join(this.resourceDirectory, 'tools', 'ocr-worker.py'),
      resolve(process.cwd(), 'tools', 'ocr-worker.py')
    ]
    const path = candidates.find((candidate) => existsSync(candidate))
    if (!path) throw new Error('OCR 本地识别脚本缺失')
    return path
  }

  private commandRunner(): CommandRunner {
    return (command, args, options) =>
      execFileAsync(command, args, {
        timeout: options?.timeout ?? 30_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
  }

  private async ensurePortableLauncher(): Promise<{ command: string; args: string[] }> {
    const pythonExe = await ensurePortablePythonRuntime({
      runtimeRoot: join(this.engineDirectory, 'runtime'),
      runner: this.commandRunner(),
      onProgress: (phase, percent) => (this.installProgress = { phase, percent })
    })
    return { command: pythonExe, args: [] }
  }

  private rapidocrConfigPath(): string {
    return join(this.engineDirectory, '.venv', 'Lib', 'site-packages', 'rapidocr', 'config.yaml')
  }

  private dmlInstalled(): boolean {
    const sitePackages = join(this.engineDirectory, '.venv', 'Lib', 'site-packages')
    try {
      return readdirSync(sitePackages).some((entry) =>
        entry.toLowerCase().startsWith('onnxruntime_directml')
      )
    } catch {
      return false
    }
  }

  private dmlEnabled(): boolean {
    try {
      return /use_dml:\s*true/.test(readFileSync(this.rapidocrConfigPath(), 'utf8'))
    } catch {
      return false
    }
  }

  private setRapidocrDml(enabled: boolean): void {
    const configPath = this.rapidocrConfigPath()
    if (!existsSync(configPath)) return
    atomicWriteFile(configPath, setRapidocrDmlEnabled(readFileSync(configPath, 'utf8'), enabled))
  }

  private detectGpuAdapter(): Promise<string | undefined> {
    if (!this.gpuAdapterProbe) {
      this.gpuAdapterProbe = execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "`n"'],
        { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }
      )
        .then(({ stdout }) => pickGpuAdapter(stdout.split(/\r?\n/)))
        .catch(() => undefined)
    }
    return this.gpuAdapterProbe
  }

  private async probeDml(pythonPath: string): Promise<boolean> {
    const snippet = [
      'import sys, io, contextlib',
      'try:',
      '    import onnxruntime as ort',
      "    if 'DmlExecutionProvider' not in ort.get_available_providers():",
      "        print('dml-probe: missing-provider'); sys.exit(0)",
      '    from rapidocr import RapidOCR',
      '    buf = io.StringIO()',
      '    with contextlib.redirect_stderr(buf), contextlib.redirect_stdout(buf):',
      '        RapidOCR()',
      '    captured = buf.getvalue()',
      "    bad = 'Failed to create DML' in captured or 'automatically shifted' in captured",
      "    print('dml-probe:', 'fallback' if bad else 'ok')",
      'except Exception as error:',
      "    print('dml-probe: error', error)"
    ].join('\n')
    try {
      const { stdout } = await execFileAsync(pythonPath, ['-c', snippet], {
        timeout: 180_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      return stdout.includes('dml-probe: ok')
    } catch {
      return false
    }
  }

  private mirrorPreferencePath(): string {
    return join(this.engineDirectory, 'pip-mirror.json')
  }

  private pipMirrorPreference(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.mirrorPreferencePath(), 'utf8')) as {
        mirrorId?: string
      }
      return normalizeMirrorPreference(parsed.mirrorId)
    } catch {
      return 'auto'
    }
  }

  private managedPythonPath(): string {
    return process.platform === 'win32'
      ? join(this.engineDirectory, '.venv', 'Scripts', 'python.exe')
      : join(this.engineDirectory, '.venv', 'bin', 'python')
  }

  private pythonCandidates(): string[] {
    const override = process.env.WORKBENCH_MARKITDOWN_PYTHON
    const development =
      process.platform === 'win32'
        ? resolve(process.cwd(), '.venv-markitdown', 'Scripts', 'python.exe')
        : resolve(process.cwd(), '.venv-markitdown', 'bin', 'python')
    return [
      ...new Set([override, this.managedPythonPath(), development].filter(Boolean) as string[])
    ]
  }

  private async markitdownVersion(pythonPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        pythonPath,
        ['-c', "import importlib.metadata as m; import markitdown; print(m.version('markitdown'))"],
        {
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: '1' }
        }
      )
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  private async structuredParseAvailable(pythonPath: string): Promise<boolean> {
    try {
      await execFileAsync(pythonPath, ['-c', 'import rapid_doc'], {
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      return true
    } catch {
      return false
    }
  }

  private async ocrComponentsAvailable(pythonPath: string): Promise<boolean> {
    try {
      await execFileAsync(pythonPath, ['-c', 'import rapidocr, pypdfium2'], {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONUTF8: '1' }
      })
      return true
    } catch {
      return false
    }
  }

  private async findPythonLauncher(): Promise<{ command: string; args: string[] }> {
    const override = process.env.WORKBENCH_MARKITDOWN_PYTHON?.trim()
    return findPythonLauncherCandidate({
      runner: this.commandRunner(),
      extraCandidates: override ? [{ command: override, args: [] }] : []
    })
  }
}
