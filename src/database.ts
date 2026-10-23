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
      COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]') AS columns
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
    const results: Result[] = raw.map(result => ({
      fields: result.fields,
      rows: (result.rows as unknown[][]).slice(0, ROW_LIMIT),
      totalRows: result.rows.length,
      affectedRows: result.rowCount ?? (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(result.command || '') ? result.affectedRows : undefined),
      command: result.command
    }));
    return {results, elapsed: performance.now() - start, notices};
  } finally { /* PGlite flushes successful statements before resolving. */ }
}
