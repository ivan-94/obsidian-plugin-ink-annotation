interface VersionedSourceEntry {
  readonly promise: Promise<string>;
  readonly version: number;
}

/** Bounded single-flight cache for the full Markdown source shared by rendered sections. */
export class VersionedSourceCache {
  private readonly entries = new Map<string, VersionedSourceEntry>();

  constructor(private readonly maximumEntries: number) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('Versioned source cache size must be a positive integer.');
    }
  }

  load(key: string, version: number, read: () => Promise<string>): Promise<string> {
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.version === version) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }

    const entry: VersionedSourceEntry = {
      promise: Promise.resolve().then(read),
      version,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    void entry.promise.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
