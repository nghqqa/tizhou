import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const OBSIDIAN_REGISTRY_KEYS = [
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Obsidian',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Obsidian',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Obsidian'
]

/**
 * 探测本机 Obsidian 可执行文件位置。
 * 覆盖：官方安装器默认目录（当前用户/全机）、Microsoft Store 执行别名、
 * Scoop、以及注册表 Uninstall 键记录的自定义安装目录。
 * 检测不到返回空字符串。
 */
export function detectedObsidian(): string {
  const programFilesX86 = process.env['PROGRAMFILES(X86)']
  const candidates = [
    // 官方安装器默认（当前用户）
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe')
      : '',
    // Microsoft Store 版执行别名
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Obsidian.exe')
      : '',
    // 全机安装
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Obsidian', 'Obsidian.exe') : '',
    programFilesX86 ? join(programFilesX86, 'Obsidian', 'Obsidian.exe') : '',
    // Scoop
    process.env.USERPROFILE
      ? join(process.env.USERPROFILE, 'scoop', 'apps', 'obsidian', 'current', 'Obsidian.exe')
      : ''
  ]
  const hit = candidates.find((candidate) => candidate && existsSync(candidate))
  return hit || detectedObsidianFromRegistry()
}

function detectedObsidianFromRegistry(): string {
  if (process.platform !== 'win32') return ''
  for (const key of OBSIDIAN_REGISTRY_KEYS) {
    try {
      const result = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      })
      if (result.status !== 0 || !result.stdout) continue
      const line = result.stdout.split('\n').find((entry) => entry.includes('InstallLocation'))
      const location = line?.split('REG_SZ')[1]?.trim()
      if (!location) continue
      const executable = join(location, 'Obsidian.exe')
      if (existsSync(executable)) return executable
    } catch {
      // reg 不可用或键不存在时静默跳过
    }
  }
  return ''
}
