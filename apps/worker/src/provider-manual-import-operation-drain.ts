/** Owns callbacks that may outlive a gateway response deadline. The source and
 * transaction enforce their own bounds; shutdown must await their settlement
 * before closing resources, never race another timer or retry their work. */
export class ProviderManualImportOperationDrain {
  readonly #pending = new Set<Promise<unknown>>();
  #drainPromise: Promise<void> | null = null;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#drainPromise !== null) {
      return Promise.reject(new Error("Provider import callback admission is closed."));
    }
    const result = Promise.resolve().then(operation);
    this.#pending.add(result);
    void result.then(
      () => { this.#pending.delete(result); },
      () => { this.#pending.delete(result); },
    );
    return result;
  }

  drain(): Promise<void> {
    this.#drainPromise ??= Promise.allSettled([...this.#pending]).then(() => undefined);
    return this.#drainPromise;
  }
}
