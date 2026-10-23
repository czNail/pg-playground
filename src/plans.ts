import type { Plan, PlanNode } from './model';

export interface PlanCapture { plan: Plan; sql: string; source: string; at: string }
export function parsePlan(text: string): Plan {
  if (new TextEncoder().encode(text).length > 5 * 1024 * 1024) throw Error('计划 JSON 不能超过 5 MB。');
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw Error('JSON 格式不正确，请粘贴 EXPLAIN (FORMAT JSON) 的完整输出。'); }
  if (Array.isArray(parsed)) { if (parsed.length !== 1) throw Error('请一次导入一个执行计划。'); parsed = parsed[0]; }
  const plan = parsed?.Plan ? parsed : parsed?.['Node Type'] ? {Plan: parsed} : null;
  if (!plan) throw Error('没有找到 PostgreSQL 执行计划中的 Plan 节点。');
  let count = 0;
  function validate(node: any, depth: number) {
    if (++count > 2000 || depth > 80) throw Error('计划过大，最多支持 2,000 个节点、80 层。');
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node['Node Type'] !== 'string' || !node['Node Type'].trim()) throw Error('执行计划节点缺少 Node Type。');
    for (const key of ['Plan Rows', 'Total Cost', 'Actual Rows', 'Actual Loops', 'Actual Total Time']) {
      if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]) || node[key] < 0)) throw Error(`计划指标 ${key} 无效。`);
    }
    if (node.Plans !== undefined) { if (!Array.isArray(node.Plans)) throw Error('Plans 必须是节点数组。'); node.Plans.forEach((child: any) => validate(child, depth + 1)); }
  }
  validate(plan.Plan, 0);
  for (const key of ['Planning Time', 'Execution Time']) if (plan[key] !== undefined && (typeof plan[key] !== 'number' || !Number.isFinite(plan[key]) || plan[key] < 0)) throw Error(`计划指标 ${key} 无效。`);
  return plan;
}
export function planNodes(node: PlanNode): PlanNode[] { return [node, ...(node.Plans ?? []).flatMap(planNodes)]; }
export function estimateWarning(node: PlanNode): string | null {
  const expected = node['Plan Rows'], actual = node['Actual Rows'];
  if (expected === undefined || actual === undefined || node['Actual Loops'] === 0) return null;
  if (expected === actual) return null;
  if (!expected || !actual) return '估算与实际行数包含零值，请检查过滤条件和统计信息。';
  const ratio = Math.max(expected / actual, actual / expected);
  return ratio >= 10 ? `估算与实际行数相差 ${ratio.toFixed(1)} 倍；可检查统计信息和数据分布。` : null;
}
