export interface ShortcutItem {
  keys: string[]
  description: string
}

export interface ShortcutGroup {
  id: string
  title: string
  subtitle?: string
  items: ShortcutItem[]
}

export function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.workbench?.platform === 'darwin'
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function hasOpenModal(): boolean {
  if (typeof document === 'undefined') return false
  return Boolean(
    document.querySelector(
      'dialog[open], [role="dialog"], .command-palette-backdrop, .update-modal-backdrop'
    )
  )
}

const GLOBAL_GROUP: ShortcutGroup = {
  id: 'global',
  title: '全局导航与专注视野',
  subtitle: '所有页面随时可用',
  items: [
    { keys: ['?'], description: '打开 / 关闭快捷键速查浮层' },
    { keys: ['Ctrl', 'K'], description: '打开全局快捷检索面板（题库 / 知识 / 页面）' },
    { keys: ['Alt', 'Z'], description: '切换沉浸专注模式（收起 / 展开左侧导航栏）' },
    { keys: ['F11'], description: '切换系统原生全屏窗口' },
    { keys: ['Ctrl', '+ / - / 0'], description: '放大 / 缩小 / 重置全局界面缩放比例' },
    { keys: ['Esc'], description: '关闭当前弹窗、草稿纸或命令面板' }
  ]
}

const PRACTICE_GROUP: ShortcutGroup = {
  id: 'practice',
  title: '专项练习 / 错题复习',
  subtitle: '焦点不在输入框时生效',
  items: [
    { keys: ['A–H', '1–8'], description: '快速选中对应客观题选项（极速模式下选即提交）' },
    { keys: ['右键选项'], description: '给选项加/去排除划线标记' },
    { keys: ['Enter'], description: '提交当前题目作答' },
    { keys: ['N'], description: '提交查看解析后进入下一题' },
    { keys: ['← / →'], description: '在上一题 / 下一题之间切换' },
    { keys: ['U'], description: '标记 / 取消「不确定待复查」' },
    { keys: ['S', 'Alt+D'], description: '呼出 / 收起随手草稿纸' }
  ]
}

const EXAM_GROUP: ShortcutGroup = {
  id: 'exam',
  title: '模拟考试',
  subtitle: '还原机考节奏',
  items: [
    { keys: ['A–H', '1–8'], description: '快速选择客观题答案并自动保存' },
    { keys: ['右键选项'], description: '给当前题选项标记 / 取消排除线' },
    { keys: ['← / →'], description: '上一题 / 下一题' },
    { keys: ['U'], description: '标记 / 取消「不确定」题号高亮' },
    { keys: ['S', 'Alt+D'], description: '呼出 / 收起考场草稿纸' }
  ]
}

const SHENLUN_GROUP: ShortcutGroup = {
  id: 'shenlun',
  title: '申论作答与批改',
  items: [
    { keys: ['Tab'], description: '方格答题卡中一键段落首行空两格' },
    { keys: ['Ctrl', 'S'], description: '立即保存当前申论作答草稿' },
    { keys: ['Alt', '← / →'], description: '切换上一题 / 下一题申论材料与题目' },
    { keys: ['划线松手'], description: '左栏给定材料划词四色勾画并支持一键摘录' }
  ]
}

const AI_GROUP: ShortcutGroup = {
  id: 'ai',
  title: 'AI 助教对话',
  items: [{ keys: ['Ctrl', 'Enter'], description: '向 AI 助教发送当前问题（兼容中文输入法）' }]
}

const SCRATCHPAD_GROUP: ShortcutGroup = {
  id: 'scratchpad',
  title: '随手草稿纸（浮层打开时）',
  items: [
    { keys: ['Ctrl', 'Z'], description: '手写画板撤销上一笔（或恢复刚刚清空的笔迹）' },
    { keys: ['Esc'], description: '收起草稿纸浮层' }
  ]
}

function adaptKeyForPlatform(key: string, isMac: boolean): string {
  if (!isMac) return key
  if (key === 'Ctrl') return '⌘'
  if (key === 'Alt') return '⌥'
  return key.replace(/\bCtrl\+/g, '⌘').replace(/\bAlt\+/g, '⌥')
}

function adaptGroupForPlatform(group: ShortcutGroup, isMac: boolean): ShortcutGroup {
  if (!isMac) return group
  return {
    ...group,
    items: group.items.map((item) => ({
      ...item,
      keys: item.keys.map((key) => adaptKeyForPlatform(key, true))
    }))
  }
}

export function getContextualShortcuts(
  pathname: string,
  isMac = isMacPlatform()
): {
  currentGroup: ShortcutGroup | null
  otherGroups: ShortcutGroup[]
} {
  let currentId: string | null = null
  if (pathname.startsWith('/practice') || pathname.startsWith('/review')) {
    currentId = 'practice'
  } else if (pathname.startsWith('/exam/run')) {
    currentId = 'exam'
  } else if (pathname.startsWith('/shenlun-solution')) {
    currentId = 'shenlun'
  } else if (pathname.startsWith('/ai')) {
    currentId = 'ai'
  }
  const all = [
    PRACTICE_GROUP,
    EXAM_GROUP,
    SHENLUN_GROUP,
    AI_GROUP,
    SCRATCHPAD_GROUP,
    GLOBAL_GROUP
  ].map((group) => adaptGroupForPlatform(group, isMac))
  const currentGroup = currentId ? (all.find((g) => g.id === currentId) ?? null) : null
  const otherGroups = all.filter((g) => g.id !== currentId)
  return { currentGroup, otherGroups }
}
