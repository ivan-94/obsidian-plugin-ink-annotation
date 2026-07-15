/** Serializes tasks per key while allowing unrelated keys to progress independently. */
export class KeyedSerialTaskQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  schedule<Result>(key: Key, task: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  clear(): void {
    this.tails.clear();
  }
}
