// localStorage that never throws: private windows and blocked storage read as
// empty and drop writes, so preferences are a convenience, never a dependency.

export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function forget(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

/** A stored value from a fixed set, or `fallback` when it is missing or unknown. */
export function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = load(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}
