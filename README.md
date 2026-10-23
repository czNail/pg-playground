# PostgreSQL 实验台

在浏览器里运行 PostgreSQL，编写 SQL、探索表结构、比较执行计划。纯静态网页，无需数据库服务器。

目标地址：<https://cznail.github.io/pg-playground/>

## 功能

- CodeMirror 编辑器：SQL 高亮、补全、选区运行、Ctrl / ⌘ + Enter。
- 多条 SQL 与多个结果集，保留重复列名。
- 9 个常用扩展：显示可用/已安装版本，单独启用或一键全部启用，每个扩展附 SQL 示例。
- EXPLAIN 计划树、节点详情及原始 JSON；ANALYZE 按钮在只读事务中执行，拒绝写入。
- 自动刷新表/视图结构，一键载入预览 SQL。
- IndexedDB 持久化，本地保存 SQL 草稿与最近 30 次历史；提供临时内存模式。
- SQL 文件导入、保存，CSV 导出，一键重置数据库。
- 预置 1,000 位客户与 20,000 条订单，覆盖扫描、索引、连接、聚合与窗口函数。
- 复用主页公共导航、页脚、字体、品牌颜色和浅色/深色主题。

## 本地开发

使用 Node.js 24：

```sh
npm ci
npm run dev
```

访问终端给出的 `/pg-playground/` 地址。验证与构建：

```sh
npm test
npm run build
```

构建产物在 `dist/`，可通过 `npm run preview` 预览。部署路径由 `vite.config.ts` 的 `base` 指定。WASM 与数据库初始化资源随网站部署，运行时无需 CDN。

## GitHub Pages

1. 仓库 Settings → Pages → Build and deployment，将 Source 设为 **GitHub Actions**。首次启用需要仓库管理权限。
2. 推送 `main`，或者运行 **Deploy PostgreSQL playground** 工作流。
3. 工作流先运行真实 PGlite 测试、公共样式校验、TypeScript 检查与生产构建，再部署 Pages。PR 仅检查，不部署。

`homepage.json` 提供主页项目卡片和“小工具”入口。主页下一次成功同步部署后收录；当前入口需 Pages 开启且不返回 404/410。

## 常用扩展

工作台下方展开“扩展”，点击“启用”或“启用全部”；点击“查看示例”只载入 SQL，不会自动执行。也可手动运行 `CREATE EXTENSION`，执行后面板会刷新真实安装状态。

| 扩展 | 示例内容 |
| --- | --- |
| pgvector（SQL 名称 `vector`） | 向量表、HNSW 索引和余弦距离检索 |
| pg_trgm | 文本相似度与模糊匹配 |
| citext | 忽略大小写的比较 |
| hstore | 文本键值对 |
| ltree | 层级路径及祖先、后代查询 |
| pgcrypto | SHA-256 摘要 |
| uuid-ossp | 随机 UUID 和确定性 UUID |
| pageinspect | 堆页中的元组信息 |
| pg_visibility | 数据页可见性与可见性映射 |

- 扩展资源随站点部署，运行时不依赖 CDN。pgvector 适配包固定为 `@electric-sql/pglite-pgvector@0.0.12`，与 `PGlite@0.5.11` 配套。
- 扩展资源在每次启动、刷新、停止后恢复及重置时一致注册；启用状态存于数据库 `pg_extension`，不另存浏览器开关。页面加载不会自动启用扩展。
- 面板启用操作要求先结束用户事务，全部启用在单一事务内完成。手写 SQL 仍保留原生事务语义；面板不提供会删除依赖对象的停用按钮。
- 示例仅在明确运行后创建 `playground_examples` 中的演示表，采用固定主键和 `ON CONFLICT DO NOTHING`，可重复运行。
- 持久化模式刷新和超时恢复保留已提交的扩展、向量数据与索引；临时模式从最近保存的快照恢复。重置清空数据库中的扩展与示例表，但可再次启用。
- 内部结构扩展观察浏览器本地实例；向量索引的小数据示例可能使用顺序扫描，不能据此推断服务器上的性能。

## 数据与运行边界

- 数据只保存在访问者浏览器，不会发送到服务器，不会跨设备自动同步。清理网站数据会删除数据库、草稿及历史；SQL 文件导出不是数据库备份。
- 数据库运行于独立 Worker。持久化模式通过 Web Locks 限制一个浏览器中仅一个实验台标签页打开数据库；另一页会提示关闭其他页面或使用临时模式。临时模式不覆盖持久化数据库。
- 数据目录 `idb://neil-pg-playground-v1` 对应 IndexedDB `/pglite/neil-pg-playground-v1`。重置只删除此数据库，不清理同源其他工具的数据，保留 SQL 草稿与历史记录。
- 初始化标记与示例生成位于同一事务，刷新不会重复插入示例，也不会因用户删除示例表而自动重建。重置后才恢复示例。
- 每条语句最多向页面返回、导出前 1,000 行，每页显示 100 行。查询仍可能在 Worker 中产生大量数据，请使用 LIMIT 限制大结果。
- 运行时限可选 5 秒、30 秒、60 秒（默认）、5 分钟或不限；运行中可点击“停止查询”。WASM 查询不能直接中断，因此由主线程终止 Worker 并自动恢复连接，全程保持持久化数据库锁，不会自动重试 SQL。
- 停止后持久化模式重新打开已保存的数据库，临时模式恢复最近一次完成且不在事务中的快照。未完成事务和会话设置会清除；多语句中已提交的内容请先检查，避免重复写入。启动与保存各有两分钟保护时限，`lock_timeout=5s`。
- EXPLAIN/ANALYZE 按钮使用单语句协议，拒绝多语句。ANALYZE 按钮使用只读事务，用户存在未结束事务时要求先 COMMIT / ROLLBACK。手工运行的 SQL 按原意执行，包括写入、显式事务及 EXPLAIN ANALYZE。
- 显示耗时含浏览器和持久化开销，不代表服务器 PostgreSQL 性能。扩展能力以 PGlite 为准，不模拟服务端并行、多进程或真实磁盘 I/O。

## 公共外观

上游为 `czNail/cznail.github.io/packages/site-ui`。`vendor/site-ui` 是不可手改的已校验快照，版本与 SHA-256 存于 `site-ui.lock.json`。普通构建无需访问上游。

```sh
node scripts/sync-site-ui.mjs --update
npm test
npm run build
```

定时 **Update shared site UI** 工作流检查上游并尝试创建升级 PR。GitHub 需允许 Actions 创建 PR；不允许时可本地执行上述命令后提交。页面布局在 `src/style.css`，共享品牌变量通过 `var(--site-*)` 使用。

## 验证

`tests/extensions.test.ts` 运行全部 9 个真实扩展示例并验证快照恢复、启用幂等及事务保护。`tests/recovery.test.ts` 使用真实 PostgreSQL Worker 验证扩展状态、向量表及索引在停止、重连和重置后的行为，并覆盖长查询超时、手动停止、自动重连、持久化与临时模式数据保留、事务回滚和锁保留。`tests/database.test.ts` 覆盖初始化幂等性、多语句、重复列名、结果上限、索引前后计划变化、只读分析、事务恢复及 CSV。HTTPS 正式站点已实测：SQL 查询与计划交互、刷新后的 IndexedDB 数据和 SQL 草稿恢复、第二标签页占用保护、数据库重置与共享主题保留。HTTP 本地预览另覆盖临时模式、CSV 下载及结果安全渲染。
