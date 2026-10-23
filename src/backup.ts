export const BACKUP_ENGINE = '0.5.11';
export const BACKUP_LIMIT = 128 * 1024 * 1024;
const MAGIC = 'PG-PLAYGROUND-BACKUP-1\n';
export interface BackupMetadata { format: 1; engine: string; postgres: string; created: string; size: number; sha256: string }
async function digest(blob: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
}
export async function packBackup(snapshot: Blob, postgres: string): Promise<Blob> {
  if (snapshot.size > BACKUP_LIMIT) throw Error('数据库快照超过 128 MB，请缩小数据规模后备份。');
  const meta: BackupMetadata = {format: 1, engine: BACKUP_ENGINE, postgres, created: new Date().toISOString(), size: snapshot.size, sha256: await digest(snapshot)};
  return new Blob([MAGIC, JSON.stringify(meta), '\n', snapshot], {type: 'application/octet-stream'});
}
export async function unpackBackup(file: Blob): Promise<{metadata: BackupMetadata; snapshot: Blob}> {
  if (file.size > BACKUP_LIMIT + 4096) throw Error('备份文件超过 128 MB。');
  const prefix = await file.slice(0, 4096).text();
  if (!prefix.startsWith(MAGIC)) throw Error('请选择本实验台导出的 .pgbackup 文件。');
  const end = prefix.indexOf('\n', MAGIC.length);
  let metadata: BackupMetadata;
  try { metadata = JSON.parse(prefix.slice(MAGIC.length, end)); } catch { throw Error('备份文件头已损坏。'); }
  if (end < 0 || !metadata || metadata.format !== 1 || metadata.engine !== BACKUP_ENGINE || typeof metadata.postgres !== 'string' || !/^\d+\.\d+/.test(metadata.postgres) || !Number.isInteger(metadata.size) || metadata.size <= 0 || metadata.size > BACKUP_LIMIT || typeof metadata.created !== 'string' || !Number.isFinite(Date.parse(metadata.created)) || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw Error('备份格式或引擎版本不兼容，需要 PGlite ' + BACKUP_ENGINE + ' 的备份。');
  const offset = new TextEncoder().encode(prefix.slice(0, end + 1)).length;
  const snapshot = file.slice(offset);
  if (snapshot.size !== metadata.size || await digest(snapshot) !== metadata.sha256) throw Error('备份校验失败，文件可能被截断或损坏；数据库未修改。');
  return {metadata, snapshot};
}
