import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export interface LocalStorageCodec<T> {
  parse: (raw: string) => T
  serialize: (value: T) => string
}

export const BOOLEAN_FLAG_CODEC: LocalStorageCodec<boolean> = {
  parse: (raw) => raw !== '0',
  serialize: (value) => (value ? '1' : '0')
}

export const BOOLEAN_OPT_IN_CODEC: LocalStorageCodec<boolean> = {
  parse: (raw) => raw === '1',
  serialize: (value) => (value ? '1' : '0')
}

export function readLocalStorage(key: string, fallback = ''): string {
  try {
    const stored = window.localStorage.getItem(key)
    return stored !== null ? stored : fallback
  } catch {
    return fallback
  }
}

export function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 忽略受限环境下的 localStorage 写入失败 */
  }
}

export function removeLocalStorage(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* 忽略受限环境下的 localStorage 删除失败 */
  }
}

export function removeLocalStorageByPrefix(prefix: string, keepKey = ''): void {
  try {
    const staleKeys: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith(prefix) && key !== keepKey) {
        staleKeys.push(key)
      }
    }
    for (const key of staleKeys) {
      window.localStorage.removeItem(key)
    }
  } catch {
    /* 忽略受限存储环境失败 */
  }
}

export function readLocalStorageJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeLocalStorageJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 忽略受限环境下的 localStorage 写入失败 */
  }
}

export function useLocalStorageState<T>(
  key: string,
  initialValue: T,
  codec?: LocalStorageCodec<T>
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) return initialValue
      return codec ? codec.parse(raw) : (raw as unknown as T)
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    writeLocalStorage(key, codec ? codec.serialize(value) : String(value))
  }, [key, value, codec])

  return [value, setValue]
}
