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
import { extensionCatalog, extensionExample, type ExtensionState } from './extensions';
import { PlanViewer } from './plan-view';
import { installDataTools } from './data-tools';
import { labs } from './labs';
import { copyText } from './ui';
import { cellText, quoteIdentifier, toCSV, planFrom, ROW_LIMIT, type Execution, type Result, type Table, type HistoryEntry, type Plan } from './model';

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
let extensions: ExtensionState[] = [];
let results: Result[] = [];
let selectedResult = 0;
let page = 0;
let currentPlan: Plan | null = null;
let notices: string[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let history: HistoryEntry[] = [];
let storedDraft: string | null = null;
let draftTimer: ReturnType<typeof setTimeout>;
const planViewer = new PlanViewer($('plan-panel'), toast, () => showTab('plan'));
let cellValue = '';
$('copy-cell').addEventListener('click', () => void copyText(cellValue, toast));
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
  updateExtensionControls();
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
  $('extension-summary').textContent = '连接后查看状态';
  $('connection-dot').className = 'connection-dot error';
  if (!$('schema-list').querySelector('.table-entry')) $('schema-list').replaceChildren(element('p', 'subtle loading-copy', '连接后显示表结构。'));
  setBusy(false);
}
function renderSchema(tables: Table[]) {
  const openTables = new Set(Array.from($('schema-list').querySelectorAll<HTMLDetailsElement>('details.table-entry[open]')).map(node => node.dataset.table));
  $('table-count').textContent = String(tables.length);
  $('schema-list').replaceChildren();
  const completions: Record<string, string[]> = {};
  for (const table of tables) {
    const qualified = quoteIdentifier(table.schema) + '.' + quoteIdentifier(table.name);
    completions[`${table.schema}.${table.name}`] = table.columns.map(column => column.name);
    if (table.schema === 'public') completions[table.name] = table.columns.map(column => column.name);
    const details = element('details', 'table-entry');
    details.dataset.table = `${table.schema}.${table.name}`;
    details.open = openTables.has(details.dataset.table);
    const summary = element('summary');
    summary.title = `${table.schema}.${table.name}`;
    summary.append(element('span', 'table-icon', '▦'), element('span', 'table-name', table.schema === 'public' ? table.name : `${table.schema}.${table.name}`), element('span', 'table-kind', table.kind));
    details.append(summary);
    for (const column of table.columns) {
      const row = element('div', 'table-column');
      row.append(element('span', '', column.name), element('small', '', column.type + (column.nullable === false ? ' · NOT NULL' : '')));
      row.title = column.default ? `默认值：${column.default}` : `${column.name} · ${column.type}`;
      details.append(row);
      if (column.default) details.append(element('small', 'schema-default', `默认：${column.default}`));
    }
    if (table.estimatedRows !== undefined && table.estimatedRows >= 0) details.append(element('p', 'schema-estimate', `约 ${Math.round(table.estimatedRows).toLocaleString()} 行 · 统计估算`));
    for (const [title, entries] of [['索引', table.indexes ?? []], ['约束', table.constraints ?? []]] as const) {
      if (!entries.length) continue;
      const group = element('details', 'schema-properties'); group.append(element('summary', '', `${title} · ${entries.length}`));
      for (const entry of entries) {
        const item = element('details', 'schema-property');
        item.append(element('summary', '', entry.name), element('pre', '', entry.definition), button('复制定义', 'text-button', () => void copyText(entry.definition, toast)));
        group.append(item);
      }
      details.append(group);
    }
    details.append(button('预览前 100 行 ↗', 'preview-table', () => replaceSQL(`SELECT *\nFROM ${qualified}\nLIMIT 100;`)));
    $('schema-list').append(details);
  }
  if (!tables.length) $('schema-list').append(element('p', 'subtle loading-copy', '还没有表，写一条 CREATE TABLE 开始。'));
  editor.dispatch({effects: language.reconfigure(sql({dialect: PostgreSQL, schema: completions, upperCaseKeywords: true}))});
}
function updateExtensionControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-enable-extension]').forEach(node => {
    const state = extensions.find(item => item.name === node.dataset.enableExtension);
    node.disabled = busy || !ready || !state?.availableVersion || !!state.installedVersion;
  });
  $('enable-all-extensions').toggleAttribute('disabled', busy || !ready || !extensions.some(item => item.availableVersion && !item.installedVersion));
  document.querySelectorAll<HTMLButtonElement>('[data-extension-example]').forEach(node => { node.disabled = busy; });
}
function renderExtensions(states: ExtensionState[]) {
  extensions = states;
  const count = states.filter(item => item.installedVersion).length;
  $('extension-summary').textContent = ready || states.length ? `${count} / ${extensionCatalog.length} 已启用` : '连接后查看状态';
  const list = $('extension-list');
  list.replaceChildren();
  for (const item of extensionCatalog) {
    const state = states.find(state => state.name === item.name);
    const card = element('article', 'extension-card');
    const heading = element('div', 'extension-heading');
    heading.append(element('h3', '', item.label), element('span', 'extension-category', item.category));
    const version = element('span', state?.installedVersion ? 'extension-version enabled' : 'extension-version',
      state?.installedVersion ? `v${state.installedVersion} · ${state.schema}` : state?.availableVersion ? `可用版本 ${state.availableVersion}` : '连接后查看版本');
    const actions = element('div', 'extension-actions');
    const enable = button(state?.installedVersion ? '已启用' : '启用', '', () => void installExtensions([item.name]));
    enable.dataset.dbAction = ''; enable.dataset.enableExtension = item.name;
    enable.setAttribute('aria-label', `${state?.installedVersion ? '已启用' : '启用'} ${item.label}`);
    const example = button('查看示例 ↗', 'text-button', () => {
      let sql = extensionExample(item.name);
      // Respect an extension installed manually in a custom schema.
      if (state?.schema && state.schema !== 'public') sql = `-- 将扩展所在 schema 加入查询路径。\nSET search_path TO ${quoteIdentifier(state.schema)}, public, pg_catalog;\n\n` + sql;
      replaceSQL(sql);
      $('editor').scrollIntoView({behavior: 'smooth', block: 'center'});
      toast(`${item.label} 示例已载入，尚未执行。`);
    });
    example.dataset.extensionExample = item.name;
    example.setAttribute('aria-label', `查看 ${item.label} 示例`);
    actions.append(enable, example);
    card.append(heading, element('p', '', item.description), version, actions);
    list.append(card);
  }
  updateExtensionControls();
}
async function refreshSchema() {
  try {
    const [tables, states] = await Promise.all([db.call<Table[]>('schema'), db.call<ExtensionState[]>('extensions')]);
    renderSchema(tables); renderExtensions(states);
  } catch (error) {
    $('extension-summary').textContent = '状态待刷新';
    toast('结构与扩展状态暂未更新：' + (error as Error).message);
  }
}
async function installExtensions(names: string[]) {
  if (busy || !ready || !names.length) return;
  setBusy(true);
  const feedback = $('extension-feedback');
  feedback.hidden = false; feedback.classList.remove('error'); feedback.textContent = '正在启用扩展…';
  try {
    const info = await db.call<{tables: Table[]; extensions: ExtensionState[]}>('enable-extensions', {names});
    renderSchema(info.tables); renderExtensions(info.extensions);
    feedback.textContent = '扩展已启用。可查看示例，或直接在编辑器中运行 SQL。';
  } catch (error) {
    feedback.classList.add('error'); feedback.textContent = (error as Error).message;
    if (!db.connected) connectionError(error);
  } finally { setBusy(false); }
}
$('enable-all-extensions').addEventListener('click', () => void installExtensions(extensions.filter(item => item.availableVersion && !item.installedVersion).map(item => item.name)));
async function connect(mode = 'persistent') {
  if (busy) return;
  ready = false;
  setBusy(true);
  $('connection-status').textContent = '正在启动数据库…';
  $('connection-dot').className = 'connection-dot';
  $('connection-error').hidden = true;
  $('extension-feedback').hidden = true;
  try {
    const info = await db.start(mode);
    renderSchema(info.tables); renderExtensions(info.extensions);
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
    current.fields.forEach(field => { const th = element('th', '', field.name); th.scope = 'col'; th.append(element('small', 'column-type', field.type || `OID ${field.dataTypeID}`)); headers.append(th); });
    thead.append(headers); table.append(thead);
    const body = element('tbody');
    current.rows.slice(page * 100, (page + 1) * 100).forEach((row, index) => {
      const tr = element('tr');
      tr.append(element('td', 'row-number', String(page * 100 + index + 1)));
      current.fields.forEach((_, column) => {
        const value = row[column];
        const text = cellText(value, current.fields[column].dataTypeID);
        const td = element('td', value === null ? 'null-cell' : '');
        const cell = button(value === null ? 'NULL' : text === '' ? "''" : text.length > 160 ? text.slice(0, 160) + '…' : text, 'inspect-cell', () => {
          cellValue = value === null ? 'NULL' : text;
          $('cell-title').textContent = `${current.fields[column].name} · 第 ${page * 100 + index + 1} 行`;
          $('cell-type').textContent = `${current.fields[column].type || 'OID ' + current.fields[column].dataTypeID}${value === null ? ' · NULL' : text === '' ? ' · 空字符串' : ''}`;
          let content = cellValue;
          if ([114, 3802].includes(current.fields[column].dataTypeID)) { try { content = JSON.stringify(typeof value === 'object' ? value : JSON.parse(text), null, 2); } catch { /* Show the original text. */ } }
          $('cell-content').textContent = content;
          ($('cell-dialog') as HTMLDialogElement).showModal();
        });
        cell.setAttribute('aria-label', `查看第 ${page * 100 + index + 1} 行 ${current.fields[column].name}：${cellValuePreview(value, text)}`);
        cell.title = '点击查看完整值并复制'; td.append(cell);
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
function renderPlan() { planViewer.render(); }
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
  $('extension-feedback').hidden = true;
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
    $('execution-summary').textContent = `✓ 请求耗时 ${execution.elapsed.toFixed(1)} ms`;
    $('execution-summary').title = '从执行 SQL 到整理结果的耗时，包含本地存储和结果处理，不等于计划中的数据库执行时间，也不是服务器性能基准。';
    $('result-badge').textContent = String(results[selectedResult]?.totalRows ?? 0);
    $('result-badge').hidden = false;
    if (currentPlan) planViewer.capture(currentPlan, query, `浏览器本地 · ${$('engine-version').textContent}`);
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
      renderSchema(e.info.tables); renderExtensions(e.info.extensions);
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
    else if (!interrupted) await refreshSchema();
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
    renderSchema(info.tables); renderExtensions(info.extensions);
    $('extension-feedback').hidden = true;
    results = []; currentPlan = null; notices = []; planViewer.clear();
    renderResults(); renderPlan(); $('query-error').hidden = true; $('result-badge').hidden = true; $('execution-summary').textContent = '';
    toast('数据库已重置，示例数据已恢复，扩展可重新启用。');
  } catch (error) { db.stop(); connectionError(error); }
  finally { setBusy(false); }
});
window.addEventListener('pagehide', () => { saveDraft(); db.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { busy = false; void connect(db.mode); } });

function cellValuePreview(value: unknown, text: string) { return value === null ? 'NULL' : text === '' ? '空字符串' : text.slice(0, 80); }
const labSelect = $('lab-select') as HTMLSelectElement;
labs.forEach(lab => { const option = element('option', '', lab.name); option.value = lab.id; labSelect.append(option); });
function renderLab() {
  const lab = labs.find(item => item.id === labSelect.value)!;
  const content = $('lab-content'); content.replaceChildren(element('h3', '', lab.goal), element('p', 'panel-note', lab.observe));
  const steps = element('div', 'tool-row lab-steps');
  for (const step of lab.steps) steps.append(button(step.name, '', () => {
    replaceSQL(step.sql);
    toast(step.mode === 'analyze' ? 'SQL 已载入。点击 ANALYZE 查看计划；可保留为 A 后继续比较。' : 'SQL 已载入，点击“运行 SQL”执行。');
    $('editor').scrollIntoView({behavior: 'smooth', block: 'center'});
  }));
  content.append(steps);
}
labSelect.addEventListener('change', renderLab); renderLab();
installDataTools({db, busy: () => busy, ready: () => ready, setBusy, refresh: refreshSchema, replaceSQL,
  restored(info) {
    renderSchema(info.tables); renderExtensions(info.extensions);
    results = []; currentPlan = null; notices = []; planViewer.clear();
    renderResults(); $('query-error').hidden = true; $('result-badge').hidden = true; $('execution-summary').textContent = '';
    $('engine-version').textContent = `PostgreSQL ${info.version} · PGlite 0.5.11`;
  }
});
renderHistory();
renderPlan();
renderExtensions([]);
void connect();
