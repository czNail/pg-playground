import './style.css';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { DatabaseClient } from './client';
import { QueryInterruptedError } from './connection';
import { examples } from './examples';
import { cellText, quoteIdentifier, toCSV, planFrom, ROW_LIMIT, type Execution, type Result, type Table, type HistoryEntry, type Plan, type PlanNode } from './model';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text: string, className: string, action: () => void) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

const DRAFT_KEY = 'pg-playground:v1:draft';
const HISTORY_KEY = 'pg-playground:v1:history';
const db = new DatabaseClient();
let busy = false;
let ready = false;
let results: Result[] = [];
let selectedResult = 0;
let page = 0;
let currentPlan: Plan | null = null;
let planJSON = false;
let notices: string[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let history: HistoryEntry[] = [];
let storedDraft: string | null = null;
let draftTimer: ReturnType<typeof setTimeout>;
try {
  storedDraft = localStorage.getItem(DRAFT_KEY);
  const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  if (Array.isArray(parsed)) history = parsed.filter(item => item && typeof item.sql === 'string' && item.sql.length <= 50_000 && typeof item.at === 'string' && typeof item.ok === 'boolean' && typeof item.elapsed === 'number' && typeof item.mode === 'string').slice(0, 30);
} catch { /* SQL remains usable if browser storage is restricted. */ }

function toast(message: string) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, editor.state.doc.toString());
    $('draft-indicator').classList.remove('error');
    $('draft-indicator').title = '草稿已自动保存';
  } catch {
    $('draft-indicator').classList.add('error');
    $('draft-indicator').title = '草稿未能保存，请使用“保存 SQL”下载';
  }
}
const language = new Compartment();
const editor = new EditorView({
  parent: $('editor'),
  state: EditorState.create({
    doc: storedDraft?.slice(0, 1_000_000) ?? examples[0].sql,
    extensions: [
      basicSetup,
      language.of(sql({dialect: PostgreSQL, upperCaseKeywords: true})),
      syntaxHighlighting(HighlightStyle.define([
        {tag: tags.keyword, color: 'var(--site-accent)', fontWeight: '600'},
        {tag: tags.comment, color: 'var(--site-muted)', fontStyle: 'italic'},
        {tag: [tags.string, tags.number], color: 'var(--site-warning)'},
        {tag: tags.operator, color: 'var(--site-accent)'},
        {tag: tags.typeName, color: 'var(--site-success)'}
      ])),
      Prec.high(keymap.of([
        {key: 'Ctrl-Enter', run: () => { void run('run'); return true; }},
        {key: 'Meta-Enter', run: () => { void run('run'); return true; }},
        indentWithTab
      ])),
      EditorView.contentAttributes.of({'aria-label': 'SQL 代码', spellcheck: 'false'}),
      EditorView.updateListener.of(update => {
        const position = update.state.selection.main.head;
        const line = update.state.doc.lineAt(position);
        $('editor-position').textContent = `Ln ${line.number}, Col ${position - line.from + 1}`;
        if (update.docChanged) {
          clearTimeout(draftTimer);
          draftTimer = setTimeout(saveDraft, 300);
          document.querySelectorAll('.example-button.active').forEach(node => node.classList.remove('active'));
        }
      })
    ]
  })
});

function replaceSQL(value: string) {
  editor.dispatch({changes: {from: 0, to: editor.state.doc.length, insert: value}, selection: {anchor: 0}});
  saveDraft();
  editor.focus();
}
examples.forEach((example, index) => {
  const node = button('', 'example-button', () => {
    replaceSQL(example.sql);
    node.classList.add('active');
    toast(example.hint);
  });
  node.title = example.hint;
  node.append(element('span', 'example-number', String(index + 1).padStart(2, '0')), element('span', '', example.name));
  if (!storedDraft && !index) node.classList.add('active');
  $('examples').append(node);
});

