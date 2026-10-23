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
      details.append(row);…5173 tokens truncated…solid var(--site-border); color: var(--site-muted); border-radius: 4px; padding: 0 4px; font: 10px/15px var(--site-font-mono); margin-left: 5px; }
.icon-button { border: 0; padding: 0; width: 25px; height: 25px; font-size: 16px; line-height: 1; }
.schema-list { min-height: 125px; margin-top: 5px; max-height: 340px; overflow: auto; }
.table-entry { margin-bottom: 3px; }
.table-entry summary { list-style: none; cursor: pointer; padding: 6px 5px; display: flex; gap: 7px; align-items: center; font: 12px var(--site-font-mono); border-radius: 5px; }
.table-entry summary::-webkit-details-marker { display: none; }
.table-entry summary::before { content: '›'; color: var(--site-muted); font-size: 14px; width: 7px; }
.table-entry[open] summary::before { transform: rotate(90deg); }
.table-entry summary:hover { background: var(--site-soft); }
.table-entry .table-name { overflow: hidden; text-overflow: ellipsis; }
.table-icon { color: var(--site-accent); font-size: 13px; }
.table-kind { font: 10px var(--site-font-sans); margin-left: auto; color: var(--site-muted); }
.table-column { padding: 4px 5px 4px 30px; display: flex; gap: 7px; justify-content: space-between; font: 10px/1.5 var(--site-font-mono); }
.table-column span { overflow: hidden; text-overflow: ellipsis; }
.table-column small { font: inherit; color: var(--site-muted); text-align: right; overflow-wrap: anywhere; }
.preview-table { display: block; border: 0; font-size: 10px; padding: 3px 5px 6px 30px; color: var(--site-accent); text-align: left; }
.example-label { margin-top: 22px; border-top: 1px solid var(--site-border); padding-top: 19px; height: 37px; }
.small-arrow { font-size: 16px; }
.example-list { display: flex; flex-direction: column; gap: 3px; padding-top: 10px; }
.example-button { border: 1px solid transparent; text-align: left; padding: 8px 9px; font-size: 12px; display: flex; align-items: center; gap: 10px; border-radius: 6px; }
.example-button .example-number { color: var(--site-muted); font: 10px var(--site-font-mono); opacity: .7; }
.example-button.active { background: var(--site-accent-soft); color: var(--site-accent); border-color: color-mix(in srgb, var(--site-accent) 15%, transparent); }
.example-button.active::after { content: '↗'; margin-left: auto; }
.sidebar-bottom { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--site-muted); margin: auto 5px 0; padding-top: 30px; }
.sidebar-bottom .local-dot { width: 4px; height: 4px; background: var(--site-success); }
.workbench { min-width: 0; }
.editor-heading { display: flex; align-items: center; justify-content: space-between; min-height: 46px; border-bottom: 1px solid var(--site-border); padding: 0 16px 0 20px; }
.file-tab { display: flex; align-items: center; gap: 9px; font: 11px var(--site-font-mono); }
.code-symbol { color: var(--site-accent); font-size: 14px; }
.saved-dot { display: inline-block; height: 5px; width: 5px; border-radius: 50%; background: var(--site-muted); opacity: .5; }
.saved-dot.error { background: var(--site-danger); opacity: 1; }
.file-actions { display: flex; gap: 12px; }
.text-button { border: 0; padding: 3px 0; font-size: 11px; color: var(--site-muted); }
.text-button:hover:not(:disabled) { color: var(--site-accent); background: transparent; text-decoration: underline; text-underline-offset: 3px; }
#editor { min-height: 260px; }
.cm-editor { font: 13px/1.9 var(--site-font-mono); color: var(--site-text); background: var(--site-surface); }
.cm-editor.cm-focused { outline: 0; }
.cm-editor .cm-scroller { font-family: var(--site-font-mono); height: 279px; overflow: auto; }
.cm-editor .cm-content { padding: 20px 0 24px; caret-color: var(--site-accent); }
.cm-editor .cm-line { padding: 0 22px 0 14px; }
.cm-editor .cm-gutters { border: 0; background: transparent; color: var(--site-muted); font-size: 11px; }
.cm-editor .cm-gutterElement { padding: 0 10px 0 16px; }
.cm-editor .cm-activeLine, .cm-editor .cm-activeLineGutter { background: color-mix(in srgb, var(--site-soft) 45%, transparent); }
.cm-editor .cm-selectionBackground, .cm-editor.cm-focused .cm-selectionBackground { background: var(--site-accent-soft); }
.cm-editor .cm-cursor { border-left-color: var(--site-accent); }
.cm-editor .cm-tooltip { background: var(--site-surface); color: var(--site-text); border: 1px solid var(--site-border); }
.editor-footer { padding: 7px 18px; font: 10px var(--site-font-mono); color: var(--site-muted); display: flex; justify-content: space-between; border-top: 1px solid color-mix(in srgb, var(--site-border) 45%, transparent); }
.separator { margin: 0 6px; opacity: .5; }
.query-toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--site-border); }
.plan-actions, .run-actions { display: flex; gap: 7px; align-items: center; }
.plan-actions button { font: 10px/1.5 var(--site-font-mono); padding: 7px 10px; }
.button-plus { margin-left: 3px; color: var(--site-muted); }
.run-shortcut { font: 10px var(--site-font-mono); color: var(--site-muted); margin-right: 5px; }
.primary-button { background: var(--site-accent); color: var(--site-on-accent); border-color: var(--site-accent); padding: 7px 13px; font-size: 12px; display: inline-flex; align-items: center; gap: 7px; font-weight: 550; }
.primary-button:hover:not(:disabled) { background: color-mix(in srgb, var(--site-accent) 85%, var(--site-text)); }
.primary-button svg { width: 12px; height: 12px; }
.output-heading { min-height: 45px; display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 0 18px; border-block: 1px solid var(--site-border); background: color-mix(in srgb, var(--site-soft) 25%, var(--site-surface)); }
.output-tabs { display: flex; gap: 22px; min-width: 0; }
.output-tabs button { padding: 13px 0 12px; font-size: 11px; border: 0; border-radius: 0; white-space: nowrap; color: var(--site-muted); position: relative; }
.output-tabs button[aria-selected="true"] { color: var(--site-accent); font-weight: 650; }
.output-tabs button[aria-selected="true"]::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: var(--site-accent); }
.output-tabs button:hover { background: transparent; color: var(--site-accent); }
.execution-summary { font: 10px var(--site-font-mono); color: var(--site-muted); text-align: right; }
.empty-state { display: flex; align-items: center; justify-content: center; flex-direction: column; min-height: 228px; padding: 30px 15px; text-align: center; }
.empty-code { color: var(--site-muted); font: 13px var(--site-font-mono); opacity: .65; margin-bottom: 18px; }
.empty-code span { color: var(--site-accent); }
.empty-state strong { font-size: 14px; font-weight: 550; }
.empty-state p { font-size: 11px; color: var(--site-muted); line-height: 1.9; margin: 8px 0 0; }
.empty-label { color: var(--site-muted); font-size: 10px; margin-top: 18px; opacity: .8; }
.result-controls { display: flex; justify-content: space-between; align-items: center; padding: 9px 16px; gap: 10px; border-bottom: 1px solid var(--site-border); }
.result-choices { display: flex; gap: 5px; overflow: auto; }
.result-choice { font-size: 10px; padding: 4px 8px; white-space: nowrap; }
.result-choice[aria-pressed="true"] { color: var(--site-accent); border-color: var(--site-accent); }
.table-scroll { overflow: auto; max-height: 380px; }
.result-table { border-collapse: collapse; text-align: left; width: 100%; font: 11px/1.6 var(--site-font-mono); white-space: nowrap; }
.result-table th { background: var(--site-soft); font-weight: 500; color: var(--site-muted); position: sticky; top: 0; z-index: 1; }
.result-table td, .result-table th { padding: 8px 15px; border-bottom: 1px solid color-mix(in srgb, var(--site-border) 60%, transparent); }
.result-table .row-number { color: var(--site-muted); font-size: 10px; text-align: right; width: 34px; padding-right: 7px; opacity: .7; }
.result-table tbody tr:hover { background: color-mix(in srgb, var(--site-soft) 50%, transparent); }
.null-cell { color: var(--site-muted); font-style: italic; opacity: .7; }
.result-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 10px; color: var(--site-muted); padding: 9px 16px; }
.pagination { display: flex; gap: 8px; align-items: center; }
.pagination button { padding: 1px 7px; font-size: 12px; }
.success-message { padding: 30px 22px; font-size: 13px; }
.success-message strong { color: var(--site-success); }
.notice { font: 11px/1.8 var(--site-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: 9px 16px; border-top: 1px solid var(--site-border); color: var(--site-muted); }
.query-error { margin: 12px 16px; border: 1px solid color-mix(in srgb, var(--site-danger) 30%, transparent); background: var(--site-danger-soft); color: var(--site-danger); padding: 13px; border-radius: 7px; font-size: 12px; overflow-wrap: anywhere; }
.query-error pre { white-space: pre-wrap; font: 11px/1.8 var(--site-font-mono); margin: 7px 0 0; }
.query-error button { color: var(--site-danger); font-size: 11px; margin-top: 10px; border-color: currentColor; }
.plan-top { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 17px; border-bottom: 1px solid var(--site-border); font: 11px var(--site-font-mono); flex-wrap: wrap; }
.plan-metrics { display: flex; gap: 16px; color: var(--site-muted); flex-wrap: wrap; }
.plan-metrics strong { color: var(--site-accent); margin-left: 5px; font-weight: 500; }
.plan-tree { padding: 13px 17px; overflow: auto; max-height: 500px; }
.plan-node { margin-left: 16px; border-left: 1px solid var(--site-border); padding: 4px 0 4px 14px; }
.plan-tree > .plan-node { margin-left: 0; border-left: 0; padding-left: 0; }
.plan-node > summary { cursor: pointer; font: 12px/1.8 var(--site-font-mono); padding: 4px 0; }
.plan-node > summary strong { font-weight: 600; color: var(--site-accent); }
.plan-node > summary span { margin-left: 8px; color: var(--site-muted); font-size: 10px; }
.plan-details { font: 10px/1.8 var(--site-font-mono); margin: 0 0 8px; color: var(--site-muted); white-space: pre-wrap; overflow-wrap: anywhere; padding-left: 13px; }
.plan-json { padding: 15px 18px; font: 11px/1.8 var(--site-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; max-height: 500px; overflow: auto; }
.history-top { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--site-muted); padding: 13px 17px; }
.history-row { width: 100%; text-align: left; border: 0; border-top: 1px solid var(--site-border); border-radius: 0; padding: 12px 17px; display: flex; gap: 12px; align-items: center; }
.history-status { width: 5px; height: 5px; background: var(--site-success); border-radius: 50%; flex-shrink: 0; }
.history-status.failed { background: var(--site-danger); }
.history-sql { font: 11px/1.6 var(--site-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.history-meta { font: 10px/1.6 var(--site-font-mono); color: var(--site-muted); text-align: right; flex-shrink: 0; }
#history-panel { max-height: 400px; overflow: auto; }
.workspace-footnote { display: flex; justify-content: space-between; gap: 15px; align-items: center; padding: 13px 2px; }
.workspace-footnote p { margin: 0; display: flex; align-items: center; gap: 7px; color: var(--site-muted); font-size: 10px; }
.workspace-footnote .local-dot { width: 4px; height: 4px; background: var(--site-success); }
.workspace-footnote > button { flex-shrink: 0; font-size: 10px; }
.danger-text { color: var(--site-danger); }
.help { border-top: 1px solid var(--site-border); margin-top: 18px; }
.help > summary { list-style: none; cursor: pointer; padding: 17px 0; color: var(--site-muted); font-size: 12px; display: flex; align-items: center; gap: 13px; }
.help > summary span { font-size: 10px; opacity: .7; }
.help > summary::after { content: '+'; font: 16px var(--site-font-mono); margin-left: auto; }
.help[open] > summary::after { content: '−'; }
.help-content { color: var(--site-muted); font-size: 12px; line-height: 1.9; max-width: 800px; padding-bottom: 17px; }
.help-content strong { color: var(--site-text); font-weight: 550; }
.help-content a + a { margin-left: 20px; }
.site-ui-footer { margin-top: 25px; }
.subtle { color: var(--site-muted); font-size: 11px; }
.loading-copy { padding: 0 6px; }
.connection-error { border: 1px solid var(--site-border); border-radius: 8px; background: var(--site-warning-soft); color: var(--site-warning); padding: 12px 16px; margin-bottom: 18px; font-size: 13px; }
.connection-error p { margin: 0 0 9px; }
.connection-error button { color: var(--site-text); font-size: 11px; margin-right: 7px; }
dialog { border: 1px solid var(--site-border); border-radius: var(--site-radius-card); background: var(--site-surface); color: var(--site-text); padding: 28px; max-width: 430px; width: calc(100% - 40px); box-shadow: var(--site-shadow); }
dialog::backdrop { background: #112c2670; backdrop-filter: blur(3px); }
.dialog-kicker { font-size: 11px; color: var(--site-accent); }
dialog h2 { margin: 8px 0 15px; font-size: 22px; letter-spacing: -.04em; }
dialog p { font-size: 13px; color: var(--site-muted); line-height: 1.9; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 23px; }
.dialog-actions button { font-size: 12px; padding: 8px 14px; }
.danger-button { background: var(--site-danger); color: var(--site-on-accent); border-color: var(--site-danger); }
.danger-button:hover { color: var(--site-danger); }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 40px); background: var(--site-text); color: var(--site-bg); border: 1px solid var(--site-border); border-radius: 8px; padding: 10px 18px; font-size: 13px; z-index: 80; box-shadow: var(--site-shadow); }
.skip-link { position: absolute; top: -70px; left: 20px; z-index: 100; background: var(--site-surface); padding: 12px; }
.skip-link:focus { top: 10px; }
.no-script { padding: 20px; text-align: center; }
@media (min-width: 1500px) { .page-heading { padding-top: 50px; } .cm-editor .cm-scroller { height: 320px; } }
@media (max-width: 900px) { .app-shell { width: calc(100% - 56px); } .workspace { grid-template-columns: 185px minmax(0, 1fr); } .run-shortcut { display: none; } .connection { min-width: 145px; } }
@media (max-width: 700px) {
  .app-shell { width: calc(100% - 32px); }
  .page-heading { padding: 26px 0 22px; align-items: flex-start; flex-direction: column; gap: 16px; }
  .eyebrow { font-size: 10px; margin-bottom: 9px; }
  .intro { font-size: 12px; }
  .intro span { display: block; margin: 3px 0 0; }
  .connection { gap: 7px; align-items: center; margin: 0; }
  .connection-dot { margin-top: 0; }
  .connection > div { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .connection strong { font-size: 11px; }
  .connection small { margin: 0; font-size: 10px; }
  .workspace { grid-template-columns: 1fr; }
  .sidebar { border-right: 0; border-bottom: 1px solid var(--site-border); padding: 12px; }
  .sidebar-heading, .database-label, .sidebar-bottom { display: none; }
  .sidebar .section-label { padding-inline: 3px; }
  .schema-list { min-height: 0; max-height: 150px; margin-top: 0; }
  .schema-list .table-entry { display: inline-block; vertical-align: top; width: 49%; }
  .example-label { border-top: 1px solid var(--site-border); margin-top: 8px; padding-top: 10px; height: 26px; }
  .example-list { flex-direction: row; flex-wrap: wrap; gap: 3px; padding-top: 7px; }
  .example-button { padding: 5px 6px; font-size: 11px; gap: 5px; }
  .example-button.active::after { display: none; }
  .example-number { display: none; }
  .editor-heading { padding: 0 12px; min-height: 42px; }
  .file-actions { gap: 10px; }
  .cm-editor { font-size: 12px; }
  .cm-editor .cm-scroller { height: 245px; }
  .cm-editor .cm-content { padding-top: 15px; }
  .cm-editor .cm-line { padding-left: 7px; }
  .cm-editor .cm-gutterElement { padding-left: 7px; }
  .query-toolbar { padding: 10px; gap: 8px; }
  .plan-actions { gap: 4px; }
  .plan-actions button { padding: 7px; font-size: 10px; }
  .primary-button { font-size: 11px; padding: 7px 10px; }
  .output-heading { padding: 0 12px; flex-wrap: wrap; gap: 0; }
  .output-tabs { gap: 20px; }
  .execution-summary { font-size: 10px; padding-block: 4px; }
  .empty-code { font-size: 11px; }
  .result-table td, .result-table th { padding: 7px 11px; }
  .result-footer { padding: 9px 12px; flex-wrap: wrap; }
  .workspace-footnote { align-items: flex-start; gap: 9px; }
  .workspace-footnote p { align-items: flex-start; font-size: 10px; }
  .workspace-footnote .local-dot { margin-top: 5px; }
  .help { margin-top: 9px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; scroll-behavior: auto !important; } }

.node-properties { margin: 2px 0 8px 13px; }
.node-properties > summary { font-size: 10px; color: var(--site-muted); cursor: pointer; }

.timeout-control { display: flex; align-items: center; gap: 6px; color: var(--site-muted); font-size: 11px; white-space: nowrap; }
.timeout-control select { padding: 6px 7px; border: 1px solid var(--site-border); border-radius: 5px; background: var(--site-bg); color: var(--site-text); font: inherit; }
.stop-button { color: var(--site-danger); border-color: var(--site-danger); }
@media (max-width: 700px) {
  .run-actions { margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
}
