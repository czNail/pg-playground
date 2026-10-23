import type { PGlite } from '@electric-sql/pglite';
import { quoteIdentifier } from './model';

export interface ExtensionState {
  name: string;
  availableVersion: string | null;
  installedVersion: string | null;
  schema: string | null;
  downloadable?: boolean;
}
const heapExample = `CREATE SCHEMA IF NOT EXISTS playground_examples;
CREATE TABLE IF NOT EXISTS playground_examples.heap_items (
  id INTEGER PRIMARY KEY, content TEXT
);
INSERT INTO playground_examples.heap_items VALUES (1, 'Hello, PostgreSQL!')
ON CONFLICT (id) DO NOTHING;`;
export const extensionCatalog = [
  {
    name: 'vector', label: 'pgvector', category: '向量检索',
    description: '向量类型、相似度查询与 HNSW / IVFFlat 索引。',
    sql: `CREATE SCHEMA IF NOT EXISTS playground_examples;
CREATE TABLE IF NOT EXISTS playground_examples.vector_items (
  id INTEGER PRIMARY KEY, content TEXT, embedding vector(3)
);
INSERT INTO playground_examples.vector_items VALUES
  (1, '数据库', '[1,0,0]'),
  (2, '索引', '[0.9,0.1,0]'),
  (3, '旅行', '[0,0,1]')
ON CONFLICT (id) DO NOTHING;
CREATE INDEX IF NOT EXISTS vector_items_embedding_hnsw
ON playground_examples.vector_items USING hnsw (embedding vector_cosine_ops);

-- 余弦距离越小越相似；选中最后这条 SELECT 可单独查看执行计划。
-- 小表可能选择顺序扫描，这是优化器的正常选择。
SELECT id, content, embedding <=> '[1,0,0]'::vector AS cosine_distance
FROM playground_examples.vector_items
ORDER BY embedding <=> '[1,0,0]'::vector
LIMIT 3;`
  },
  {
    name: 'postgis', label: 'PostGIS', category: '空间查询',
    description: '空间类型、距离与范围查询、GiST 索引。首次启用下载约 19 MB 并重连；保留已提交数据，会话设置恢复默认。',
    sql: `-- 请先在扩展面板启用 PostGIS，再运行本示例。
SELECT PostGIS_Full_Version();

CREATE SCHEMA IF NOT EXISTS playground_examples;
CREATE TABLE IF NOT EXISTS playground_examples.places (
  id INTEGER PRIMARY KEY, name TEXT, location geometry(Point, 4326)
);
INSERT INTO playground_examples.places VALUES
  (1, '故宫', ST_SetSRID(ST_MakePoint(116.397, 39.918), 4326)),
  (2, '天坛', ST_SetSRID(ST_MakePoint(116.407, 39.883), 4326)),
  (3, '颐和园', ST_SetSRID(ST_MakePoint(116.273, 39.999), 4326))
ON CONFLICT (id) DO NOTHING;
CREATE INDEX IF NOT EXISTS places_location_gist
ON playground_examples.places USING gist (location);

-- geography 距离以米计；geometry(4326) 的坐标单位是度。
SELECT id, name, ST_AsText(location) AS point,
       round(ST_Distance(location::geography,
         ST_SetSRID(ST_MakePoint(116.397, 39.908), 4326)::geography)) AS distance_m
FROM playground_examples.places
ORDER BY distance_m;

-- ST_Intersects 可利用 GiST 索引；小表仍可能选择顺序扫描。
-- 选中本条 SELECT 可比较执行计划。
SELECT id, name
FROM playground_examples.places
WHERE ST_Intersects(location, ST_MakeEnvelope(116.39, 39.88, 116.42, 39.93, 4326));`
  },
  {
    name: 'pg_trgm', label: 'pg_trgm', category: '文本搜索',
    description: '按三元组计算文本相似度，支持模糊搜索索引。',
    sql: `SELECT word, similarity(word, 'postgres') AS similarity,
       word % 'postgres' AS matches
FROM (VALUES ('postgresql'), ('postgres'), ('postgress'), ('mysql')) AS words(word)
ORDER BY similarity DESC;`
  },
  {
    name: 'citext', label: 'citext', category: '数据类型',
    description: '忽略大小写的文本类型与比较。',
    sql: `SELECT 'Neil'::citext = 'neil'::citext AS case_insensitive,
       'Neil'::text = 'neil'::text AS case_sensitive;`
  },
  {
    name: 'hstore', label: 'hstore', category: '数据类型',
    description: '在一个字段里存储、查询文本键值对。',
    sql: `WITH settings AS (
  SELECT hstore(ARRAY['database', 'mode'], ARRAY['PostgreSQL', 'local']) AS data
)
SELECT data, data -> 'database' AS database_name,
       data ? 'mode' AS has_mode
FROM settings;`
  },
  {
    name: 'ltree', label: 'ltree', category: '数据类型',
    description: '表示层级路径，查询祖先、后代及路径匹配。',
    sql: `SELECT path::ltree, nlevel(path::ltree) AS depth
FROM (VALUES ('db.postgresql.index'), ('db.postgresql.storage'), ('db.mysql')) AS topics(path)
WHERE 'db.postgresql'::ltree @> path::ltree;`
  },
  {
    name: 'pgcrypto', label: 'pgcrypto', category: '工具函数',
    description: '计算摘要，体验数据库加密函数。',
    sql: `SELECT encode(digest('Hello, PostgreSQL!', 'sha256'), 'hex') AS sha256;`
  },
  {
    name: 'uuid-ossp', label: 'uuid-ossp', category: '工具函数',
    description: '生成随机 UUID，或根据命名空间生成确定性 UUID。',
    sql: `SELECT uuid_generate_v4() AS random_uuid,
       uuid_generate_v5(uuid_ns_url(), 'https://cznail.github.io/') AS stable_uuid;`
  },
  {
    name: 'pageinspect', label: 'pageinspect', category: '内部结构',
    description: '观察当前实例中堆页、索引页的内部结构。',
    sql: `${heapExample}

SELECT lp, lp_flags, t_xmin, t_xmax, t_ctid
FROM heap_page_items(get_raw_page('playground_examples.heap_items', 0))
LIMIT 10;`
  },
  {
    name: 'pg_visibility', label: 'pg_visibility', category: '内部结构',
    description: '查看当前实例的数据页可见性与可见性映射。',
    sql: `${heapExample}

-- 刚写入且尚未 VACUUM 的页，all_visible 可能为 false。
SELECT blkno, all_visible, all_frozen, pd_all_visible
FROM pg_visibility('playground_examples.heap_items'::regclass)
LIMIT 10;`
  }
] as const;

