import axios from "axios";
import md5 from "md5";
import { v4 } from "uuid";
import { systemConfig } from "../setting";
import { logger } from "./log";
import shopOrderService from "./shop_order_service";
import shopPriceService from "./shop_price_service";
import { shopLock } from "./shop_lock";
import { dbFlush } from "./shop_database";
import { OrderStatus, PeriodType, PERIOD_MONTHS, ShopOrder } from "../entity/shop_order";
import { calculateAmount, addMonths, generateTradeOrderId, isPaymentConfigured } from "./shop_utils";
import RemoteServiceSubsystem from "./remote_service";
import RemoteRequest from "./remote_command";

/**
 * Generate hash signature for XunHuPay API
 */
export function generateHash(params: Record<string, any>, appSecret: string): string {
  const sortedKeys = Object.keys(params)
    .filter((key) => key !== "hash" && params[key] !== "" && params[key] != null)
    .sort();
  const stringA = sortedKeys.map((key) => `${key}=${params[key]}`).join("&");
  const stringSignTemp = stringA + appSecret;
  return md5(stringSignTemp);
}

/**
 * Create a payment order and get payment URL from XunHuPay
 */
export async function createPayment(order: ShopOrder): Promise<string> {
  if (!isPaymentConfigured()) {
    throw new Error("Payment is not configured. Please set up payment settings first.");
  }

  const params: Record<string, any> = {
    version: "1.1",
    appid: systemConfig!.payAppId,
    trade_order_id: order.tradeOrderId,
    total_fee: order.amount,
    title: `续费-${order.instanceNickname}`,
    time: Math.floor(Date.now() / 1000),
    notify_url: systemConfig!.payNotifyUrl,
    nonce_str: v4().replace(/-/g, "").substring(0, 16),
    type: "WAP",
    wap_url: systemConfig!.payNotifyUrl.replace(/\/api\/.*$/, ""),
    wap_name: "MCSM Shop",
    return_url: systemConfig!.payNotifyUrl.replace(/\/api\/.*$/, "") + "/#/shop"
  };

  params.hash = generateHash(params, systemConfig!.payAppSecret);

  const gatewayUrl = systemConfig!.payGatewayUrl || "https://api.xunhupay.com/payment/do.html";

  try {
    const response = await axios.post(gatewayUrl, new URLSearchParams(params), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000
    });

    const data = response.data;
    if (data.errcode !== 0) {
      logger.error(`[ShopPayment] Payment gateway error: ${data.errmsg}`);
      throw new Error(`Payment gateway error: ${data.errmsg}`);
    }

    // Verify the response hash
    const responseHash = generateHash(data, systemConfig!.payAppSecret);
    if (responseHash !== data.hash) {
      logger.error("[ShopPayment] Response hash verification failed");
      throw new Error("Payment response verification failed");
    }

    return data.url || data.url_qrcode || "";
  } catch (err: any) {
    if (err.message?.startsWith("Payment gateway")) throw err;
    logger.error(`[ShopPayment] Failed to create payment: ${err.message}`);
    throw new Error("Payment service is temporarily unavailable, please try again later.");
  }
}

/**
 * Process payment callback from XunHuPay
 */
