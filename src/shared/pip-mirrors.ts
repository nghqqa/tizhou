// 转换组件 pip 安装源清单（渲染进程选择器与主进程安装逻辑共用）

export interface PipMirror {
  id: string
  label: string
  indexUrl: string
}

export const PIP_MIRRORS: PipMirror[] = [
  { id: 'pypi', label: '官方 PyPI', indexUrl: 'https://pypi.org/simple' },
  { id: 'tuna', label: '清华 TUNA', indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'aliyun', label: '阿里云镜像', indexUrl: 'https://mirrors.aliyun.com/pypi/simple/' },
  { id: 'tencent', label: '腾讯云镜像', indexUrl: 'https://mirrors.cloud.tencent.com/pypi/simple/' }
]

export const AUTO_MIRROR_OPTION = { id: 'auto', label: '自动（安装时按网络测速选择）' }

export const PIP_MIRROR_OPTIONS = [AUTO_MIRROR_OPTION, ...PIP_MIRRORS]

export function pipMirrorLabel(id: string | undefined): string {
  if (!id || id === 'auto') return AUTO_MIRROR_OPTION.label
  return PIP_MIRRORS.find((mirror) => mirror.id === id)?.label ?? AUTO_MIRROR_OPTION.label
}
