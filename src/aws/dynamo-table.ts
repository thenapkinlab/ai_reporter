// The Table interface on DynamoDB, using the Document client (plain JS objects in and out).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Item, Key, QueryOptions, Table } from "../store/table";

const BATCH_WRITE = 25; // DynamoDB limit per BatchWriteItem
const BATCH_GET = 100; // DynamoDB limit per BatchGetItem

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DynamoTable implements Table {
  private doc: DynamoDBDocumentClient;

  constructor(
    private tableName: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(key: Key): Promise<Item | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: key }));
    return (r.Item as Item | undefined) ?? null;
  }

  async getMany(keys: Key[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const batch of chunks(keys, BATCH_GET)) {
      let request: Record<string, { Keys: Key[] }> | undefined = { [this.tableName]: { Keys: batch } };
      for (let attempt = 0; request && attempt < 5; attempt++) {
        const r = await this.doc.send(new BatchGetCommand({ RequestItems: request }));
        out.push(...((r.Responses?.[this.tableName] ?? []) as Item[]));
        const left = r.UnprocessedKeys?.[this.tableName]?.Keys as Key[] | undefined;
        request = left?.length ? { [this.tableName]: { Keys: left } } : undefined;
        if (request) await sleep(50 * 2 ** attempt);
      }
    }
    return out;
  }

  async put(item: Item): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async batchWrite(requests: Record<string, unknown>[]): Promise<void> {
    for (const batch of chunks(requests, BATCH_WRITE)) {
      let pending = batch;
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const r = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending as never } }));
        pending = (r.UnprocessedItems?.[this.tableName] ?? []) as Record<string, unknown>[];
        if (pending.length) await sleep(50 * 2 ** attempt);
      }
      if (pending.length) throw new Error("DynamoDB batch write left unprocessed items");
    }
  }

  async putMany(items: Item[]): Promise<void> {
    await this.batchWrite(items.map((Item) => ({ PutRequest: { Item } })));
  }

  async delete(key: Key): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: key }));
  }

  async deleteMany(keys: Key[]): Promise<void> {
    await this.batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
  }

  async scan(): Promise<Item[]> {
    const out: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new ScanCommand({ TableName: this.tableName, ExclusiveStartKey: start }));
      out.push(...((r.Items ?? []) as Item[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async add(key: Key, field: string, by: number, expiresAt: number): Promise<number> {
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: "ADD #f :by SET expiresAt = if_not_exists(expiresAt, :exp)",
        ExpressionAttributeNames: { "#f": field },
        ExpressionAttributeValues: { ":by": by, ":exp": expiresAt },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(r.Attributes?.[field] ?? 0);
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Item[]> {
    const values: Record<string, string> = { ":pk": pk };
    let cond = "pk = :pk";
    if (opts.prefix !== undefined) {
      cond += " AND begins_with(sk, :prefix)";
      values[":prefix"] = opts.prefix;
    } else if (opts.from !== undefined || opts.to !== undefined) {
      cond += " AND sk BETWEEN :from AND :to";
      values[":from"] = opts.from ?? "";
      values[":to"] = opts.to ?? "￿";
    }
    const out: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const input: QueryCommandInput = {
        TableName: this.tableName,
        KeyConditionExpression: cond,
        ExpressionAttributeValues: values,
        ScanIndexForward: !opts.descending,
        ExclusiveStartKey: start,
        ...(opts.limit !== undefined ? { Limit: opts.limit - out.length } : {}),
      };
      const r = await this.doc.send(new QueryCommand(input));
      out.push(...((r.Items ?? []) as Item[]));
      start = r.LastEvaluatedKey;
    } while (start && (opts.limit === undefined || out.length < opts.limit));
    return out;
  }
}
