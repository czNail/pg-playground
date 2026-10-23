import type { PGlite } from '@electric-sql/pglite';
import { quoteIdentifier } from './model';

export const CSV_LIMIT = 10 * 1024 * 1024;
export const csvTypes = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp'] as const;
export type CSVType = typeof csvTypes[number];
export interface CSVImport { table: string; columns: {name: string; type: CSVType}[]; rows: string[][]; emptyAsNull: boolean }

/** RFC 4180 quoting, including newlines and escaped quotes. Empty cells stay strings until import. */
export function parseCSV(source: string, delimiter = ','): string[][] {
  if (![',', ';', '\t'].includes(delimiter)) throw Error('不支持的分隔符。');
  if (new TextEncoder().encode(source).length > CSV_LIMIT) throw Error('CSV 文件不能超过 10 MB。');
  const text = source.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false, count = 0;
  function pushField() { row.push(field); field = ''; closed = false; if (++count > 1_000_000 || row.length > 100) throw Error('CSV 最多 100 列、100 万个单元格。'); }
  function pushRow() { pushField(); rows.push(row); row = []; if (rows.length > 100_001) throw Error('CSV 最多 100,000 行数据。'); }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += ch;
    } else if (ch === delimiter) pushField();
    else if (ch === '\r' || ch === '\n') { pushRow(); if (ch === '\r' && text[i + 1] === '\n') i++; }
    else if (ch === '"' && !field && !closed) quoted = true;
    else { if (closed || ch === '"') throw Error(`CSV 第 ${rows.length + 1} 行的引号格式不正确。`); field += ch; }
  }
  if (quoted) throw Error('CSV 有未闭合的引号。');
  if (field || row.length || closed) pushRow();
  if (!rows.length) throw Error('CSV 没有数据。');
  const width = rows[0].length;
  if (rows.some(row => row.length !== width)) throw Error('CSV 各行列数不一致，请检查分隔符与引号。');
  return rows;
}
export function detectDelimiter(source: string): string {
  const counts = new Map([[',', 0], [';', 0], ['\t', 0]]);
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') { if (quoted && source[i + 1] === '"') i++; else quoted = !quoted; }
    if (!quoted && (ch === '\r' || ch === '\n')) break;
    if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}
export function inferCSVType(values: string[]): CSVType {
  const data = values.filter(v => v !== '');
  if (!data.length) return 'text';
  if (data.every(v => /^(true|false)$/i.test(v))) return 'boolean';
  // Preserve account numbers, postcodes and other values with leading zeroes.
  if (data.every(v => /^-?(0|[1-9]\d*)$/.test(v))) {
    if (data.some(v => v.length > 20)) return 'numeric';
    if (data.every(v => BigInt(v) >= -2147483648n && BigInt(v) <= 2147483647n)) return 'integer';
    if (data.every(v => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n)) return 'bigint';
    return 'numeric';
  }
  if (data.every(v => /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v))) return 'numeric';
  if (data.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)))) return 'date';
  return 'text';
}
export function csvHeaders(row: string[]): string[] {
  const used = new Set<string>();
  return row.map((value, i) => {
    let name = value.trim() || `column_${i + 1}`;
    while (new TextEncoder().encode(name).length > 55) name = name.slice(0, -1);
    const base = name; let suffix = 1;
    while (used.has(name)) name = `${base}_${++suffix}`;
    used.add(name); return name;
  });
}
export function validateCSVImport(input: CSVImport) {
  const validName = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0') && new TextEncoder().encode(value).length <= 63;
  if (!validName(input.table)) throw Error('表名不能为空，且不能超过 63 字节。');
  if (!Array.isArray(input.columns) || !input.columns.length || input.columns.length > 100 || input.columns.some(c => !validName(c.name) || !csvTypes.includes(c.type))) throw Error('请检查列名和字段类型。');
  if (new Set(input.columns.map(c => c.name)).size !== input.columns.length) throw Error('列名不能重复。');
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100_000 || input.rows.length * input.columns.length > 1_000_000 || input.rows.some(r => !Array.isArray(r) || r.length !== input.columns.length || r.some(v => typeof v !== 'string' || v.includes('\0')))) throw Error('CSV 数据行数、列数或内容无效。');
  if (new TextEncoder().encode(input.rows.flat().join('')).length > CSV_LIMIT) throw Error('CSV 数据不能超过 10 MB。');
}
export async function importCSV(db: PGlite, input: CSVImport) {
  validateCSVImport(input);
  if (db.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再导入 CSV。');
  const table = `public.${quoteIdentifier(input.table)}`;
  await db.transaction(async tx => {
    await tx.exec(`CREATE TABLE ${table} (${input.columns.map(c => `${quoteIdentifier(c.name)} ${c.type}`).join(', ')})`);
    const chunk = Math.max(1, Math.floor(1000 / input.columns.length));
    for (let start = 0; start < input.rows.length; start += chunk) {
      const params: (string | null)[] = [];
      const tuples = input.rows.slice(start, start + chunk).map(row => '(' + row.map(v => { params.push(input.emptyAsNull && v === '' ? null : v); return `$${params.length}`; }).join(',') + ')');
      await tx.query(`INSERT INTO ${table} VALUES ${tuples.join(',')}`, params);
    }
    await tx.exec(`ANALYZE ${table}`);
  });
  return {table: input.table, rows: input.rows.length};
}
