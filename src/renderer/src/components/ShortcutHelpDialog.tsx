import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { KeyboardIcon, XIcon } from '@phosphor-icons/react'
import { getContextualShortcuts, type ShortcutGroup } from '../services/shortcuts'

interface ShortcutHelpDialogProps {
  open: boolean
  onClose: () => void
}

function ShortcutGroupBlock({
  group,
  isCurrent = false
}: {
  group: ShortcutGroup
  isCurrent?: boolean
}): React.JSX.Element {
  return (
    <section className={`shortcut-group${isCurrent ? ' is-current' : ''}`}>
      <div className="shortcut-group-head">
        <h2>{group.title}</h2>
        {isCurrent && <span className="pill is-current-badge">当前页面</span>}
      </div>
      {group.subtitle && <p className="shortcut-group-sub">{group.subtitle}</p>}
      <ul className="shortcut-list">
        {group.items.map((item) => (
          <li className="shortcut-row" key={item.description}>
            <span className="shortcut-desc">{item.description}</span>
            <span className="shortcut-keys">
              {item.keys.map((keyLabel) => (
                <kbd className="command-kbd" key={keyLabel}>
                  {keyLabel}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps): React.JSX.Element {
  const { pathname } = useLocation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const { currentGroup, otherGroups } = getContextualShortcuts(pathname)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      requestAnimationFrame(() => closeBtnRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // 为尚未实现 HTMLDialogElement.closedBy 的环境提供点击背景关闭回退
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) return
    let pressedOutside = false
    const outside = (event: PointerEvent): boolean => {
      const rect = dialog.getBoundingClientRect()
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
    }
    const onPointerDown = (event: PointerEvent): void => {
      pressedOutside = dialog.open && outside(event)
    }
    const onPointerUp = (event: PointerEvent): void => {
      if (pressedOutside && dialog.open && outside(event)) {
        dialog.close()
      }
      pressedOutside = false
    }
    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('pointerup', onPointerUp)
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="tz-dialog shortcut-dialog"
      aria-labelledby="shortcut-help-title"
      onClose={() => {
        if (open) onClose()
      }}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      <div className="tz-dialog-head">
        <div className="tz-dialog-title-wrap">
          <KeyboardIcon size={18} aria-hidden />
          <h1 id="shortcut-help-title" className="tz-dialog-title">
            快捷键与高频操作速查
          </h1>
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          className="tz-dialog-close"
          aria-label="关闭快捷键速查"
          title="关闭 (Esc)"
          onClick={() => dialogRef.current?.close()}
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="tz-dialog-body shortcut-dialog-body">
        {currentGroup && <ShortcutGroupBlock group={currentGroup} isCurrent />}
        <div className="shortcut-grid">
          {otherGroups.map((group) => (
            <ShortcutGroupBlock group={group} key={group.id} />
          ))}
        </div>
      </div>
    </dialog>
  )
}
