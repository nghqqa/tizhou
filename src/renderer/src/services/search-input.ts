import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent
} from 'react'

export interface UseImeSearchInputOptions {
  initialValue?: string
  /** 异步查询防抖毫秒数；本地同步过滤传 0 即可 */
  delayMs?: number
}

export interface UseImeSearchInputResult {
  /** 输入框当前展示值（包含拼音输入法预编辑内容） */
  value: string
  /** 已上屏/确认的值（IME 合成态期间保持上次稳定值） */
  committedValue: string
  /** 经防抖后的最终查询值（delayMs <= 0 时与 committedValue 同步） */
  debouncedValue: string
  /** 是否正处于中文等输入法组合输入态 */
  isComposing: boolean
  /** 绑定受控 onChange（兼容 Fluent UI Input 与原生 input） */
  handleChange: (nextValue: string, nativeEvent?: Event) => void
  handleCompositionStart: () => void
  handleCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void
  /** 非合成态按 Enter 时立即提交当前输入，不等待防抖 */
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  /** 编程式赋值；immediate 为 true（默认）时跳过防抖立即生效 */
  setValue: (nextValue: string, immediate?: boolean) => void
  /** 立即清空输入与查询词 */
  clear: () => void
  /** 立即将已确认词同步为查询词 */
  flush: () => void
}

/** 判断原生输入事件是否处于 IME 组合态 */
export function isEventComposing(nativeEvent?: Event | null): boolean {
  if (!nativeEvent) return false
  if ('isComposing' in nativeEvent && Boolean((nativeEvent as InputEvent).isComposing)) {
    return true
  }
  if ('keyCode' in nativeEvent && (nativeEvent as globalThis.KeyboardEvent).keyCode === 229) {
    return true
  }
  return false
}

/**
 * 统一封装支持中文输入法（IME composition）与防抖的搜索输入状态：
 * - 拼音打字选词期间只更新输入框显示值，不触发下游过滤或查库
 * - 选词上屏（compositionend）后才同步确认值并进入防抖
 * - 清除与回车可立即生效，避免多余等待
 */
export function useImeSearchInput(options: UseImeSearchInputOptions = {}): UseImeSearchInputResult {
  const { initialValue = '', delayMs = 250 } = options
  const [value, setRawValue] = useState(initialValue)
  const [committedValue, setCommittedValue] = useState(initialValue)
  const [debouncedState, setDebouncedState] = useState(initialValue)
  const [isComposing, setIsComposing] = useState(false)

  const composingRef = useRef(false)
  const committedRef = useRef(initialValue)
  const debouncedRef = useRef(initialValue)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (delayMs <= 0) {
      debouncedRef.current = committedValue
      return
    }
    if (committedValue === debouncedRef.current) return
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      debouncedRef.current = committedValue
      setDebouncedState(committedValue)
    }, delayMs)
    return () => {
      window.clearTimeout(timerRef.current)
    }
  }, [committedValue, delayMs])

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
    },
    []
  )

  const commit = useCallback(
    (nextValue: string, immediate = false) => {
      committedRef.current = nextValue
      setCommittedValue(nextValue)
      if (immediate || delayMs <= 0) {
        window.clearTimeout(timerRef.current)
        debouncedRef.current = nextValue
        setDebouncedState(nextValue)
      }
    },
    [delayMs]
  )

  const handleChange = useCallback(
    (nextValue: string, nativeEvent?: Event) => {
      setRawValue(nextValue)
      if (composingRef.current || isEventComposing(nativeEvent)) return
      commit(nextValue, false)
    },
    [commit]
  )

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true
    setIsComposing(true)
  }, [])

  const handleCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLInputElement>) => {
      composingRef.current = false
      setIsComposing(false)
      const target = event.target instanceof HTMLInputElement ? event.target : event.currentTarget
      const finalValue = target?.value ?? ''
      setRawValue(finalValue)
      commit(finalValue, false)
    },
    [commit]
  )

  const flush = useCallback(() => {
    if (composingRef.current) return
    window.clearTimeout(timerRef.current)
    debouncedRef.current = committedRef.current
    setDebouncedState(committedRef.current)
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (composingRef.current || isEventComposing(event.nativeEvent)) return
      if (event.key === 'Enter') {
        flush()
      }
    },
    [flush]
  )

  const setValue = useCallback(
    (nextValue: string, immediate = true) => {
      composingRef.current = false
      setIsComposing(false)
      setRawValue(nextValue)
      commit(nextValue, immediate)
    },
    [commit]
  )

  const clear = useCallback(() => {
    setValue('', true)
  }, [setValue])

  return {
    value,
    committedValue,
    debouncedValue: delayMs <= 0 ? committedValue : debouncedState,
    isComposing,
    handleChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
    setValue,
    clear,
    flush
  }
}
