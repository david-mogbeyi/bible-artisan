import { AsyncLocalStorage } from 'node:async_hooks';
import { Sequelize } from 'sequelize';

/**
 * Automatic transaction propagation for Sequelize 6 (BIB-12).
 *
 * `Sequelize.useCLS(namespace)` makes every query issued inside a managed transaction
 * (`sequelize.transaction(async () => …)`) join that transaction when the query does not pass a
 * `transaction` option itself. Sequelize 6 only needs a namespace object with `run`, `get`, `set`
 * and `bind`, the cls-hooked API, so this adapter backs it with Node's built-in
 * `AsyncLocalStorage` instead of adding the deprecated cls-hooked dependency.
 *
 * Effects:
 * - A write inside `MutationService.execute`'s work that forgets `{ transaction }` still commits
 *   or rolls back with the mutation, instead of autocommitting on another pooled connection.
 * - Passing `transaction` explicitly still wins; `transaction: null` opts a query out on purpose.
 * - Unmanaged transactions (`await sequelize.transaction()` without a callback) never bind to the
 *   context (Sequelize passes `useCLS = false` for them), and code outside a managed transaction
 *   sees no transaction, exactly as before.
 */
class AsyncLocalNamespace {
  private readonly storage = new AsyncLocalStorage<Map<string, unknown>>();

  /** Runs `fn` in a child context that starts as a copy of the current one (cls-hooked semantics). */
  run<T>(fn: (context: Map<string, unknown>) => T): T {
    const context = new Map(this.storage.getStore() ?? []);
    return this.storage.run(context, () => fn(context));
  }

  get(key: string): unknown {
    return this.storage.getStore()?.get(key);
  }

  set(key: string, value: unknown): void {
    const context = this.storage.getStore();
    // Sequelize only sets inside `run`; outside one there is nothing to propagate to.
    if (context) context.set(key, value);
  }

  bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return AsyncLocalStorage.bind(fn);
  }
}

const namespace = new AsyncLocalNamespace();

/**
 * Turns on propagation for every Sequelize instance in the process (Sequelize keeps the namespace
 * as a static). Idempotent; `createDatabase` calls it, so no instance ever runs without it.
 */
export function enableTransactionPropagation(): void {
  const current = (Sequelize as unknown as { _cls?: unknown })._cls;
  if (current !== namespace) Sequelize.useCLS(namespace);
}

/** The managed transaction the current async context runs in, if any. */
export function activeTransaction(): unknown {
  return namespace.get('transaction') ?? undefined;
}