export async function processPaymentCallback(callbackData: Record<string, any>): Promise<string> {
  const tradeOrderId = callbackData.trade_order_id;

  // Step 1: Verify signature
  const receivedHash = callbackData.hash;
  if (!receivedHash) {
    logger.warn("[ShopPayment] Callback missing hash field");
    return "success";
  }

  const calculatedHash = generateHash(callbackData, systemConfig!.payAppSecret);
  if (calculatedHash !== receivedHash) {
    logger.warn(`[ShopPayment] Callback hash verification failed for order: ${tradeOrderId}`);
    return "success";
  }

  // Step 1.5: Verify timestamp to prevent replay attacks
  // Callbacks with timestamps older than 5 minutes are rejected
  const CALLBACK_MAX_AGE_SECONDS = 5 * 60;
  const callbackTime = parseInt(String(callbackData.time), 10);
  if (!isNaN(callbackTime)) {
    const now = Math.floor(Date.now() / 1000);
    const age = Math.abs(now - callbackTime);
    if (age > CALLBACK_MAX_AGE_SECONDS) {
      logger.warn(
        `[ShopPayment] Callback rejected - timestamp too old for order: ${tradeOrderId}, age: ${age}s, max: ${CALLBACK_MAX_AGE_SECONDS}s`
      );
      return "success";
    }
  }

  // Step 2: Acquire lock
  let release: (() => void) | null = null;
  try {
    release = await shopLock.acquire(`callback:${tradeOrderId}`, 10000);
  } catch {
    logger.warn(`[ShopPayment] Failed to acquire lock for callback: ${tradeOrderId}`);
    return "success";
  }

  try {
    // Step 3: Find order
    const order = shopOrderService.getOrderByTradeOrderId(tradeOrderId);
    if (!order) {
      logger.warn(`[ShopPayment] Callback for unknown order: ${tradeOrderId}`);
      return "success";
    }

    // Step 4: Idempotent check
    if (order.status === OrderStatus.PAID) {
      return "success";
    }

    if (order.status === OrderStatus.RENEW_PENDING) {
      // Payment was received but renewal failed; try renewal again
      try {
        await extendInstanceEndTime(order.daemonId, order.instanceUuid, order.periodType, order.periodMonths);
        shopOrderService.updateOrder(order.id, { status: OrderStatus.PAID });
        dbFlush();
        logger.info(
          `[ShopPayment] Renewal retry succeeded for order: ${tradeOrderId}`
        );
      } catch (retryErr: any) {
        logger.warn(
          `[ShopPayment] Renewal retry still failing for order: ${tradeOrderId}, error: ${retryErr.message}`
        );
      }
      return "success";
    }

    if (order.status !== OrderStatus.PENDING) {
      return "success";
    }

    // Step 5: Verify payment status
    if (callbackData.status !== "OD") {
      logger.info(`[ShopPayment] Callback status not OD for order: ${tradeOrderId}, status: ${callbackData.status}`);
      return "success";
    }

    // Step 6: Verify amount
    const callbackAmount = parseFloat(callbackData.total_fee);
    if (Math.abs(callbackAmount - order.amount) > 0.01) {
      logger.error(
        `[ShopPayment] Amount mismatch for order: ${tradeOrderId}, expected: ${order.amount}, got: ${callbackAmount}`
      );
      shopOrderService.updateOrder(order.id, { status: OrderStatus.FAILED });
      return "success";
    }

    // Step 7: Try to extend instance end time FIRST, then mark order status
    const now = Math.floor(Date.now() / 1000);

    // Always record transaction info
    shopOrderService.updateOrder(order.id, {
      transactionId: callbackData.transaction_id || "",
      payTime: now
    });

    try {
      await extendInstanceEndTime(order.daemonId, order.instanceUuid, order.periodType, order.periodMonths);
      // Renewal succeeded -> mark as fully PAID
      shopOrderService.updateOrder(order.id, { status: OrderStatus.PAID });
      dbFlush(); // Ensure payment state is persisted immediately
      logger.info(
        `[ShopPayment] Payment successful, order: ${tradeOrderId}, instance extended by ${order.periodMonths} months`
      );
    } catch (extendErr: any) {
      // Renewal failed -> mark as RENEW_PENDING for automatic retry
      shopOrderService.updateOrder(order.id, { status: OrderStatus.RENEW_PENDING });
      dbFlush(); // Ensure RENEW_PENDING state is persisted immediately
      logger.error(
        `[ShopPayment] Payment received but renewal failed for order: ${tradeOrderId}, error: ${extendErr.message}. Order marked as RENEW_PENDING for retry.`
      );
    }

    return "success";
  } finally {
    release();
  }
}

/**
 * Retry pending renewals (called by scheduled task)
 * Processes orders in RENEW_PENDING status and attempts to extend their instances
 */
export async function retryPendingRenewals(): Promise<number> {
  const pendingOrders = shopOrderService.getRenewPendingOrders();
  if (pendingOrders.length === 0) return 0;

  let successCount = 0;
  for (const order of pendingOrders) {
    try {
      const release = await shopLock.acquire(`callback:${order.tradeOrderId}`, 10000);
      try {
        // Re-check status under lock
        const currentOrder = shopOrderService.getOrderById(order.id);
        if (!currentOrder || currentOrder.status !== OrderStatus.RENEW_PENDING) continue;

        await extendInstanceEndTime(order.daemonId, order.instanceUuid, order.periodType, order.periodMonths);
        shopOrderService.updateOrder(order.id, { status: OrderStatus.PAID });
        dbFlush();
        successCount++;
        logger.info(
          `[ShopPayment] Renewal retry succeeded for order: ${order.tradeOrderId}, instance extended by ${order.periodMonths} months`
        );
      } finally {
        release();
      }
    } catch (err: any) {
      logger.warn(
        `[ShopPayment] Renewal retry failed for order: ${order.tradeOrderId}, error: ${err.message}`
      );
    }
  }
  return successCount;
}

/**
 * Extend instance end time via Daemon remote request
 */
async function extendInstanceEndTime(
  daemonId: string,
  instanceUuid: string,
  periodType: PeriodType,
  periodMonths: number
): Promise<void> {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService || !remoteService.available) {
    throw new Error(`Remote service not available: ${daemonId}`);
  }

  // Get current instance config to read endTime
  const instanceInfo = await new RemoteRequest(remoteService).request("instance/section", {
    instanceUuids: [instanceUuid]
  });

  if (!instanceInfo || instanceInfo.length === 0) {
    throw new Error(`Instance not found: ${instanceUuid}`);
  }

  const currentConfig = instanceInfo[0].config;
  const currentEndTime = currentConfig.endTime || 0;
  const nowMs = Date.now();

  // Calculate new end time
  let baseDate: Date;
  if (currentEndTime > nowMs) {
    // Not expired yet, extend from current end time
    baseDate = new Date(currentEndTime);
  } else {
    // Already expired, extend from now
    baseDate = new Date(nowMs);
  }

  const newEndDate = addMonths(baseDate, periodMonths);
  const newEndTime = newEndDate.getTime();

  // Update instance config via Daemon
  await new RemoteRequest(remoteService).request("instance/update", {
    instanceUuid,
    config: {
      endTime: newEndTime
    }
  });

  logger.info(
    `[ShopPayment] Instance ${instanceUuid} endTime updated: ${new Date(currentEndTime).toISOString()} -> ${newEndDate.toISOString()}`
  );
}
