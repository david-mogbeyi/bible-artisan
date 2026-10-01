/** The slice of an Express request the pre-parser HTTP middlewares read. */
export interface RequestLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Methods that must never change state. Everything else (POST, PUT, PATCH, DELETE, and any
 * non-standard method such as PROPFIND) is treated as state-changing, so a method nobody thought
 * of fails closed rather than open.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for every method except GET, HEAD and OPTIONS (case-insensitive). */
export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}
