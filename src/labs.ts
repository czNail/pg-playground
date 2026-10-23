export interface Lab { id: string; name: string; goal: string; observe: string; steps: {name: string; sql: string; mode?: string}[] }
function setup(table: string, select: string) {
  return `-- 仅重建 playground_lab.${table}，不修改 public 中的初始数据。\nCREATE SCHEMA IF NOT EXISTS playground_lab;\nDROP TABLE IF EXISTS playground_lab.${table};\nCREATE TABLE playground_lab.${table} AS\n${select};\nANALYZE playground_lab.${table};`;
}
const orders = `SELECT i AS id, 1 + i % 1000 AS customer_id,\n       DATE '2025-01-01' + i % 365 AS created_at,\n       CASE WHEN i % 10 = 0 THEN 'pending' ELSE 'paid' END AS status,\n       (i * 137 % 100000)::numeric / 100 AS amount\nFROM generate_series(1, 20000) AS s(i)`;
export const labs: Lab[] = [
  {id: 'selectivity', name: '索引与选择性', goal: '比较少量匹配与大量匹配时的访问路径。', observe: '先将无索引计划保留为 A，再创建索引并分析。索引是否采用由优化器成本估算决定，顺序扫描也可能合理。', steps: [
    {name: '1 · 准备 / 复位数据', sql: setup('scan_orders', orders)},
    {name: '2 · 少量匹配', sql: 'SELECT * FROM playground_lab.scan_orders WHERE customer_id = 42;', mode: 'analyze'},
    {name: '3 · 创建索引', sql: 'CREATE INDEX IF NOT EXISTS lab_scan_customer ON playground_lab.scan_orders(customer_id);\nANALYZE playground_lab.scan_orders;'},
    {name: '4 · 再次少量匹配', sql: 'SELECT * FROM playground_lab.scan_orders WHERE customer_id = 42;', mode: 'analyze'},
    {name: '5 · 大量匹配', sql: 'SELECT * FROM playground_lab.scan_orders WHERE customer_id <= 900;', mode: 'analyze'}
  ]},
  {id: 'compound', name: '联合索引与排序', goal: '观察一个索引怎样同时服务过滤和排序。', observe: '比较索引前后的 Sort 节点、Index Cond 和扫描行数，再修改 customer_id 或排序方向观察变化。', steps: [
    {name: '1 · 准备 / 复位数据', sql: setup('compound_orders', orders)},
    {name: '2 · 过滤并排序', sql: 'SELECT * FROM playground_lab.compound_orders\nWHERE customer_id = 42\nORDER BY created_at DESC LIMIT 10;', mode: 'analyze'},
    {name: '3 · 创建联合索引', sql: 'CREATE INDEX IF NOT EXISTS lab_customer_date ON playground_lab.compound_orders(customer_id, created_at DESC);\nANALYZE playground_lab.compound_orders;'},
    {name: '4 · 再次分析', sql: 'SELECT * FROM playground_lab.compound_orders\nWHERE customer_id = 42\nORDER BY created_at DESC LIMIT 10;', mode: 'analyze'}
  ]},
  {id: 'limit', name: '排序与 LIMIT', goal: '观察返回少量结果怎样影响执行路径。', observe: '先保存无索引计划 A，再创建索引、重新运行。关注 Sort 是否消失，以及 Limit 下实际读取的行数。', steps: [
    {name: '1 · 准备 / 复位数据', sql: setup('rankings', 'SELECT i AS id, (i * 7919 % 100003) AS score FROM generate_series(1, 30000) AS s(i)')},
    {name: '2 · 查询前 20 名', sql: 'SELECT * FROM playground_lab.rankings ORDER BY score DESC LIMIT 20;', mode: 'analyze'},
    {name: '3 · 创建排序索引', sql: 'CREATE INDEX IF NOT EXISTS lab_score ON playground_lab.rankings(score DESC);\nANALYZE playground_lab.rankings;'},
    {name: '4 · 再次分析', sql: 'SELECT * FROM playground_lab.rankings ORDER BY score DESC LIMIT 20;', mode: 'analyze'}
  ]},
  {id: 'estimates', name: '统计信息与估算', goal: '观察数据变化后，统计信息如何影响行数估算。', observe: '先保存旧统计信息下的计划 A，再 ANALYZE 并比较。关注 rows 与 actual，每次循环的行数应在相同口径下比较。', steps: [
    {name: '1 · 准备 / 复位数据', sql: setup('distribution', "SELECT i AS id, CASE WHEN i % 100 = 0 THEN 'hot' ELSE 'cold' END AS kind FROM generate_series(1, 20000) AS s(i)") + "\nUPDATE playground_lab.distribution SET kind = 'hot' WHERE id % 10 <> 0;"},
    {name: '2 · 查看估算偏差', sql: "SELECT * FROM playground_lab.distribution WHERE kind = 'hot';", mode: 'analyze'},
    {name: '3 · 更新统计信息', sql: 'ANALYZE playground_lab.distribution;'},
    {name: '4 · 再次分析', sql: "SELECT * FROM playground_lab.distribution WHERE kind = 'hot';", mode: 'analyze'}
  ]},
  {id: 'window', name: '窗口函数与聚合', goal: '比较保留每一行的窗口计算与分组汇总。', observe: '比较两条 SQL 的结果行数与 WindowAgg / Aggregate 节点；可以自由修改分区、排序或窗口边界。', steps: [
    {name: '1 · 准备 / 复位数据', sql: setup('window_orders', orders)},
    {name: '2 · 分组汇总', sql: 'SELECT customer_id, sum(amount) AS total\nFROM playground_lab.window_orders GROUP BY customer_id;', mode: 'analyze'},
    {name: '3 · 保留订单明细', sql: 'SELECT id, customer_id, amount,\n       sum(amount) OVER (PARTITION BY customer_id) AS customer_total\nFROM playground_lab.window_orders;', mode: 'analyze'}
  ]}
];
