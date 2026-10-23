import type { DatabaseClient } from './client';
import type { BootInfo } from './connection';
import { CSV_LIMIT, csvTypes, csvHeaders, parseCSV, detectDelimiter, inferCSVType, validateCSVImport, type CSVImport, type CSVType } from './csv';
import { BACKUP_LIMIT, unpackBackup } from './backup';
import { quoteIdentifier } from './model';
import { el, downloadFile } from './ui';

export function installDataTools(hooks: {
  db: DatabaseClient; busy: () => boolean; ready: () => boolean;
  setBusy: (value: boolean) => void; refresh: () => Promise<void>;
  restored: (info: BootInfo) => void; replaceSQL: (sql: string) => void;
}) {
  const $ = (id: string) => document.getElementById(id)!;
  const feedback = $('data-feedback');
  function message(text: string, error = false) { feedback.hidden = false; feedback.classList.toggle('error', error); feedback.textContent = text; }
  const dialog = $('csv-dialog') as HTMLDialogElement;
  const file = $('csv-file') as HTMLInputElement;
  const delimiter = $('csv-delimiter') as HTMLSelectElement;
  const encoding = $('csv-encoding') as HTMLSelectElement;
  const header = $('csv-header') as HTMLInputElement;
  const table = $('csv-table') as HTMLInputElement;
  const empty = $('csv-empty-null') as HTMLInputElement;
  const csvError = $('csv-error');
  const confirm = $('confirm-csv-import') as HTMLButtonElement;
  let csvText = '', csvBytes = new Uint8Array(), rows: string[][] = [], names: string[] = [], types: CSVType[] = [];
  function decode() {
    try { csvText = new TextDecoder(encoding.value, {fatal: true}).decode(csvBytes); }
    catch { throw Error('文件编码不匹配，请切换编码后重试。Excel 导出的中文文件可尝试 GB18030 / GBK。'); }
  }
  function preview() {
    const container = $('csv-preview'); container.replaceChildren();
    csvError.hidden = true; confirm.disabled = true;
    try {
      decode();
      const parsed = parseCSV(csvText, delimiter.value);
      names = header.checked ? csvHeaders(parsed[0]) : parsed[0].map((_, i) => `column_${i + 1}`);
      rows = parsed.slice(header.checked ? 1 : 0);
      if (!rows.length) throw Error('CSV 只有表头，没有数据。');
      types = names.map((_, i) => inferCSVType(rows.map(row => row[i])));
      $('csv-count').textContent = `${rows.length.toLocaleString()} 行 · ${names.length} 列 · 预览前 10 行。字段类型根据全部数据推断，可逐列调整。`;
      const previewTable = el('table', 'result-table csv-preview-table');
      const thead = el('thead'); const heading = el('tr');
      names.forEach((name, i) => {
        const th = el('th'); const label = el('input'); label.value = name; label.setAttribute('aria-label', `第 ${i + 1} 列名称`);
        label.addEventListener('input', () => { names[i] = label.value; });
        const select = el('select'); select.setAttribute('aria-label', `第 ${i + 1} 列类型`);
        csvTypes.forEach(type => { const option = el('option', '', type); option.value = type; select.append(option); });
        select.value = types[i]; select.addEventListener('change', () => { types[i] = select.value as CSVType; });
        th.append(label, select); heading.append(th);
      });
      thead.append(heading); previewTable.append(thead);
      const body = el('tbody');
      rows.slice(0, 10).forEach(row => { const tr = el('tr'); row.forEach(value => tr.append(el('td', '', value.length > 200 ? value.slice(0, 200) + '…' : value))); body.append(tr); });
      previewTable.append(body); container.append(previewTable); confirm.disabled = false;
    } catch (e) { rows = []; $('csv-count').textContent = ''; csvError.hidden = false; csvError.textContent = (e as Error).message; }
  }
  $('import-csv').addEventListener('click', () => { if (!hooks.busy() && hooks.ready()) file.click(); });
  file.addEventListener('change', async () => {
    try {
      const selected = file.files?.[0]; if (!selected || hooks.busy()) return;
      if (selected.size > CSV_LIMIT) throw Error('CSV 文件不能超过 10 MB。');
      csvBytes = new Uint8Array(await selected.arrayBuffer());
      encoding.value = csvBytes[0] === 255 && csvBytes[1] === 254 ? 'utf-16le' : csvBytes[0] === 254 && csvBytes[1] === 255 ? 'utf-16be' : 'utf-8';
      try { decode(); delimiter.value = detectDelimiter(csvText); } catch { delimiter.value = ','; }
      header.checked = true; empty.checked = true;
      table.value = selected.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 24) || 'imported_data';
      preview(); dialog.showModal();
    } catch (e) { message((e as Error).message, true); }
    finally { file.value = ''; }
  });
  delimiter.addEventListener('change', preview); header.addEventListener('change', preview);
  encoding.addEventListener('change', () => { try { decode(); delimiter.value = detectDelimiter(csvText); } catch { /* preview displays decoding errors. */ } preview(); });
  confirm.addEventListener('click', async () => {
    if (hooks.busy() || !hooks.ready()) return;
    const input: CSVImport = {table: table.value.trim(), columns: names.map((name, i) => ({name, type: types[i]})), rows, emptyAsNull: empty.checked};
    try { validateCSVImport(input); }
    catch (e) { csvError.hidden = false; csvError.textContent = (e as Error).message; return; }
    hooks.setBusy(true); confirm.disabled = true;
    csvError.hidden = true;
    $('csv-count').textContent = '正在导入，完成后会显示表结构…';
    try {
      const result = await hooks.db.call<{table: string; rows: number}>('csv-import', input);
      await hooks.refresh(); dialog.close();
      hooks.replaceSQL(`SELECT *\nFROM public.${quoteIdentifier(result.table)}\nLIMIT 100;`);
      message(`已导入 public.${result.table}：${result.rows.toLocaleString()} 行。预览 SQL 已载入，点击运行查看。`);
    } catch (e) {
      csvError.hidden = false; csvError.textContent = `导入失败，未创建或覆盖表：${(e as Error).message}`;
      $('csv-count').textContent = `${rows.length.toLocaleString()} 行待导入，可修改类型或表名后重试。`;
    } finally { hooks.setBusy(false); confirm.disabled = false; }
  });
  // Keep the transaction visible until it completes, including when Escape is pressed.
  dialog.addEventListener('cancel', event => { if (hooks.busy()) event.preventDefault(); });
  $('csv-cancel').addEventListener('click', () => { if (!hooks.busy()) dialog.close(); });

  $('backup-database').addEventListener('click', async () => {
    if (hooks.busy() || !hooks.ready()) return;
    hooks.setBusy(true); message('正在创建完整数据库备份…');
    try {
      const backup = await hooks.db.call<Blob>('backup');
      downloadFile(backup, `pg-playground-${new Date().toISOString().slice(0, 10)}.pgbackup`);
      message('完整数据库备份已生成，包含表、数据、索引和已安装扩展；请保留下载的 .pgbackup 文件。');
    } catch (e) { message((e as Error).message, true); }
    finally { hooks.setBusy(false); }
  });
  const restoreFile = $('backup-file') as HTMLInputElement;
  const restoreDialog = $('restore-dialog') as HTMLDialogElement;
  const restoreError = $('restore-error');
  const restoreConfirm = $('confirm-restore') as HTMLButtonElement;
  let selectedBackup: File | null = null;
  $('restore-database').addEventListener('click', () => { if (!hooks.busy() && hooks.ready()) restoreFile.click(); });
  restoreFile.addEventListener('change', async () => {
    const selected = restoreFile.files?.[0]; restoreFile.value = '';
    if (!selected || hooks.busy()) return;
    selectedBackup = null;
    hooks.setBusy(true); message('正在校验备份文件…');
    try {
      if (selected.size > BACKUP_LIMIT + 4096) throw Error('备份文件超过 128 MB。');
      const {metadata} = await unpackBackup(selected);
      selectedBackup = selected;
      $('restore-info').textContent = `${selected.name}\n备份时间：${new Date(metadata.created).toLocaleString('zh-CN')}\nPostgreSQL ${metadata.postgres} · PGlite ${metadata.engine}\n快照大小：${(metadata.size / 1024 / 1024).toFixed(1)} MB`;
      restoreError.hidden = true; feedback.hidden = true; restoreDialog.showModal();
    } catch (e) { message((e as Error).message, true); }
    finally { hooks.setBusy(false); }
  });
  restoreConfirm.addEventListener('click', async () => {
    if (!selectedBackup || hooks.busy() || !hooks.ready()) return;
    hooks.setBusy(true); restoreConfirm.disabled = true; restoreError.hidden = true;
    $('restore-status').textContent = '正在验证数据库并恢复，请保持页面打开…';
    try {
      const info = await hooks.db.call<BootInfo>('restore', {file: selectedBackup});
      hooks.restored(info); restoreDialog.close(); selectedBackup = null;
      message('数据库已恢复。表、数据、索引和扩展来自备份；编辑器草稿和历史记录保持原样。');
    } catch (e) { restoreError.hidden = false; restoreError.textContent = (e as Error).message; await hooks.refresh(); }
    finally { hooks.setBusy(false); restoreConfirm.disabled = false; $('restore-status').textContent = ''; }
  });
  restoreDialog.addEventListener('cancel', event => { if (hooks.busy()) event.preventDefault(); });
  $('restore-cancel').addEventListener('click', () => { if (!hooks.busy()) restoreDialog.close(); });
}
