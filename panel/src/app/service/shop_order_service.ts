import { dbAll, dbGet, dbRun } from "./shop_database";
import { ShopOrder, OrderStatus, PeriodType, PERIOD_MONTHS } from "../entity/shop_order";

class ShopOrderService {
  /**
   * Create a new order
   */
  createOrder(order: Omit<ShopOrder, "createdAt" | "updatedAt">): void {
    const now = Math.floor(Date.now() / 1000);
    dbRun(
      `INSERT INTO shop_orders (id, trade_order_id, user_uuid, user_name, daemon_id, instance_uuid,
       instance_nickname, period_type, period_months, amount, base_price, discount_rate,
       status, transaction_id, pay_url, pay_time, expire_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id, order.tradeOrderId, order.userUuid, order.userName,
        order.daemonId, order.instanceUuid, order.instanceNickname,
        order.periodType, order.periodMonths, order.amount, order.basePrice,
        order.discountRate, order.status, order.transactionId, order.payUrl,
        order.payTime, order.expireTime, now, now
      ]
    );
  }

  /**
   * Get order by ID
   */
  getOrderById(id: string): ShopOrder | null {
    const row = dbGet<any>("SELECT * FROM shop_orders WHERE id = ?", [id]);
    return row ? this.mapRowToOrder(row) : null;
  }

  /**
   * Get order by trade order ID
   */
  getOrderByTradeOrderId(tradeOrderId: string): ShopOrder | null {
    const row = dbGet<any>("SELECT * FROM shop_orders WHERE trade_order_id = ?", [tradeOrderId]);
    return row ? this.mapRowToOrder(row) : null;
  }

  /**
   * Update order fields
   */
  updateOrder(id: string, updates: Partial<ShopOrder>): void {
    const now = Math.floor(Date.now() / 1000);
    const setClauses: string[] = ["updated_at = ?"];
    const values: any[] = [now];

    const fieldMap: Record<string, string> = {
      status: "status",
      transactionId: "transaction_id",
      payUrl: "pay_url",
      payTime: "pay_time"
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if ((updates as any)[key] !== undefined) {
        setClauses.push(`${column} = ?`);
        values.push((updates as any)[key]);
      }
    }

    values.push(id);
    dbRun(`UPDATE shop_orders SET ${setClauses.join(", ")} WHERE id = ?`, values);
  }

  /**
   * Get orders for a specific user (paginated)
   */
  getOrdersByUserUuid(userUuid: string, page: number = 1, pageSize: number = 10): {
    data: ShopOrder[];
    total: number;
    page: number;
    maxPage: number;
  } {
    const countRow = dbGet<any>("SELECT COUNT(*) as count FROM shop_orders WHERE user_uuid = ?", [userUuid]);
    const total = countRow?.count ?? 0;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const offset = (Math.max(1, page) - 1) * pageSize;

    const rows = dbAll<any>(
      "SELECT * FROM shop_orders WHERE user_uuid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [userUuid, pageSize, offset]
    );

    return {
      data: rows.map((r) => this.mapRowToOrder(r)),
      total,
      page,
      maxPage
    };
  }

  /**
   * Get all orders (admin, paginated, with filters)
   */
  getAllOrders(page: number = 1, pageSize: number = 10, filters?: {
    userName?: string;
    status?: string;
  }): { data: ShopOrder[]; total: number; page: number; maxPage: number } {
    let whereClause = "1=1";
    const params: any[] = [];

    if (filters?.userName) {
      whereClause += " AND user_name LIKE ?";
      params.push(`%${filters.userName}%`);
    }
    if (filters?.status) {
      whereClause += " AND status = ?";
      params.push(filters.status);
    }

    const countRow = dbGet<any>(`SELECT COUNT(*) as count FROM shop_orders WHERE ${whereClause}`, params);
    const total = countRow?.count ?? 0;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const offset = (Math.max(1, page) - 1) * pageSize;

    const rows = dbAll<any>(
      `SELECT * FROM shop_orders WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return {
      data: rows.map((r) => this.mapRowToOrder(r)),
      total,
      page,
      maxPage
    };
  }

  /**
   * Get orders that are in RENEW_PENDING status (paid but renewal failed)
   */
  getRenewPendingOrders(): ShopOrder[] {
    const rows = dbAll<any>(
      "SELECT * FROM shop_orders WHERE status = ? ORDER BY updated_at ASC",
      [OrderStatus.RENEW_PENDING]
    );
    return rows.map((r) => this.mapRowToOrder(r));
  }

  /**
   * Find a pending (unpaid) order for a specific user and instance
   */
  getPendingOrderByInstance(userUuid: string, daemonId: string, instanceUuid: string): ShopOrder | null {
    const row = dbGet<any>(
      "SELECT * FROM shop_orders WHERE user_uuid = ? AND daemon_id = ? AND instance_uuid = ? AND status = ? AND expire_time > ?",
      [userUuid, daemonId, instanceUuid, OrderStatus.PENDING, Math.floor(Date.now() / 1000)]
    );
    return row ? this.mapRowToOrder(row) : null;
  }

  /**
   * Delete a single order by ID
   */
  deleteOrder(id: string): boolean {
    const existing = this.getOrderById(id);
    if (!existing) return false;
    dbRun("DELETE FROM shop_orders WHERE id = ?", [id]);
    return true;
  }

  /**
   * Delete all expired pending orders (actually remove from DB, not just mark)
   */
  deleteExpiredOrders(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = dbGet<any>(
      "SELECT COUNT(*) as count FROM shop_orders WHERE status = ? AND expire_time < ?",
      [OrderStatus.PENDING, now]
    );
    const count = result?.count ?? 0;
    if (count > 0) {
      dbRun(
        "DELETE FROM shop_orders WHERE status = ? AND expire_time < ?",
        [OrderStatus.PENDING, now]
      );
    }
    return count;
  }

  /**
   * Clean up expired pending orders (mark as expired)
   */
  cleanExpiredOrders(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = dbGet<any>(
      "SELECT COUNT(*) as count FROM shop_orders WHERE status = ? AND expire_time < ?",
      [OrderStatus.PENDING, now]
    );
    const count = result?.count ?? 0;
    if (count > 0) {
      dbRun(
        "UPDATE shop_orders SET status = ?, updated_at = ? WHERE status = ? AND expire_time < ?",
        [OrderStatus.EXPIRED, now, OrderStatus.PENDING, now]
      );
    }
    return count;
  }

  private mapRowToOrder(row: any): ShopOrder {
    return {
      id: row.id,
      tradeOrderId: row.trade_order_id,
      userUuid: row.user_uuid,
      userName: row.user_name,
      daemonId: row.daemon_id,
      instanceUuid: row.instance_uuid,
      instanceNickname: row.instance_nickname || "",
      periodType: row.period_type as PeriodType,
      periodMonths: row.period_months,
      amount: row.amount,
      basePrice: row.base_price,
      discountRate: row.discount_rate,
      status: row.status as OrderStatus,
      transactionId: row.transaction_id || "",
      payUrl: row.pay_url || "",
      payTime: row.pay_time || 0,
      expireTime: row.expire_time,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

export default new ShopOrderService();
