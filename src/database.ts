import { PGlite } from '@electric-sql/pglite';
import { seedSQL } from './examples';
import { ROW_LIMIT, type Execution, type Result, type Table } from './model';

export async function initialize(db: PGlite) {
  const marker = await db.query<{ marker: string | null }>(`SELECT to_regclass('_playground.initialized')::text AS marker`);
  if (!marker.rows[0].marker) {
    await db.transaction(async tx => {
      const existing = await tx.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', '_playground')
        AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r', 'v', 'm', 'p', 'f') LIMIT 1`);
      if (!existing.rows.length) await tx.exec(seedSQL);
      await tx.exec(`CREATE SCHEMA IF NOT EXISTS _playground;
        CREATE TABLE _playground.initialized (version INTEGER NOT NULL);
        INSERT INTO _playground.initialized VALUES (1)`);
    });
  }
  await db.exec(`SET statement_timeout = '0'; SET lock_timeout = '5s'; SET work_mem = '8MB';`);
  return (await db.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0].version;
}

export async function schema(db: PGlite): Promise<Table[]> {
  const result = await db.query<{schema: string; name: string; kind: string; columns: Table['columns']}>(`
    SELECT n.nspname AS schema, c.relname AS name,
      CASE c.relkind WHEN 'v' THEN '视图' WHEN 'm' THEN '物化视图' ELSE '表' END AS kind,
      c.reltuples AS "estimatedRows",
      COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
        'nullable', NOT a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]') AS columns,
      COALESCE((SELECT json_agg(json_build_object('name', i.relname, 'definition', pg_get_indexdef(i.oid)) ORDER BY i.relname)
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid), '[]') AS indexes,
      COALESCE((SELECT json_agg(json_build_object('name', con.conname, 'definition', pg_get_constraintdef(con.oid)) ORDER BY con.conname)
        FROM pg_constraint con WHERE con.conrelid = c.oid), '[]') AS constraints
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', '_playground')
      AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY n.nspname, c.relname`);
  return result.rows;
}

export async function execute(db: PGlite, sql: string, mode: string): Promise<Execution> {
  if (!sql.trim()) throw Error('请先输入 SQL。');
  if (sql.length > 1_000_000) throw Error('SQL 超过 1 MB，请拆分后运行。');
  const notices: string[] = [];
  const options = {rowMode: 'array' as const, onNotice: (notice: {message?: string}) => { if (notice.message && notices.length < 30) notices.push(notice.message); }};
  const start = performance.now();
  try {
    let raw;
    if (mode === 'explain' || mode === 'analyze') {
      const prefix = mode === 'analyze' ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' : 'EXPLAIN (FORMAT JSON) ';
      if (mode === 'analyze') {
        if (db.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再运行 ANALYZE。');
        raw = [await db.transaction(async tx => {
          await tx.exec('SET TRANSACTION READ ONLY');
          return tx.query(prefix + sql, [], options);
        })];
      } else raw = [await db.query(prefix + sql, [], options)];
    } else raw = await db.exec(sql, options);
    const oids = [...new Set(raw.flatMap(result => result.fields.map(field => field.dataTypeID)))];
    const types = oids.length ? await db.query<{oid: number; name: string}>('SELECT oid::int AS oid, pg_catalog.format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])', [oids]) : {rows: []};
    const names = new Map(types.rows.map(type => [type.oid, type.name]));
    const results: Result[] = raw.map(result => ({
      fields: result.fields.map(field => ({...field, type: names.get(field.dataTypeID)})),
      rows: (result.rows as unknown[][]).slice(0, ROW_LIMIT),
      totalRows: result.rows.length,
      affectedRows: result.rowCount ?? (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(result.command || '') ? result.affectedRows : undefined),
      command: result.command
    }));
    return {results, elapsed: performance.now() - start, notices};
  } finally { /* PGlite flushes successful statements before resolving. */ }
}