function setBusy(value: boolean) {
  busy = value;
  document.querySelectorAll<HTMLButtonElement>('[data-db-action]').forEach(node => { node.disabled = value || !ready; });
  $('run-label').textContent = value ? '执行中…' : '运行 SQL';
  $('editor').setAttribute('aria-busy', String(value));
  $('query-timeout').toggleAttribute('disabled', value);
  if (!value) { $('stop-query').hidden = true; $('run').hidden = false; }
  $('retry').toggleAttribute('disabled', value);
  $('memory-mode').toggleAttribute('disabled', value);
}
db.onActivity = activity => {
  $('stop-query').hidden = activity === 'idle';
  $('stop-query').toggleAttribute('disabled', !db.canCancel);
  $('run').hidden = activity !== 'idle';
  if (activity === 'recovering') {
    $('stop-query').textContent = '正在恢复…';
    $('execution-summary').textContent = '正在恢复数据库连接…';
    $('connection-status').textContent = '正在恢复数据库连接…';
    $('connection-dot').className = 'connection-dot';
  } else {
    $('stop-query').textContent = activity === 'saving' ? '正在保存…' : '停止查询';
  }
};
function connectionError(error: unknown) {
  ready = false;
  $('connection-error').hidden = false;
  $('connection-error-text').textContent = error instanceof Error ? error.message : String(error);
  $('connection-status').textContent = '数据库未连接';
  $('connection-dot').className = 'connection-dot error';
  if (!$('schema-list').querySelector('.table-entry')) $('schema-list').replaceChildren(element('p', 'subtle loading-copy', '连接后显示表结构。'));
  setBusy(false);
}
function renderSchema(tables: Table[]) {
  $('table-count').textContent = String(tables.length);
  $('schema-list').replaceChildren();
  const completions: Record<string, string[]> = {};
  for (const table of tables) {
    const qualified = quoteIdentifier(table.schema) + '.' + quoteIdentifier(table.name);
    completions[`${table.schema}.${table.name}`] = table.columns.map(column => column.name);
    if (table.schema === 'public') completions[table.name] = table.columns.map(column => column.name);
    const details = element('details', 'table-entry');
    const summary = element('summary');
    summary.title = `${table.schema}.${table.name}`;
    summary.append(element('span', 'table-icon', '▦'), element('span', 'table-name', table.schema === 'public' ? table.name : `${table.schema}.${table.name}`), element('span', 'table-kind', table.kind));
    details.append(summary);
    for (const column of table.columns) {
      const row = element('div', 'table-column');
      row.append(element('span', '', column.name), element('small', '', column.type));
      details.append(row);
    }
    details.append(button('预览前 100 行 ↗', 'preview-table', () => replaceSQL(`SELECT *\nFROM ${qualified}\nLIMIT 100;`)));
    $('schema-list').append(details);
  }
  if (!tables.length) $('schema-list').append(element('p', 'subtle loading-copy', '还没有表，写一条 CREATE TABLE 开始。'));
  editor.dispatch({effects: language.reconfigure(sql({dialect: PostgreSQL, schema: completions, upperCaseKeywords: true}))});
}
async function refreshSchema() {
  try { renderSchema(await db.call<Table[]>('schema')); }
  catch (error) { toast('表结构暂未更新：' + (error as Error).message); }
}
async function connect(mode = 'persistent') {
  if (busy) return;
  ready = false;
  setBusy(true);
  $('connection-status').textContent = '正在启动数据库…';
  $('connection-dot').className = 'connection-dot';
  $('connection-error').hidden = true;
  try {
    const info = await db.start(mode);
    renderSchema(info.tables);
    ready = true;
    $('connection-status').textContent = mode === 'memory' ? '临时数据库已就绪' : '本地数据库已就绪';
    $('connection-dot').className = 'connection-dot ready';
    $('engine-version').textContent = `PostgreSQL ${info.version} · PGlite 0.5.11`;
    $('storage-mode').textContent = mode === 'memory' ? '临时模式，关闭后丢失' : '保存在当前浏览器';
    $('persistence-note').textContent = mode === 'memory' ? '临时模式：数据库在页面关闭或刷新后消失；SQL 草稿与历史记录仍尝试保存在当前浏览器。' : '数据库、SQL 草稿和历史记录保存在当前浏览器；清理网站数据会将它们删除。';
  } catch (error) { connectionError(error); }
  finally { setBusy(false); }
}

