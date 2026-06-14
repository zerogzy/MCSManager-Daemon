import { dbAll, dbGet, dbRun } from "./shop_database";
import { InstancePrice } from "../entity/shop_order";

class ShopPriceService {
  /**
   * Get price for a specific instance
   */
  getPrice(daemonId: string, instanceUuid: string): InstancePrice | null {
    const row = dbGet<any>(
      "SELECT * FROM shop_instance_prices WHERE daemon_id = ? AND instance_uuid = ?",
      [daemonId, instanceUuid]
    );
    if (!row) return null;
    return this.mapRowToPrice(row);
  }

  /**
   * Set or update price for an instance
   */
  setPrice(
    daemonId: string,
    instanceUuid: string,
    basePrice: number,
    quarterlyDiscount: number,
    yearlyDiscount: number,
    updatedBy: string
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.getPrice(daemonId, instanceUuid);
    if (existing) {
      dbRun(
        "UPDATE shop_instance_prices SET base_price = ?, quarterly_discount = ?, yearly_discount = ?, updated_at = ?, updated_by = ? WHERE daemon_id = ? AND instance_uuid = ?",
        [basePrice, quarterlyDiscount, yearlyDiscount, now, updatedBy, daemonId, instanceUuid]
      );
    } else {
      dbRun(
        "INSERT INTO shop_instance_prices (daemon_id, instance_uuid, base_price, quarterly_discount, yearly_discount, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [daemonId, instanceUuid, basePrice, quarterlyDiscount, yearlyDiscount, now, updatedBy]
      );
    }
  }

  /**
   * Get prices for multiple instances (batch query)
   */
  getPricesByInstances(
    instances: Array<{ daemonId: string; instanceUuid: string }>
  ): InstancePrice[] {
    if (instances.length === 0) return [];
    const results: InstancePrice[] = [];
    for (const inst of instances) {
      const price = this.getPrice(inst.daemonId, inst.instanceUuid);
      if (price) results.push(price);
    }
    return results;
  }

  /**
   * Get all price records
   */
  getAllPrices(): InstancePrice[] {
    const rows = dbAll<any>("SELECT * FROM shop_instance_prices");
    return rows.map((row) => this.mapRowToPrice(row));
  }

  private mapRowToPrice(row: any): InstancePrice {
    return {
      daemonId: row.daemon_id,
      instanceUuid: row.instance_uuid,
      basePrice: row.base_price,
      quarterlyDiscount: row.quarterly_discount,
      yearlyDiscount: row.yearly_discount,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    };
  }
}

export default new ShopPriceService();
