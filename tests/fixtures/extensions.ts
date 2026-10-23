import type { Extensions } from '@electric-sql/pglite';
import { extensionCatalog } from '../../src/extensions';
import { postgis } from '@electric-sql/pglite-postgis';

export function testExtensions(withPostGIS = false): Extensions {
  return {...Object.fromEntries(extensionCatalog.filter(item => item.name !== 'postgis').map(item => [item.name,
    new URL(item.name === 'vector' ? '../../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz'
      : `../../node_modules/@electric-sql/pglite/dist/${item.name}.tar.gz`, import.meta.url)])),
    ...(withPostGIS ? {postgis} : {})};
}
