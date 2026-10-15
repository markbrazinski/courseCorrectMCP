// TEST-ONLY: create the shared test table in DynamoDB Local (npm run test:dynamodb-local). Same key schema as the deployed
// table (infra/data.yaml). DynamoDB Local is an emulation: it checks request shapes and condition semantics, not the
// deployed service's behaviour (consistency, throttling, IAM, limits).
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

// Two tables, as deployed: the workspace table and the knowledge table (2026-10-11).
const endpoint = process.env.CC_TEST_DYNAMO_ENDPOINT ?? 'http://127.0.0.1:8000', table = process.env.CC_TEST_DYNAMO_TABLE ?? 'cc-test';
const db = new DynamoDBClient({ endpoint, region: 'us-east-1' });
for (const TableName of [table, process.env.CC_TEST_KNOWLEDGE_TABLE ?? `${table}-knowledge`]) {
  try { await db.send(new DescribeTableCommand({ TableName })); console.log(`${TableName} exists at ${endpoint}`); }
  catch {
    await db.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }));
    console.log(`created ${TableName} at ${endpoint}`);
  }
}
