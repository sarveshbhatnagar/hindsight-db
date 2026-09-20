import {
  all,
  asArray,
  chunks,
  inList,
  insertStatements,
  prefixUpperBound,
  run,
  tx,
  type Op,
  type Storage,
} from "../storage/storage.js";
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
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Map `externalId` to one or more timeline labels. Existing pairs are ignored. */
  async add(externalId: string, entity: string | string[]): Promise<void> {
    await this.storage.run(
      tx(function* () {
        assertEntity("alias.externalId", externalId);
        const entities = asArray(entity)!.map((e) => assertEntity("alias.entity", e));
        const statements = insertStatements(
          "entity_aliases",
          ["external_id", "entity"],
          entities.map((e) => [externalId, e]),
          " ON CONFLICT DO NOTHING",
        );
        for (const s of statements) yield* run(s.sql, s.params);
      }),
    );
  }

  /** Remove one mapping. Returns whether it existed. */
  async remove(externalId: string, entity: string): Promise<boolean> {
    const r = await this.storage.run(run(`DELETE FROM entity_aliases WHERE external_id = ? AND entity = ?`, [externalId, entity]));
    return r.changes > 0;
  }

  /** Labels for each external id, keyed by external id (an empty list for ids with no aliases). */
  async forExternal(externalIds: string[]): Promise<Map<string, string[]>> {
    return this.storage.run(this.lookup(externalIds));
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
    const where = clauses.length ? clauses.join(" AND ") : "1=1";
    return this.storage.run(
      all<Alias>(
        `SELECT external_id AS "externalId", entity FROM entity_aliases WHERE ${where}
         ORDER BY external_id ASC, entity ASC LIMIT ?`,
        [...params, limit],
      ),
    );
  }

  /**
   * Expand each list of entities to the union of the labels themselves and
   * their aliases, preserving order (originals first). One query serves all
   * lists, so batched callers pay for a single lookup.
   */
  *expandEach(lists: readonly (readonly string[])[]): Op<string[][]> {
    const aliases = yield* this.lookup([...new Set(lists.flat())]);
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

  *expand(entities: readonly string[]): Op<string[]> {
    return (yield* this.expandEach([entities]))[0]!;
  }

  private *lookup(externalIds: readonly string[]): Op<Map<string, string[]>> {
    const out = new Map<string, string[]>(externalIds.map((id) => [id, []]));
    if (externalIds.length === 0) return out;
    for (const chunk of chunks([...out.keys()])) {
      const l = inList("external_id", chunk);
      const rows = yield* all<{ external_id: string; entity: string }>(
        `SELECT external_id, entity FROM entity_aliases WHERE ${l.sql} ORDER BY external_id, entity`,
        l.params,
      );
      for (const r of rows) out.get(r.external_id)!.push(r.entity);
    }
    return out;
  }
}
