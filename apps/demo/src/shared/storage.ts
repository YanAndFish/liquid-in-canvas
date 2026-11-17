export function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined'
      ? window.localStorage
      : null
  }
  catch {
    return null
  }
}

export function readPreference<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const stored = browserStorage()?.getItem(key)
    return allowed.find(value => value === stored) ?? null
  }
  catch {
    return null
  }
}

export function writePreference(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value)
  }
  catch {}
}
