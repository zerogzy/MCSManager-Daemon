import initSqlJs, { Database } from "sql.js";
import fs from "fs-extra";
import path from "path";
import { logger } from "./log";
import { $t } from "../i18n";

let db: Database | null = null;
let dbPath: string = "";
let isDirty = false;

const ORDERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS shop_orders (
  id TEXT PRIMARY KEY,
  trade_order_id TEXT UNIQUE NOT NULL,
  user_uuid TEXT NOT NULL,
  user_name TEXT NOT NULL,
  daemon_id TEXT NOT NULL,
  instance_uuid TEXT NOT NULL,
  instance_nickname TEXT DEFAULT '',
  period_type TEXT NOT NULL,
  period_months INTEGER NOT NULL,
  amount REAL NOT NULL,
  base_price REAL NOT NULL,
  discount_rate REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  transaction_id TEXT DEFAULT '',
  pay_url TEXT DEFAULT '',
  pay_time INTEGER DEFAULT 0,
  expire_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const PRICES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS shop_instance_prices (
  daemon_id TEXT NOT NULL,
  instance_uuid TEXT NOT NULL,
  base_price REAL NOT NULL,
  quarterly_discount REAL NOT NULL DEFAULT 0.9,
  yearly_discount REAL NOT NULL DEFAULT 0.8,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (daemon_id, instance_uuid)
)`;

const INDEX_SQLS = [
  "CREATE INDEX IF NOT EXISTS idx_orders_user_uuid ON shop_orders(user_uuid)",
  "CREATE INDEX IF NOT EXISTS idx_orders_status ON shop_orders(status)",
  "CREATE INDEX IF NOT EXISTS idx_orders_daemon_instance ON shop_orders(daemon_id, instance_uuid)"
];

function saveToDisk() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    isDirty = false;
  } catch (err) {
    logger.error(`[ShopDB] Failed to save database to disk: ${err}`);
  }
}

/** Save to disk only if data has changed since last save */
function saveIfDirty() {
  if (isDirty) {
    saveToDisk();
  }
}

let saveTimer: ReturnType<typeof setInterval> | null = null;

export async function initShopDatabase() {
  try {
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirsSync(dataDir);
    }
    dbPath = path.join(dataDir, "shop.db");

    const SQL = await initSqlJs();

    // Load existing database if it exists
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
      logger.info("[ShopDB] Loaded existing database from disk.");
    } else {
      db = new SQL.Database();
      logger.info("[ShopDB] Created new database.");
    }

    // Create tables
    db.run(ORDERS_TABLE_SQL);
    db.run(PRICES_TABLE_SQL);
    for (const sql of INDEX_SQLS) {
      db.run(sql);
    }

    // Save initial state to disk
    saveToDisk();

    // Auto-save every 30 seconds (only if dirty)
    saveTimer = setInterval(saveIfDirty, 30000);

    logger.info("[ShopDB] Shop database initialized successfully.");
  } catch (err) {
    logger.error(`[ShopDB] Failed to initialize shop database: ${err}`);
    throw err;
  }
}

export function closeShopDatabase() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (db) {
    saveToDisk(); // Always save on close
    db.close();
    db = null;
    logger.info("[ShopDB] Shop database closed.");
  }
}

export function getDB(): Database {
  if (!db) {
    throw new Error("[ShopDB] Database not initialized. Call initShopDatabase() first.");
  }
  return db;
}

/** Execute a run (INSERT/UPDATE/DELETE) and mark as dirty for deferred save */
export function dbRun(sql: string, params?: any[]) {
  const database = getDB();
  database.run(sql, params);
  isDirty = true;
}

/**
 * Force save to disk immediately.
 * Should be called after critical operations (e.g., payment callback processing).
 */
export function dbFlush() {
  saveToDisk();
}

/** Execute a query and return all rows as objects */
export function dbAll<T = any>(sql: string, params?: any[]): T[] {
  const database = getDB();
  const stmt = database.prepare(sql);
  if (params) stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

/** Execute a query and return the first row as object, or null */
export function dbGet<T = any>(sql: string, params?: any[]): T | null {
  const database = getDB();
  const stmt = database.prepare(sql);
  if (params) stmt.bind(params);
  if (stmt.step()) {
    const result = stmt.getAsObject() as T;
    stmt.free();
    return result;
  }
  stmt.free();
  return null;
}