const tabNames = ['results', 'plan', 'history'];
function showTab(name: string) {
  for (const tab of tabNames) {
    const active = name === tab;
    $('tab-' + tab).setAttribute('aria-selected', String(active));
    $('tab-' + tab).tabIndex = active ? 0 : -1;
    $(tab + '-panel').hidden = !active;
  }
}
tabNames.forEach((name, index) => {
  $('tab-' + name).addEventListener('click', () => showTab(name));
  $('tab-' + name).addEventListener('keydown', event => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabNames.length;
    else if (event.key === 'ArrowLeft') next = (index + tabNames.length - 1) % tabNames.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabNames.length - 1;
    else return;
    event.preventDefault(); showTab(tabNames[next]); $('tab-' + tabNames[next]).focus();
  });
});
function emptyPanel(panel: HTMLElement, title: string, text: string) {
  const empty = element('div', 'empty-state');
  empty.append(element('strong', '', title), element('p', '', text));
  panel.replaceChildren(empty);
}
function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const link = element('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderResults() {
  const panel = $('results-panel');
  panel.replaceChildren();
  const current = results[selectedResult];
  if (!current) { emptyPanel(panel, '没有返回结果', '输入 SQL 后点击“运行 SQL”。'); return; }
  const controls = element('div', 'result-controls');
  const choices = element('div', 'result-choices');
  results.forEach((result, index) => {
    const node = button(`${index + 1} · ${result.command || (result.fields.length ? '结果集' : '完成')}`, 'result-choice', () => { selectedResult = index; page = 0; renderResults(); });
    node.setAttribute('aria-pressed', String(selectedResult === index)); choices.append(node);
  });
  controls.append(choices);
  if (current.fields.length) controls.append(button('导出 CSV ↓', 'text-button', () => download(toCSV(current), 'query-result.csv', 'text/csv;charset=utf-8')));
  panel.append(controls);
  if (!current.fields.length) {
    const message = element('div', 'success-message');
    message.append(element('strong', '', '✓ 执行完成'), element('span', '', current.affectedRows !== undefined ? ` · 影响 ${current.affectedRows.toLocaleString()} 行` : ''));
    panel.append(message);
  } else {
    const scroll = element('div', 'table-scroll');
    const table = element('table', 'result-table');
    const thead = element('thead');
    const headers = element('tr');
    const numberHeader = element('th', 'row-number', '#'); numberHeader.scope = 'col'; headers.append(numberHeader);
    current.fields.forEach(field => { const th = element('th', '', field.name); th.scope = 'col'; th.title = `PostgreSQL 类型 OID: ${field.dataTypeID}`; headers.append(th); });
    thead.append(headers); table.append(thead);
    const body = element('tbody');
    current.rows.slice(page * 100, (page + 1) * 100).forEach((row, index) => {
      const tr = element('tr');
      tr.append(element('td', 'row-number', String(page * 100 + index + 1)));
      current.fields.forEach((_, column) => {
        const value = row[column];
        const text = cellText(value, current.fields[column].dataTypeID);
        const td = element('td', value === null ? 'null-cell' : '', value === null ? 'NULL' : text.length > 500 ? text.slice(0, 500) + '…' : text);
        if (text.length > 80) td.title = text.slice(0, 4000);
        tr.append(td);
      });
      body.append(tr);
    });
    if (!current.rows.length) { const tr = element('tr'); const td = element('td', 'subtle', '查询成功，没有匹配的行。'); td.colSpan = current.fields.length + 1; tr.append(td); body.append(tr); }
    table.append(body); scroll.append(table); panel.append(scroll);
    const footer = element('div', 'result-footer');
    footer.append(element('span', '', current.totalRows > ROW_LIMIT ? `返回 ${current.totalRows.toLocaleString()} 行 · 仅展示、导出前 ${ROW_LIMIT.toLocaleString()} 行` : `共 ${current.totalRows.toLocaleString()} 行`));
    if (current.rows.length > 100) {
      const pages = Math.ceil(current.rows.length / 100);
      const pagination = element('div', 'pagination');
      const prev = button('‹', '', () => { page--; renderResults(); }); prev.disabled = page === 0; prev.setAttribute('aria-label', '上一页');
      const next = button('›', '', () => { page++; renderResults(); }); next.disabled = page >= pages - 1; next.setAttribute('aria-label', '下一页');
      pagination.append(prev, element('span', '', `${page + 1} / ${pages}`), next); footer.append(pagination);
    }
    panel.append(footer);
  }
  if (notices.length) panel.append(element('pre', 'notice', notices.join('\n')));
}
function renderPlan() {
  const panel = $('plan-panel');
  panel.replaceChildren();
  if (!currentPlan) { emptyPanel(panel, '还没有执行计划', '选中一条 SQL，点击 EXPLAIN 或 ANALYZE。ANALYZE 按钮仅做只读分析。'); return; }
  const plan = currentPlan;
  const top = element('div', 'plan-top');
  const metrics = element('div', 'plan-metrics');
  for (const [label, value] of [['估算成本', plan.Plan['Total Cost']], ['规划时间', plan['Planning Time']], ['执行时间', plan['Execution Time']]] as const) {
    if (value !== undefined) { const metric = element('span', '', label); metric.append(element('strong', '', label === '估算成本' ? String(value) : `${value} ms`)); metrics.append(metric); }
  }
  top.append(metrics, button(planJSON ? '查看计划树' : '查看 JSON', 'text-button', () => { planJSON = !planJSON; renderPlan(); }));
  panel.append(top);
  if (planJSON) panel.append(element('pre', 'plan-json', JSON.stringify(plan, null, 2)));
  else {
    const tree = element('div', 'plan-tree');
    function nodeView(node: PlanNode): HTMLElement {
      const details = element('details', 'plan-node'); details.open = true;
      const summary = element('summary');
      summary.append(element('strong', '', node['Node Type']), element('span', '', node['Index Name'] || node['Relation Name'] || ''));
      const actual = node['Actual Rows'];
      const loops = node['Actual Loops'];
      const metrics = [`cost ${node['Total Cost'] ?? '—'}`, `rows ${node['Plan Rows'] ?? '—'}`];
      if (actual !== undefined) metrics.push(`actual ${actual} × ${loops ?? 1}`, `${node['Actual Total Time']} ms`);
      summary.append(element('span', '', metrics.join(' · '))); details.append(summary);
      const metadata = Object.entries(node).filter(([key]) => !['Plans', 'Node Type', 'Relation Name', 'Index Name', 'Total Cost', 'Plan Rows', 'Actual Rows', 'Actual Total Time', 'Actual Loops'].includes(key));
      const useful = metadata.filter(([key]) => ['Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Sort Key', 'Group Key'].includes(key));
      if (useful.length) details.append(element('pre', 'plan-details', useful.map(([key, value]) => `${key}: ${cellText(value)}`).join('\n')));
      if (metadata.length) {
        const properties = element('details', 'node-properties');
        properties.append(element('summary', '', '节点详情'), element('pre', 'plan-details', metadata.map(([key, value]) => `${key}: ${cellText(value)}`).join('\n')));
        details.append(properties);
      }
      node.Plans?.forEach(child => details.append(nodeView(child)));
      return details;
    }
    tree.append(nodeView(plan.Plan)); panel.append(tree);
  }
}
function renderHistory() {
  const panel = $('history-panel'); panel.replaceChildren();
  if (!history.length) { emptyPanel(panel, '每一次实验，都有迹可循', '最近 30 次运行记录保存在当前浏览器。点击记录可载入 SQL，不会自动运行。'); return; }
  const top = element('div', 'history-top');
  top.append(element('span', '', `最近 ${history.length} 次 · 点击载入 SQL`), button('清空记录', 'text-button', () => {
    history = []; try { localStorage.removeItem(HISTORY_KEY); } catch { toast('历史记录未能从本地存储删除。'); }
    renderHistory();
  }));
  panel.append(top);
  history.forEach(entry => {
    const row = button('', 'history-row', () => { replaceSQL(entry.sql); showTab('results'); toast('SQL 已载入，点击运行执行。'); });
    row.title = entry.sql.slice(0, 500);
    row.append(element('span', entry.ok ? 'history-status' : 'history-status failed'), element('span', 'history-sql', entry.sql.replace(/\s+/g, ' ')), element('span', 'history-meta', `${entry.mode.toUpperCase()} · ${entry.elapsed.toFixed(1)} ms\n${new Date(entry.at).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}`));
    panel.append(row);
  });
}
function saveHistory(entry: HistoryEntry) {
  if (entry.sql.length > 50_000) { toast('本次 SQL 较大，未加入历史记录；可保存为 SQL 文件。'); return; }
  history.unshift(entry); history = history.slice(0, 30);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { toast('历史记录未能保存，可使用“保存 SQL”下载。'); }
  renderHistory();
}

