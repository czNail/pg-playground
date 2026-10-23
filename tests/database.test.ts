import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initialize, execute, schema} from '../src/database.ts';
import {planFrom, toCSV, quoteIdentifier, type PlanNode} from '../src/model.ts';

test('real PostgreSQL: learning workspace, execution and plan analysis', async t => {
  const db = await PGlite.create();
  try {
    await t.test('initialization is atomic and does not duplicate seed data on reconnect', async () => {
      assert.match(await initialize(db), /^\d+\./); await initialize(db);
      const result = await db.query('SELECT (SELECT count(*)::int FROM customers) AS customers, (SELECT count(*)::int FROM orders) AS orders');
      assert.deepEqual(result.rows, [{customers: 1000, orders: 20000}]);
      assert.deepEqual((await schema(db)).map(t => t.name), ['customers', 'orders']);
    });
    await t.test('multiple statements and duplicate column names preserve positional values', async () => {
      const execution = await execute(db, 'CREATE TABLE "test table" (id int); INSERT INTO "test table" VALUES (7); SELECT id AS value, 9 AS value FROM "test table";', 'run');
      assert.equal(execution.results.length, 3);
      assert.deepEqual(execution.results[2].rows, [[7, 9]]);
      assert.deepEqual(execution.results[2].fields.map(f => f.name), ['value', 'value']);
      assert.ok((await schema(db)).some(table => table.name === 'test table'));
    });
    await t.test('result preview is bounded and reports the full returned count', async () => {
      const {results} = await execute(db, 'SELECT * FROM generate_series(1, 1500)', 'run');
      assert.equal(results[0].rows.length, 1000);
      assert.equal(results[0].totalRows, 1500);
    });
    await t.test('creating an index changes a real query plan', async () => {
      const query = 'SELECT * FROM orders WHERE customer_id = 42';
      const before = planFrom((await execute(db, query, 'explain')).results[0])!;
      assert.equal(before.Plan['Node Type'], 'Seq Scan');
      await execute(db, 'CREATE INDEX idx_orders_customer_id ON orders(customer_id); ANALYZE orders;', 'run');
      const after = planFrom((await execute(db, query, 'analyze')).results[0])!;
      const types = (node: PlanNode): string[] => [node['Node Type'], ...(node.Plans || []).flatMap(types)];
      assert.ok(types(after.Plan).some(type => type.includes('Index')));
      assert.ok(after['Execution Time'] !== undefined);
    });
    await t.test('ANALYZE rejects writes, preserves user transactions and recovers after errors', async () => {
      await assert.rejects(execute(db, 'DELETE FROM orders', 'analyze'), /read-only transaction/);
      assert.equal((await db.query<{n: number}>('SELECT count(*)::int AS n FROM orders')).rows[0].n, 20000);
      await execute(db, 'BEGIN', 'run');
      await assert.rejects(execute(db, 'SELECT 1', 'analyze'), /COMMIT/);
      await execute(db, 'ROLLBACK', 'run');
      await assert.rejects(execute(db, 'SELECT no_such_column FROM orders', 'run'));
      assert.deepEqual((await execute(db, 'SELECT 1 AS ok', 'run')).results[0].rows, [[1]]);
    });
    await t.test('notices are captured and quotes, nulls and multiline text export correctly', async () => {
      const {notices} = await execute(db, "DO $$ BEGIN RAISE NOTICE 'hello'; END $$", 'run');
      assert.ok(notices.includes('hello'));
      const {results} = await execute(db, `SELECT E'a,"b"\\nc' AS content, NULL AS empty`, 'run');
      assert.equal(toCSV(results[0]), '\uFEFF"content","empty"\r\n"a,""b""\nc",""');
      assert.equal(quoteIdentifier('a"b'), '"a""b"');
    });
  } finally { await db.close(); }
});
