import type { Connection } from "../storage/sqlite.js";
import { asArray, chunks, inList, prefixUpperBound } from "../storage/sqlite.js";
import type { Alias, AliasListQuery } from "../types.js";
import { assertEntity, assertLimit } from "../validate.js";

/**
 * Maps external entity ids (how an event names an entity, e.g. an insights
 * entity id "42") to the labels timeline data is keyed by (e.g. "AAPL").
 * When an event's entities are used to select its timeline window, each one
 * is expanded to itself plus its aliases. Empty by default, so a database
 * that keys both by the same labels is unaffected.
 */
export class AliasStore {
  private readonly conn: Connection;
  private readonly prepared;

  constructor(conn: Connection) {
    this.conn = conn;
    this.prepared = {
      insert: conn.db.prepare(`INSERT OR IGNORE INTO entity_aliases (external_id, entity) VALUES (?, ?)`),
      delete: conn.db.prepare(`DELETE FROM entity_aliases WHERE external_id = ? AND entity = ?`),
    };
  }

  /** Map `externalId` to one or more timeline labels. Existing pairs are ignored. */
  async add(externalId: string, entity: string | string[]): Promise<void> {
    this.conn.transaction(() => {
      assertEntity("alias.externalId", externalId);
      const entities = asArray(entity)!.map((e) => assertEntity("alias.entity", e));
      for (const e of entities) this.prepared.insert.run(externalId, e);
    });
  }

  /** Remove one mapping. Returns whether it existed. */
  async remove(externalId: string, entity: string): Promise<boolean> {
    return this.prepared.delete.run(externalId, entity).changes > 0;
  }

  /** Labels for each external id, keyed by external id (an empty list for ids with no aliases). */
  async forExternal(externalIds: string[]): Promise<Map<string, string[]>> {
    return this.lookup(externalIds);
  }

  /** Mappings ordered by (externalId, entity); `prefix` filters on the external id. */
  async list(query: AliasListQuery = {}): Promise<Alias[]> {
    const limit = assertLimit("limit", query.limit, 1000, 100_000);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.prefix) {
      clauses.push("external_id >= ? AND external_id < ?");
      params.push(query.prefix, prefixUpperBound(query.prefix));
    }
    const where = clauses.length ? clauses.join(" AND ") : "1";
    return this.conn.db
      .prepare(
        `SELECT external_id AS externalId, entity FROM entity_aliases WHERE ${where}
         ORDER BY external_id ASC, entity ASC LIMIT ?`,
      )
      .all(...params, limit) as Alias[];
  }

  /**
   * Expand each list of entities to the union of the labels themselves and
   * their aliases, preserving order (originals first). One query serves all
   * lists, so batched callers pay for a single lookup.
   */
  expandEach(lists: readonly (readonly string[])[]): string[][] {
    const aliases = this.lookup([...new Set(lists.flat())]);
    return lists.map((entities) => {
      const out = [...entities];
      const seen = new Set(entities);
      for (const e of entities) {
        for (const alias of aliases.get(e)!) {
          if (!seen.has(alias)) {
            seen.add(alias);
            out.push(alias);
          }
        }
      }
      return out;
    });
  }

  expand(entities: readonly string[]): string[] {
    return this.expandEach([entities])[0]!;
  }

  private lookup(externalIds: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>(externalIds.map((id) => [id, []]));
    if (externalIds.length === 0) return out;
    for (const chunk of chunks([...out.keys()])) {
      const l = inList("external_id", chunk);
      const rows = this.conn.db
        .prepare(`SELECT external_id, entity FROM entity_aliases WHERE ${l.sql} ORDER BY external_id, entity`)
        .all(...l.params) as { external_id: string; entity: string }[];
      for (const r of rows) out.get(r.external_id)!.push(r.entity);
    }
    return out;
  }
}
