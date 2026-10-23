import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {parseCSV, detectDelimiter, inferCSVType, csvHeaders, importCSV} from '../src/csv';
import {parsePlan, estimateWarning} from '../src/plans';
import {initialize, execute, schema} from '../src/database';
import {labs} from '../src/labs';

test('CSV parsing preserves quotes, BOM, embedded newlines, delimiters and empty final fields', () => {
  assert.deepEqual(parseCSV('\uFEFFname,note,empty\r\n"a,b","say ""hi""\nnext",\r\n'), [['name','note','empty'],['a,b','say "hi"\nnext','']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2', '\t'), [['a','b'],['1','2']]);
  assert.equal(detectDelimiter('"a,b";value\n1;2'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.throws(() => parseCSV('a,b\n1'), /列数/);
  assert.throws(() => parseCSV('"a"oops,b'), /引号/);
  assert.throws(() => parseCSV('"unterminated'), /未闭合/);
  assert.deepEqual(csvHeaders(['id', 'id', '', '字段'.repeat(50)]).slice(0,3), ['id','id_2','column_3']);
  assert.ok(new TextEncoder().encode(csvHeaders(['字段'.repeat(50)])[0]).length <= 63);
  assert.equal(inferCSVType(['001', '002']), 'text');
  assert.equal(inferCSVType(['2147483648','']), 'bigint');
  assert.equal(inferCSVType(['9223372036854775808']), 'numeric');
  assert.equal(inferCSVType(['1.23','2e3']), 'numeric');
  assert.equal(inferCSVType(['TRUE','false']), 'boolean');
});

test('external plans validate structure and metric values without executing their contents', () => {
  const plan = parsePlan('[{"Plan":{"Node Type":"Seq Scan","Plan Rows":100,"Actual Rows":1,"Actual Loops":10,"Filter":"<script>alert(1)</script>"}}]');
  assert.match(estimateWarning(plan.Plan)!, /100.0/);
  assert.equal(estimateWarning({...plan.Plan, 'Actual Loops':0}), null);
  assert.equal(parsePlan(JSON.stringify(plan)).Plan['Node Type'], 'Seq Scan');
  assert.equal(parsePlan('{"Node Type":"Result"}').Plan['Node Type'], 'Result');
  for (const invalid of ['{}', '[]', '[{},{}]', '{"Plan":{"Node Type":"X","Actual Rows":"5"}}', '{"Plan":{"Node Type":"X","Plans":{}}}']) assert.throws(() => parsePlan(invalid));
  let nested: any = {'Node Type':'Result'};
  for (let i = 0; i < 82; i++) nested = {'Node Type':'Result', Plans:[nested]};
  assert.throws(() => parsePlan(JSON.stringify({Plan:nested})), /80/);
});

test('real engine: richer schema, atomic CSV imports and independent optional labs', {timeout:60_000}, async t => {
  const db = await PGlite.create();
  try {
    await initialize(db);
    await t.test('sidebar sees indexes, foreign keys, nullability and defaults', async () => {
      await db.exec('CREATE TABLE schema_details (id int PRIMARY KEY, customer_id int REFERENCES customers(id), note text NOT NULL DEFAULT \'hello\', UNIQUE(note));');
      const table = (await schema(db)).find(item => item.name === 'schema_details')!;
      assert.ok(table.indexes!.some(item => item.definition.includes('UNIQUE INDEX')));
      assert.ok(table.constraints!.some(item => item.definition.includes('REFERENCES customers')));
      assert.equal(table.columns.find(item => item.name === 'note')!.nullable, false);
      assert.match(table.columns.find(item => item.name === 'note')!.default!, /hello/);
    });
    await t.test('CSV parameters and quoted identifiers preserve data, and failed imports roll back', async () => {
      await importCSV(db, {table:'csv " table', columns:[{name:'code',type:'text'},{name:'amount',type:'numeric'},{name:'note',type:'text'}], rows:[['001','123.45','a,"b"\nnext'],['002','','']], emptyAsNull:true});
      assert.deepEqual((await db.query('SELECT code, amount::text, note FROM "csv "" table" ORDER BY code')).rows, [{code:'001',amount:'123.45',note:'a,"b"\nnext'},{code:'002',amount:null,note:null}]);
      await assert.rejects(importCSV(db, {table:'failed_csv',columns:[{name:'n',type:'integer'}],rows:[['1'],['bad']],emptyAsNull:false}));
      assert.equal((await db.query<{t:string|null}>("SELECT to_regclass('failed_csv')::text AS t")).rows[0].t, null);
      await assert.rejects(importCSV(db, {table:'customers',columns:[{name:'x',type:'text'}],rows:[['keep']],emptyAsNull:true}), /already exists/);
      await db.exec('BEGIN');
      await assert.rejects(importCSV(db, {table:'in_transaction',columns:[{name:'n',type:'integer'}],rows:[['1']],emptyAsNull:false}), /COMMIT/);
      await db.exec('ROLLBACK');
    });
    await t.test('every lab step runs, can be reset, and leaves the initial data unchanged', async () => {
      for (const lab of labs) {
        for (const step of lab.steps) await execute(db, step.sql, step.mode ?? 'run');
        await execute(db, lab.steps[0].sql, 'run');
      }
      assert.deepEqual((await db.query('SELECT (SELECT count(*)::int FROM public.customers) AS customers, (SELECT count(*)::int FROM public.orders) AS orders')).rows, [{customers:1000,orders:20000}]);
    });
    await t.test('result metadata resolves readable PostgreSQL type names', async () => {
      const {results} = await execute(db, "SELECT 1::bigint AS id, '{\"a\":1}'::jsonb AS data, DATE '2025-01-01' AS day", 'run');
      assert.deepEqual(results[0].fields.map(field => field.type), ['bigint','jsonb','date']);
    });
  } finally { await db.close(); }
});
