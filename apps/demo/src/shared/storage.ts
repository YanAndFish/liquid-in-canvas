/** 返回浏览器本地存储；隐私模式或沙箱禁止访问时为 null。 */
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

/** 读取一项偏好，只接受列出的取值。 */
export function readPreference<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const stored = browserStorage()?.getItem(key)
    return allowed.find(value => value === stored) ?? null
  }
  catch {
    return null
  }
}

/** 写入一项偏好；存储不可用或已满时忽略。 */
export function writePreference(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value)
  }
  catch {}
}
