// The kv.ts contract on one DynamoDB table (on-demand; pk and sk strings). Item = {pk, sk, v?, n?, d}; d is the JSON body,
// gzipped (binary) when large. Conditions: attribute_not_exists(pk) or v = :v. A multi-item write is TransactWriteItems.
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, QueryCommand, ScanCommand, TransactGetItemsCommand, TransactWriteItemsCommand, UpdateItemCommand,
  type AttributeValue, type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { bounds, decode, encode, WriteConflict, type Item, type Key, type Kv, type Op, type Stored } from './kv.ts';

type Av = Record<string, AttributeValue>;
const marshal = (s: Stored): Av => ({
  pk: { S: s.pk }, sk: { S: s.sk },
  ...(s.v === undefined ? {} : { v: { N: String(s.v) } }), ...(s.n === undefined ? {} : { n: { N: String(s.n) } }),
  ...(s.d === undefined ? {} : { d: typeof s.d === 'string' ? { S: s.d } : { B: s.d } }),
});
const unmarshal = (a: Av): Stored => ({
  pk: a.pk.S!, sk: a.sk.S!, ...(a.v ? { v: Number(a.v.N) } : {}), ...(a.n ? { n: Number(a.n.N) } : {}),
  ...(a.d ? { d: a.d.S ?? a.d.B! } : {}),
});
const keyOf = (k: Key): Av => ({ pk: { S: k.pk }, sk: { S: k.sk } });
const cond = (c: Op['if']) => c === undefined ? {} : c === 'absent'
  ? { ConditionExpression: 'attribute_not_exists(pk)' }
  : { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'v' }, ExpressionAttributeValues: { ':v': { N: String(c) } } };
const conflict = (e: unknown) => {
  const name = (e as Error).name;
  if (name === 'ConditionalCheckFailedException' || name === 'TransactionConflictException') return true;
  if (name === 'TransactionCanceledException') {
    const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
    return reasons.some((r) => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict');
  }
  return false;
};

export class DynamoKv implements Kv {
  readonly name = 'dynamodb';
  readonly owner = 'lambda';
  readonly client: DynamoDBClient;
  readonly table: string;
  constructor(table: string, o: { region?: string; endpoint?: string } = {}) {
    this.table = table;
    this.client = new DynamoDBClient({ region: o.region ?? process.env.AWS_REGION ?? 'us-east-1', ...(o.endpoint ? { endpoint: o.endpoint } : {}) });
  }
  alive() { return true; }   // can't tell a running Lambda from a dead one: PENDING work expires by its lease
  async get(k: Key) {
    const r = await this.client.send(new GetItemCommand({ TableName: this.table, Key: keyOf(k), ConsistentRead: true }));
    return r.Item && decode(unmarshal(r.Item));
  }
  async getMany(ks: Key[]) {
    const out: (Item | undefined)[] = [];
    for (let i = 0; i < ks.length; i += 100) {   // ponytail: serializable per 100; every read set here is far smaller
      try {
        const r = await this.client.send(new TransactGetItemsCommand({ TransactItems: ks.slice(i, i + 100).map((k) => ({ Get: { TableName: this.table, Key: keyOf(k), ProjectionExpression: 'pk, sk, v' } })) }));
        out.push(...(r.Responses ?? []).map((x) => (x.Item ? decode(unmarshal(x.Item)) : undefined)));
      } catch (e) { if (conflict(e)) throw new WriteConflict((e as Error).name); throw e; }
    }
    return out;
  }
  async query(pk: string, o: { prefix?: string; after?: string; limit?: number; desc?: boolean } = {}) {
    const [lo, hi] = bounds(o);
    const out: Item[] = [];
    let start: Av | undefined;
    do {
      const r = await this.client.send(new QueryCommand({
        TableName: this.table, ConsistentRead: true, ScanIndexForward: !o.desc, ExclusiveStartKey: start,
        ...(lo   // DynamoDB refuses an empty key value: a whole partition is the bare pk condition
          ? { KeyConditionExpression: 'pk = :pk AND sk BETWEEN :lo AND :hi', ExpressionAttributeValues: { ':pk': { S: pk }, ':lo': { S: lo }, ':hi': { S: hi } } }
          : { KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: pk } } }),
        ...(o.limit ? { Limit: o.limit - out.length } : {}),
      }));
      out.push(...(r.Items ?? []).map((x) => decode(unmarshal(x))));
      start = r.LastEvaluatedKey;
    } while (start && (!o.limit || out.length < o.limit));
    return out;
  }
  async write(ops: Op[]) {
    try {
      if (ops.length === 1 && !('check' in ops[0])) {
        const op = ops[0];
        if ('put' in op) await this.client.send(new PutItemCommand({ TableName: this.table, Item: marshal(encode(op.put)), ...cond(op.if) }));
        else await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: keyOf(op.del), ...cond(op.if) }));
        return;
      }
      const items: TransactWriteItem[] = ops.map((op) => 'put' in op ? { Put: { TableName: this.table, Item: marshal(encode(op.put)), ...cond(op.if) } }
        : 'del' in op ? { Delete: { TableName: this.table, Key: keyOf(op.del), ...cond(op.if) } }
          : { ConditionCheck: { TableName: this.table, Key: keyOf(op.check), ...cond(op.if) } as never });
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
    } catch (e) { if (conflict(e)) throw new WriteConflict((e as Error).name); throw e; }
  }
  async incr(k: Key) {
    const r = await this.client.send(new UpdateItemCommand({
      TableName: this.table, Key: keyOf(k), UpdateExpression: 'SET n = if_not_exists(n, :z) + :one',
      ExpressionAttributeValues: { ':z': { N: '0' }, ':one': { N: '1' } }, ReturnValues: 'UPDATED_NEW',
    }));
    return Number(r.Attributes!.n.N);
  }
  async *scan(): AsyncIterable<Item[]> {
    let start: Av | undefined;
    do {
      const r = await this.client.send(new ScanCommand({ TableName: this.table, ConsistentRead: true, ExclusiveStartKey: start }));
      yield (r.Items ?? []).map((x) => decode(unmarshal(x)));
      start = r.LastEvaluatedKey;
    } while (start);
  }
}