async function run(mode: string, overrideSQL?: string) {
  if (busy || !ready) return;
  const selection = editor.state.selection.main;
  const query = overrideSQL ?? (selection.empty ? editor.state.doc.toString() : editor.state.sliceDoc(selection.from, selection.to));
  if (!query.trim()) { toast('请先输入 SQL。'); editor.focus(); return; }
  saveDraft(); setBusy(true);
  $('query-error').hidden = true;
  $('execution-summary').textContent = '执行中…';
  $('result-badge').hidden = true;
  results = []; currentPlan = null; notices = []; page = 0;
  emptyPanel($('results-panel'), '正在执行查询…', '数据库在独立进程中运行。');
  renderPlan(); showTab(mode === 'run' ? 'results' : 'plan');
  const started = performance.now();
  try {
    const execution = await db.call<Execution>('execute', {sql: query, mode}, {timeoutMs: Number(($('query-timeout') as HTMLSelectElement).value)});
    results = execution.results; notices = execution.notices;
    selectedResult = Math.max(0, results.length - 1);
    currentPlan = results.map(planFrom).find(plan => plan !== null) ?? null;
    $('execution-summary').textContent = `✓ ${execution.elapsed.toFixed(1)} ms`;
    $('result-badge').textContent = String(results[selectedResult]?.totalRows ?? 0);
    $('result-badge').hidden = false;
    renderResults(); renderPlan();
    if (currentPlan) showTab('plan');
    saveHistory({sql: query, mode, at: new Date().toISOString(), elapsed: execution.elapsed, ok: true});
    await refreshSchema();
  } catch (error) {
    const e = error as Error & {code?: string; detail?: string; hint?: string; position?: string};
    const interrupted = e instanceof QueryInterruptedError;
    $('execution-summary').textContent = interrupted ? (e.code === 'QUERY_TIMEOUT' ? '已到运行时限' : '已停止') : '执行失败';
    emptyPanel($('results-panel'), interrupted ? '查询已停止，可以继续运行 SQL' : '这条 SQL 没有执行成功', interrupted ? '可调整运行时限后重试，或修改 SQL。' : '根据下方提示修改后再试一次。');
    const panel = $('query-error'); panel.replaceChildren(element('strong', '', e.message));
    if (interrupted) {
      renderSchema(e.info.tables);
      ready = true;
      $('connection-error').hidden = true;
      $('connection-status').textContent = db.mode === 'memory' ? '临时数据库已就绪' : '本地数据库已就绪';
      $('connection-dot').className = 'connection-dot ready';
      panel.append(element('p', '', '已恢复最近保存的数据；未完成的事务和会话设置已清除。本次 SQL 不会自动重试，多语句执行中已提交的内容请先查询确认。'));
    } else {
      const detail = [e.code && `SQLSTATE ${e.code}`, e.position && `位置 ${e.position}`, e.detail, e.hint].filter(Boolean).join('\n');
      if (detail) panel.append(element('pre', '', detail));
      if (e.code === '25P02' || e.message.includes('aborted')) panel.append(button('执行 ROLLBACK 恢复事务', '', () => void run('run', 'ROLLBACK;')));
    }
    panel.hidden = false;
    saveHistory({sql: query, mode, at: new Date().toISOString(), elapsed: performance.now() - started, ok: false});
    if (!db.connected) connectionError(e);
  } finally { setBusy(false); }
}

