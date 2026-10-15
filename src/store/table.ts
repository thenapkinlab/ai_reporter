// A minimal key-value table with sorted keys: the subset of DynamoDB the store needs.
// MemoryTable backs local dev and tests; DynamoTable (src/aws/dynamo-table.ts) backs Lambda.

export interface Key {
  pk: string;
  sk: string;
}

export type Item = Key & Record<string, unknown>;

export interface QueryOptions {
  /** Sort key starts with this. */
  prefix?: string;
  /** Sort key between `from` and `to`, inclusive. */
  from?: string;
  to?: string;
  descending?: boolean;
  limit?: number;
}

export interface Table {
  get(key: Key): Promise<Item | null>;
  getMany(keys: Key[]): Promise<Item[]>;
  put(item: Item): Promise<void>;
  putMany(items: Item[]): Promise<void>;
  delete(key: Key): Promise<void>;
  deleteMany(keys: Key[]): Promise<void>;
  query(pk: string, opts?: QueryOptions): Promise<Item[]>;
  /** Every item in the table. For the nightly totals job only (fine at beta scale). */
  scan(): Promise<Item[]>;
  /** Atomically adds `by` to a numeric field (creating the item if needed) and returns the new value. */
  add(key: Key, field: string, by: number, expiresAt: number): Promise<number>;
}

export class MemoryTable implements Table {
  private items = new Map<string, Item>();

  private id(k: Key) {
    return `${k.pk}\u0000${k.sk}`;
  }

  async get(key: Key) {
    const it = this.items.get(this.id(key));
    return it ? structuredClone(it) : null;
  }

  async getMany(keys: Key[]) {
    const out: Item[] = [];
    for (const k of keys) {
      const it = await this.get(k);
      if (it) out.push(it);
    }
    return out;
  }

  async put(item: Item) {
    this.items.set(this.id(item), structuredClone(item));
  }

  async putMany(items: Item[]) {
    for (const it of items) await this.put(it);
  }

  async delete(key: Key) {
    this.items.delete(this.id(key));
  }

  async deleteMany(keys: Key[]) {
    for (const k of keys) await this.delete(k);
  }

  async scan() {
    return [...this.items.values()].map((r) => structuredClone(r));
  }

  async add(key: Key, field: string, by: number, expiresAt: number) {
    const it = this.items.get(this.id(key)) ?? { ...key, expiresAt };
    it[field] = Number(it[field] ?? 0) + by;
    this.items.set(this.id(key), it);
    return it[field] as number;
  }

  async query(pk: string, opts: QueryOptions = {}) {
    let rows = [...this.items.values()].filter((it) => it.pk === pk);
    if (opts.prefix !== undefined) rows = rows.filter((it) => it.sk.startsWith(opts.prefix!));
    if (opts.from !== undefined) rows = rows.filter((it) => it.sk >= opts.from!);
    if (opts.to !== undefined) rows = rows.filter((it) => it.sk <= opts.to!);
    rows.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    if (opts.descending) rows.reverse();
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map((r) => structuredClone(r));
  }
}
