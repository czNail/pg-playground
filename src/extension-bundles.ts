import type { Extensions } from '@electric-sql/pglite';
import vector from '../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz?url';
import pg_trgm from '../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz?url';
import citext from '../node_modules/@electric-sql/pglite/dist/citext.tar.gz?url';
import hstore from '../node_modules/@electric-sql/pglite/dist/hstore.tar.gz?url';
import ltree from '../node_modules/@electric-sql/pglite/dist/ltree.tar.gz?url';
import pgcrypto from '../node_modules/@electric-sql/pglite/dist/pgcrypto.tar.gz?url';
import uuid_ossp from '../node_modules/@electric-sql/pglite/dist/uuid-ossp.tar.gz?url';
import pageinspect from '../node_modules/@electric-sql/pglite/dist/pageinspect.tar.gz?url';
import pg_visibility from '../node_modules/@electric-sql/pglite/dist/pg_visibility.tar.gz?url';
import { postgis } from '@electric-sql/pglite-postgis';
import postgisBundle from '../node_modules/@electric-sql/pglite-postgis/dist/postgis.tar.gz?url';

// Base resources are always registered; PostGIS is optional until installed.
// CREATE EXTENSION in the database is the single source of truth for enablement.
export function extensionBundles(baseURL: string, withPostGIS = false): Extensions {
  const extensions: Extensions = Object.fromEntries(Object.entries({vector, pg_trgm, citext, hstore, ltree, pgcrypto,
    'uuid-ossp': uuid_ossp, pageinspect, pg_visibility}).map(([name, path]) => [name, new URL(path, baseURL)]));
  if (withPostGIS) extensions.postgis = {
    ...postgis,
    // Keep the official PROJ/GDAL setup, but serve the archive from this site.
    setup: async (pg, options) => ({...await postgis.setup(pg, options), bundlePath: new URL(postgisBundle, baseURL)})
  };
  return extensions;
}
