import type { PoolClient } from "pg";
import type { RelationCycleIssue } from "@harness-anything/kernel";

interface Node {
  readonly component_id: string;
  readonly priority: string;
  left_id: string | null;
  right_id: string | null;
  height: number;
}
const scopedType = "tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader_key=$4 AND relation_type=$5";

/** An AVL index over existing component rows. Comparisons use the same JS collation as the
 * kernel, independent of the PostgreSQL/PGlite build's locale provider. Only O(log C) metadata
 * is read on a component change; the one winning issue is copied to the existing result row.
 * The caller holds the scope count lock for the entire maintenance transaction. */
export class PgRelationCycleWinners {
  private readonly nodes = new Map<string, Node>();
  private readonly client: PoolClient;
  private readonly keys: readonly unknown[];
  private root: string | null;
  private constructor(client: PoolClient, keys: readonly unknown[], root: string | null) {
    this.client = client;
    this.keys = keys;
    this.root = root;
  }

  static async open(client: PoolClient, keys: readonly unknown[]): Promise<PgRelationCycleWinners> {
    const result = await client.query<{ root_component_id: string }>(
      `SELECT root_component_id FROM ha_relation_cycle_result WHERE ${scopedType}`,
      [...keys],
    );
    return new PgRelationCycleWinners(client, keys, result.rows[0]?.root_component_id ?? null);
  }

  async insert(id: string, priority: string, issue: RelationCycleIssue): Promise<void> {
    await this.client.query(
      `INSERT INTO ha_relation_cycle_component(tenant_id,project_id,policy_epoch,reader_key,relation_type,component_id,priority,issue_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [...this.keys, id, priority, JSON.stringify(issue)],
    );
    const node: Node = { component_id: id, priority, left_id: null, right_id: null, height: 1 };
    this.nodes.set(id, node);
    this.root = await this.insertAt(this.root, node);
  }

  async remove(id: string): Promise<void> {
    const node = await this.get(id);
    this.root = await this.removeAt(this.root!, node);
    await this.client.query(`DELETE FROM ha_relation_cycle_component WHERE ${scopedType} AND component_id=$6`, [
      ...this.keys,
      id,
    ]);
    this.nodes.delete(id);
  }

  async publish(): Promise<void> {
    if (this.root === null) {
      await this.client.query(`DELETE FROM ha_relation_cycle_result WHERE ${scopedType}`, [...this.keys]);
      return;
    }
    const winner = await this.minimum(this.root);
    await this.client.query(
      `INSERT INTO ha_relation_cycle_result(tenant_id,project_id,policy_epoch,reader_key,relation_type,root_component_id,issue_json)
       SELECT $1,$2,$3,$4,$5,$7,issue_json FROM ha_relation_cycle_component WHERE ${scopedType} AND component_id=$6
       ON CONFLICT (tenant_id,project_id,policy_epoch,reader_key,relation_type) DO UPDATE
         SET root_component_id=EXCLUDED.root_component_id,issue_json=EXCLUDED.issue_json`,
      [...this.keys, winner.component_id, this.root],
    );
  }

  private async get(id: string): Promise<Node> {
    let node = this.nodes.get(id);
    if (!node) {
      node = (
        await this.client.query<Node>(
          `SELECT component_id,priority,left_id,right_id,height FROM ha_relation_cycle_component WHERE ${scopedType} AND component_id=$6`,
          [...this.keys, id],
        )
      ).rows[0]!;
      this.nodes.set(id, node);
    }
    return node;
  }

  private async save(node: Node): Promise<string> {
    await this.client.query(
      `UPDATE ha_relation_cycle_component SET left_id=$7,right_id=$8,height=$9 WHERE ${scopedType} AND component_id=$6`,
      [...this.keys, node.component_id, node.left_id, node.right_id, node.height],
    );
    return node.component_id;
  }

  private async height(id: string | null): Promise<number> {
    return id === null ? 0 : (await this.get(id)).height;
  }

  private async tilt(node: Node): Promise<number> {
    return (await this.height(node.left_id)) - (await this.height(node.right_id));
  }

  private async rotate(node: Node, left: boolean): Promise<Node> {
    const pivot = await this.get((left ? node.right_id : node.left_id)!);
    if (left) {
      node.right_id = pivot.left_id;
      pivot.left_id = node.component_id;
    } else {
      node.left_id = pivot.right_id;
      pivot.right_id = node.component_id;
    }
    node.height = 1 + Math.max(await this.height(node.left_id), await this.height(node.right_id));
    await this.save(node);
    pivot.height = 1 + Math.max(await this.height(pivot.left_id), await this.height(pivot.right_id));
    return pivot;
  }

  private async balance(node: Node): Promise<string> {
    const tilt = await this.tilt(node);
    if (tilt > 1) {
      const child = await this.get(node.left_id!);
      if ((await this.tilt(child)) < 0) node.left_id = await this.save(await this.rotate(child, true));
      node = await this.rotate(node, false);
    } else if (tilt < -1) {
      const child = await this.get(node.right_id!);
      if ((await this.tilt(child)) > 0) node.right_id = await this.save(await this.rotate(child, false));
      node = await this.rotate(node, true);
    }
    node.height = 1 + Math.max(await this.height(node.left_id), await this.height(node.right_id));
    return this.save(node);
  }

  private async insertAt(id: string | null, node: Node): Promise<string> {
    if (id === null) return node.component_id;
    const current = await this.get(id);
    if (compare(node, current) < 0) current.left_id = await this.insertAt(current.left_id, node);
    else current.right_id = await this.insertAt(current.right_id, node);
    return this.balance(current);
  }

  private async minimum(id: string): Promise<Node> {
    let node = await this.get(id);
    while (node.left_id !== null) node = await this.get(node.left_id);
    return node;
  }

  private async removeAt(id: string, node: Node): Promise<string | null> {
    let current = await this.get(id);
    const order = compare(node, current);
    if (order < 0) current.left_id = await this.removeAt(current.left_id!, node);
    else if (order > 0) current.right_id = await this.removeAt(current.right_id!, node);
    else {
      if (current.left_id === null) return current.right_id;
      if (current.right_id === null) return current.left_id;
      // Move the successor row, preserving component identity and all member references.
      const successor = await this.minimum(current.right_id);
      successor.right_id = await this.removeAt(current.right_id, successor);
      successor.left_id = current.left_id;
      current = successor;
    }
    return this.balance(current);
  }
}

function compare(left: Node, right: Node): number {
  // Identity breaks collation-equal keys strictly, including canonically equivalent Unicode.
  return (
    left.priority.localeCompare(right.priority) ||
    (left.component_id < right.component_id ? -1 : Number(left.component_id > right.component_id))
  );
}
