export const examples = [
  {
    id: 'welcome', name: '浏览订单', hint: '从一张表开始，运行你的第一条查询。',
    sql: `-- 欢迎来到 PostgreSQL 实验台。\n-- 选中部分 SQL 可单独执行，Ctrl / ⌘ + Enter 运行。\nSELECT id, customer_id, amount, status, created_at\nFROM public.orders\nORDER BY id\nLIMIT 10;`
  },
  {
    id: 'scan', name: '观察扫描方式', hint: '先查看执行计划，再试试“创建索引”示例。',
    sql: `-- 点击 EXPLAIN 查看估算，ANALYZE 查看实际执行。\nSELECT id, customer_id, amount, status\nFROM public.orders\nWHERE customer_id = 42;`
  },
  {
    id: 'index', name: '创建索引', hint: '运行后，返回“观察扫描方式”，比较执行计划的变化。',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_customer_id\nON public.orders (customer_id);\n\nANALYZE public.orders;`
  },
  {
    id: 'join', name: '连接与聚合', hint: '观察 Join、Aggregate 和 Sort 如何配合。',
    sql: `SELECT c.name, c.city,\n       COUNT(*) AS order_count,\n       SUM(o.amount) AS total_amount\nFROM public.customers AS c\nJOIN public.orders AS o ON o.customer_id = c.id\nWHERE o.status = 'paid'\nGROUP BY c.id, c.name, c.city\nORDER BY total_amount DESC\nLIMIT 10;`
  },
  {
    id: 'window', name: '窗口函数', hint: '按城市排名，保留每位客户自己的行。',
    sql: `SELECT name, city, total_amount,\n       DENSE_RANK() OVER (\n         PARTITION BY city ORDER BY total_amount DESC\n       ) AS city_rank\nFROM (\n  SELECT c.id, c.name, c.city, SUM(o.amount) AS total_amount\n  FROM public.customers c\n  JOIN public.orders o ON o.customer_id = c.id\n  GROUP BY c.id, c.name, c.city\n) customer_totals\nORDER BY city, city_rank\nLIMIT 20;`
  },
  {
    id: 'scratch', name: '自由实验', hint: '创建自己的表。数据会保存在当前浏览器。',
    sql: `CREATE TABLE IF NOT EXISTS public.notes (\n  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  content TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT now()\n);\n\nINSERT INTO public.notes (content)\nVALUES ('Hello, PostgreSQL!');\n\nSELECT * FROM public.notes;`
  }
];

export const seedSQL = `
CREATE TABLE public.customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL
);
INSERT INTO public.customers
SELECT i, '客户 ' || lpad(i::text, 4, '0'),
       (ARRAY['上海', '北京', '杭州', '深圳', '成都'])[1 + (i % 5)]
FROM generate_series(1, 1000) AS s(i);
CREATE TABLE public.orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES public.customers(id),
  amount NUMERIC(10, 2) NOT NULL,
  status TEXT NOT NULL,
  created_at DATE NOT NULL
);
INSERT INTO public.orders
SELECT i, 1 + ((i * 37) % 1000),
       (100 + (i * 137) % 99900)::numeric / 100,
       (ARRAY['paid', 'pending', 'cancelled'])[1 + (i % 3)],
       DATE '2025-01-01' + (i % 365)
FROM generate_series(1, 20000) AS s(i);
ANALYZE public.customers;
ANALYZE public.orders;
`;