export function extensionInstallSQL(names: readonly string[]) {
  if (!Array.isArray(names) || !names.length || names.some(name => !extensionCatalog.some(item => item.name === name))) {
    throw Error('请选择支持的扩展。');
  }
  return [...new Set(names)].map(name => `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(name)} WITH SCHEMA public;`).join('\n');
}
export function extensionExample(name: string) {
  const item = extensionCatalog.find(item => item.name === name);
  if (!item) throw Error('未知扩展。');
  return `-- ${item.label} · ${item.description}\n${extensionInstallSQL([name])}\n\n${item.sql}`;
}
export async function extensionStates(db: PGlite): Promise<ExtensionState[]> {
  const result = await db.query<ExtensionState>(`
    SELECT a.name, a.default_version AS "availableVersion", e.extversion AS "installedVersion", n.nspname AS schema
    FROM pg_available_extensions a
    LEFT JOIN pg_extension e ON e.extname = a.name
    LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE a.name = ANY($1::text[])`, [extensionCatalog.map(item => item.name)]);
  return extensionCatalog.map(item => result.rows.find(state => state.name === item.name) ?? {
    name: item.name, availableVersion: null, installedVersion: null, schema: null,
    ...(item.name === 'postgis' ? {downloadable: true} : {})
  });
}
export async function enableExtensions(db: PGlite, names: readonly string[]) {
  const sql = extensionInstallSQL(names);
  if (db.isInTransaction()) throw Error('请先 COMMIT 或 ROLLBACK 当前事务，再通过面板启用扩展。');
  await db.transaction(async tx => { await tx.exec(sql); });
  return extensionStates(db);
}
