// @akili-spec changes/cicd-executor-poc design §5.1, §7
// Port: the single source of truth (DD-03). Every write the core issues is
// conditional on the current status/version of an item, never a bare put.
// Kept generic and storage-agnostic: no DynamoDB SDK types here — those
// belong to the `dynamodb-state-store` adapter (design §4.2).

export interface StateItemKey {
  readonly partitionKey: string;
  readonly sortKey: string;
}

/** Optimistic-concurrency guard for a conditional write (DD-03). */
export interface WriteCondition {
  /** Expected current version; `undefined` means "item must not exist yet". */
  readonly expectedVersion?: number;
}

export interface StateStore {
  getItem<TItem>(key: StateItemKey): Promise<TItem | undefined>;

  /** Conditional write. Returns false (no-op) when the condition fails. */
  putItem<TItem>(
    key: StateItemKey,
    item: TItem,
    condition: WriteCondition,
  ): Promise<boolean>;

  /** Conditional delete. Returns false (no-op) when the condition fails. */
  deleteItem(key: StateItemKey, condition: WriteCondition): Promise<boolean>;

  /** Query a sparse index (e.g. GSI2, design §5.1) — never a table scan. */
  queryIndex<TItem>(
    indexName: string,
    partitionValue: string,
    options?: { sortKeyBefore?: string | number },
  ): Promise<TItem[]>;
}
