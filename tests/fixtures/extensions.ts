import type { Extensions } from '@electric-sql/pglite';
import { extensionCatalog } from '../../src/extensions';

export function testExtensions(): Extensions {
  return Object.fromEntries(extensionCatalog.map(item => [item.name,
    new URL(item.name === 'vector' ? '../../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz'
      : `../../node_modules/@electric-sql/pglite/dist/${item.name}.tar.gz`, import.meta.url)]));
}