$('run').addEventListener('click', () => void run('run'));
$('stop-query').addEventListener('click', () => void db.cancel());
$('explain').addEventListener('click', () => void run('explain'));
$('analyze').addEventListener('click', () => void run('analyze'));
$('retry').addEventListener('click', () => void connect(db.mode));
$('memory-mode').addEventListener('click', () => void connect('memory'));
$('refresh-schema').addEventListener('click', async () => { if (busy) return; setBusy(true); await refreshSchema(); setBusy(false); });
$('save-sql').addEventListener('click', () => download(editor.state.doc.toString(), 'query.sql', 'text/plain;charset=utf-8'));
$('import-sql').addEventListener('click', () => $('sql-file').click());
$('sql-file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 1_000_000) throw Error('SQL 文件超过 1 MB，请拆分后导入。');
    replaceSQL(await file.text()); toast('SQL 已导入，尚未执行。');
  } catch (error) { toast((error as Error).message); }
  finally { input.value = ''; }
});
$('reset').addEventListener('click', () => { if (!busy && ready) { const dialog = $('reset-dialog') as HTMLDialogElement; dialog.returnValue = ''; dialog.showModal(); } });
$('reset-dialog').addEventListener('close', async () => {
  const dialog = $('reset-dialog') as HTMLDialogElement;
  if (dialog.returnValue !== 'reset' || busy || !ready) return;
  setBusy(true);
  try {
    const info = await db.call('reset', {mode: db.mode});
    renderSchema(info.tables);
    results = []; currentPlan = null; notices = [];
    renderResults(); renderPlan(); $('query-error').hidden = true; $('result-badge').hidden = true; $('execution-summary').textContent = '';
    toast('数据库已重置，示例数据已恢复。');
  } catch (error) { db.stop(); connectionError(error); }
  finally { setBusy(false); }
});
window.addEventListener('pagehide', () => { saveDraft(); db.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { busy = false; void connect(db.mode); } });

renderHistory();
void connect();
