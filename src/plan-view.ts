import type { Plan, PlanNode } from './model';
import { cellText } from './model';
import { parsePlan, planNodes, estimateWarning, type PlanCapture } from './plans';
import { el, action, downloadFile } from './ui';

export class PlanViewer {
  current: PlanCapture | null = null;
  baseline: PlanCapture | null = null;
  private json = false;
  constructor(private panel: HTMLElement, private toast: (message: string) => void, private show: () => void) {
    const dialog = document.getElementById('plan-import-dialog') as HTMLDialogElement;
    const input = document.getElementById('plan-text') as HTMLTextAreaElement;
    const error = document.getElementById('plan-import-error')!;
    const file = document.getElementById('plan-file') as HTMLInputElement;
    document.getElementById('choose-plan-file')!.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      try {
        if (!file.files?.[0]) return;
        if (file.files[0].size > 5 * 1024 * 1024) throw Error('计划 JSON 不能超过 5 MB。');
        input.value = await file.files[0].text(); error.hidden = true;
      } catch (e) { error.hidden = false; error.textContent = (e as Error).message; }
      finally { file.value = ''; }
    });
    document.getElementById('confirm-plan-import')!.addEventListener('click', () => {
      try {
        const plan = parsePlan(input.value);
        const sql = (document.getElementById('plan-query') as HTMLTextAreaElement).value;
        this.capture(plan, sql, '外部导入 · 环境由原数据库决定');
        dialog.close(); this.show(); this.toast('执行计划已导入，未运行任何 SQL。');
      } catch (e) { error.hidden = false; error.textContent = (e as Error).message; }
    });
    const dropzone = document.getElementById('plan-dropzone')!;
    dropzone.addEventListener('dragover', event => { event.preventDefault(); });
    dropzone.addEventListener('drop', async event => {
      event.preventDefault();
      const dropped = event.dataTransfer?.files[0]; if (!dropped) return;
      try {
        if (dropped.size > 5 * 1024 * 1024) throw Error('计划 JSON 不能超过 5 MB。');
        input.value = await dropped.text(); error.hidden = true;
      } catch (e) { error.hidden = false; error.textContent = (e as Error).message; }
    });
  }
  capture(plan: Plan, sql: string, source: string) {
    this.current = {plan: parsePlan(JSON.stringify(plan)), sql, source, at: new Date().toISOString()}; this.render();
  }
  clear() { this.current = null; this.baseline = null; this.render(); }
  render() {
    this.panel.replaceChildren();
    const toolbar = el('div', 'tool-row plan-toolbar');
    toolbar.append(action('导入外部计划', () => {
      document.getElementById('plan-import-error')!.hidden = true;
      (document.getElementById('plan-import-dialog') as HTMLDialogElement).showModal();
    }));
    if (this.current) {
      toolbar.append(action('保留当前计划为 A', () => { this.baseline = structuredClone(this.current); this.render(); this.toast('基线 A 已保留，可修改 SQL 或索引后运行新的计划 B。'); }));
      toolbar.append(action(this.json ? '查看计划树' : '查看 JSON', () => { this.json = !this.json; this.render(); }));
      toolbar.append(action('导出当前计划 JSON', () => downloadFile(JSON.stringify([this.current!.plan], null, 2), 'query-plan.json', 'application/json')));
    }
    if (this.baseline) toolbar.append(action('清除基线 A', () => { this.baseline = null; this.render(); }, 'text-button'));
    this.panel.append(toolbar);
    if (!this.current) { this.panel.append(el('p', 'panel-note', '选中一条 SQL，点击 EXPLAIN / ANALYZE，或导入外部 JSON 计划。')); return; }
    this.panel.append(el('p', 'panel-note', 'cost 是优化器成本单位，不是毫秒；actual 行数与节点耗时按每次循环展示，loops 是循环次数。父节点耗时包含子节点，不能直接相加。浏览器计划用于观察结构。'));
    if (this.baseline) this.renderComparison();
    const grid = el('div', this.baseline ? 'plan-comparison' : 'plan-single');
    if (this.baseline) grid.append(this.captureView(this.baseline, 'A · 保留的基线'));
    grid.append(this.captureView(this.current, this.baseline ? 'B · 当前计划' : '当前计划'));
    this.panel.append(grid);
  }
  private renderComparison() {
    const a = this.baseline!.plan, b = this.current!.plan;
    const wrap = el('div', 'comparison-summary');
    const table = el('table', 'result-table');
    const head = el('tr'); for (const value of ['指标', 'A', 'B', 'B − A']) head.append(el('th', '', value));
    const thead = el('thead'); thead.append(head); table.append(thead);
    const body = el('tbody');
    const entries: [string, number | undefined, number | undefined, string][] = [
      ['估算成本', a.Plan['Total Cost'], b.Plan['Total Cost'], ''],
      ['规划时间', a['Planning Time'], b['Planning Time'], ' ms'],
      ['数据库执行时间', a['Execution Time'], b['Execution Time'], ' ms'],
      ['根节点估算行数 / 次', a.Plan['Plan Rows'], b.Plan['Plan Rows'], ''],
      ['根节点实际行数 / 次', a.Plan['Actual Rows'], b.Plan['Actual Rows'], ''],
      ['根节点循环次数', a.Plan['Actual Loops'], b.Plan['Actual Loops'], '']
    ];
    for (const [name, av, bv, unit] of entries) {
      const row = el('tr');
      for (const value of [name, av === undefined ? '—' : av + unit, bv === undefined ? '—' : bv + unit, av === undefined || bv === undefined ? '—' : `${bv - av > 0 ? '+' : ''}${Number((bv - av).toFixed(3))}${unit}`]) row.append(el('td', '', value));
      body.append(row);
    }
    table.append(body); wrap.append(table);
    const describe = (plan: Plan) => planNodes(plan.Plan).map(n => `${n['Node Type']}${n['Index Name'] ? ' [' + n['Index Name'] + ']' : ''}`).join(' · ');
    wrap.append(el('p', 'panel-note', `A 节点：${describe(a)}\nB 节点：${describe(b)}\n两侧保留各自树结构；指标差异需结合 SQL、数据、设置和运行环境判断。`));
    this.panel.append(wrap);
  }
  private captureView(capture: PlanCapture, title: string) {
    const card = el('section', 'plan-capture');
    card.append(el('h3', '', title), el('p', 'capture-meta', `${capture.source} · ${new Date(capture.at).toLocaleTimeString('zh-CN')}`));
    if (capture.sql) { const sql = el('details', 'capture-sql'); sql.append(el('summary', '', '查看对应 SQL'), el('pre', 'plan-details', capture.sql)); card.append(sql); }
    const metrics = el('div', 'plan-metrics');
    for (const [label, value] of [['估算成本', capture.plan.Plan['Total Cost']], ['规划时间', capture.plan['Planning Time']], ['数据库执行时间', capture.plan['Execution Time']]] as const) {
      if (value !== undefined) { const metric = el('span', '', label); metric.append(el('strong', '', label === '估算成本' ? String(value) : `${value} ms`)); metrics.append(metric); }
    }
    card.append(metrics);
    if (this.json) card.append(el('pre', 'plan-json', JSON.stringify(capture.plan, null, 2)));
    else { const tree = el('div', 'plan-tree'); tree.append(this.nodeView(capture.plan.Plan)); card.append(tree); }
    return card;
  }
  private nodeView(node: PlanNode): HTMLElement {
    const details = el('details', 'plan-node'); details.open = true;
    const summary = el('summary');
    summary.append(el('strong', '', node['Node Type']), el('span', '', node['Index Name'] || node['Relation Name'] || ''));
    const metrics = [`cost ${node['Total Cost'] ?? '—'}`, `估算 ${node['Plan Rows'] ?? '—'} 行/次`];
    if (node['Actual Rows'] !== undefined) metrics.push(`实际 ${node['Actual Rows']} 行/次 × ${node['Actual Loops'] ?? 1} 次`, `${node['Actual Total Time'] ?? '—'} ms/次`);
    summary.append(el('span', '', metrics.join(' · '))); details.append(summary);
    const warning = estimateWarning(node); if (warning) details.append(el('p', 'estimate-warning', warning));
    const useful = ['Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Sort Key', 'Group Key', 'Rows Removed by Filter', 'Rows Removed by Index Recheck'];
    const lines = useful.filter(key => node[key] !== undefined).map(key => `${key}: ${cellText(node[key])}`);
    if (lines.length) details.append(el('pre', 'plan-details', lines.join('\n')));
    const properties = el('details', 'node-properties');
    properties.append(el('summary', '', '节点详情'), el('pre', 'plan-details', Object.entries(node).filter(([key]) => key !== 'Plans').map(([key, value]) => `${key}: ${cellText(value)}`).join('\n')));
    details.append(properties);
    node.Plans?.forEach(child => details.append(this.nodeView(child)));
    return details;
  }
}
