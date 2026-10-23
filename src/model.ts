export interface Column { name: string; type: string; nullable?: boolean; default?: string | null }
export interface Table { schema: string; name: string; kind: string; columns: Column[]; indexes?: {name: string; definition: string}[]; constraints?: {name: string; definition: string}[]; estimatedRows?: number }
export interface Result {
  fields: { name: string; dataTypeID: number; type?: string }[];
  rows: unknown[][];
  totalRows: number;
  affectedRows?: number;
  command?: string;
}
export interface Execution { results: Result[]; elapsed: number; notices: string[] }
export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}
export interface Plan { Plan: PlanNode; 'Planning Time'?: number; 'Execution Time'?: number; [key: string]: unknown }
export interface HistoryEntry { sql: string; mode: string; at: string; elapsed: number; ok: boolean }
export const DATABASE_NAME = 'neil-pg-playground-v1';
export const DATABASE_IDB_NAME = '/pglite/' + DATABASE_NAME;
export const ROW_LIMIT = 1000;
export const quoteIdentifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export function cellText(value: unknown, dataTypeID?: number): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dataTypeID === 1082 ? value.toISOString().slice(0, 10) : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function toCSV(result: Result): string {
  const quote = (value: unknown, oid?: number) => '"' + cellText(value, oid).replaceAll('"', '""') + '"';
  return '\uFEFF' + [result.fields.map(f => quote(f.name)).join(','), ...result.rows.map(row => row.map((value, index) => quote(value, result.fields[index]?.dataTypeID)).join(','))].join('\r\n');
}
export function planFrom(result: Result): Plan | null {
  if (result.fields.length !== 1 || result.fields[0].name !== 'QUERY PLAN') return null;
  const value = result.rows[0]?.[0];
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(data) && data[0]?.Plan ? data[0] as Plan : null;
  } catch { return null; }
}
