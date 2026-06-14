import Koa from "koa";
import Router from "@koa/router";
import permission from "../middleware/permission";
import { speedLimit } from "../middleware/limit";
import { getUserUuid } from "../service/passport_service";
import userSystem from "../service/user_service";
import shopPriceService from "../service/shop_price_service";
import shopOrderService from "../service/shop_order_service";
import { createPayment, processPaymentCallback } from "../service/shop_payment_service";
import { ROLE } from "../entity/user";
import { OrderStatus, PeriodType, PERIOD_MONTHS, ShopInstanceInfo } from "../entity/shop_order";
import { calculateAmount, generateTradeOrderId, isPaymentConfigured } from "../service/shop_utils";
import { v4 } from "uuid";
import { logger } from "../service/log";
import RemoteServiceSubsystem from "../service/remote_service";
import RemoteRequest from "../service/remote_command";

const router = new Router({ prefix: "/shop" });

// GET /shop/my-instances - Get current user's instances with pricing info
router.get("/my-instances", permission({ level: ROLE.USER }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (!userUuid) {
    ctx.status = 403;
    return;
  }

  const user = userSystem.getInstance(userUuid);
  if (!user) {
    ctx.status = 403;
    return;
  }

  // For admin users: show all instances from all users
  // For normal users: show only their own instances
  let targetInstances: Array<{ daemonId: string; instanceUuid: string }> = [];

  if (user.permission >= ROLE.ADMIN) {
    // Admin sees all instances from all users
    for (const [, u] of userSystem.objects) {
      if (u.instances && u.instances.length > 0) {
        for (const inst of u.instances) {
          // Deduplicate
          if (!targetInstances.some((t) => t.daemonId === inst.daemonId && t.instanceUuid === inst.instanceUuid)) {
            targetInstances.push({ daemonId: inst.daemonId, instanceUuid: inst.instanceUuid });
          }
        }
      }
    }
  } else {
    targetInstances = (user.instances || []).map((inst) => ({
      daemonId: inst.daemonId,
      instanceUuid: inst.instanceUuid
    }));
  }

  // Fetch instance details from Daemons
  const result: ShopInstanceInfo[] = [];
  for (const inst of targetInstances) {
    const remoteService = RemoteServiceSubsystem.getInstance(inst.daemonId);
    if (!remoteService || !remoteService.available) {
      // Daemon offline - still show the instance with basic info
      result.push({
        instanceUuid: inst.instanceUuid,
        daemonId: inst.daemonId,
        nickname: inst.instanceUuid,
        status: -1,
        endTime: 0,
        hostIp: "",
        remarks: "",
        price: shopPriceService.getPrice(inst.daemonId, inst.instanceUuid) || null
      });
      continue;
    }

    try {
      const instanceInfo = await new RemoteRequest(remoteService).request("instance/section", {
        instanceUuids: [inst.instanceUuid]
      });
      if (!instanceInfo || instanceInfo.length === 0) continue;
      const info = instanceInfo[0];
      const priceInfo = shopPriceService.getPrice(inst.daemonId, inst.instanceUuid);

      result.push({
        instanceUuid: inst.instanceUuid,
        daemonId: inst.daemonId,
        nickname: info.config?.nickname || "",
        status: info.status ?? 0,
        endTime: info.config?.endTime ?? 0,
        hostIp: `${remoteService.config.ip}:${remoteService.config.port}`,
        remarks: remoteService.config.remarks || "",
        price: priceInfo || null
      });
    } catch {
      // Skip this instance on error
    }
  }

  ctx.body = result;
});

// POST /shop/create-order - Create a renewal order (rate limited: 1 request per 5 seconds)
router.post("/create-order", speedLimit(5), permission({ level: ROLE.USER, speedLimit: false }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (!userUuid) {
    ctx.status = 403;
    return;
  }

  const { daemonId, instanceUuid, periodType } = ctx.request.body as {
    daemonId: string;
    instanceUuid: string;
    periodType: string;
  };

  // Validate period type
  if (!Object.values(PeriodType).includes(periodType as PeriodType)) {
    ctx.status = 400;
    ctx.body = { error: "Invalid period type. Must be monthly, quarterly, or yearly." };
    return;
  }

  const pt = periodType as PeriodType;

  // Check if payment is configured
  if (!isPaymentConfigured()) {
    ctx.status = 400;
    ctx.body = { error: "Payment is not configured. Please contact the administrator." };
    return;
  }

  // Verify instance belongs to this user
  const user = userSystem.getInstance(userUuid);
  if (!user) {
    ctx.status = 403;
    return;
  }

  const ownsInstance = user.instances.some(
    (inst) => inst.daemonId === daemonId && inst.instanceUuid === instanceUuid
  );
  if (!ownsInstance) {
    ctx.status = 403;
    ctx.body = { error: "You do not have permission to operate this instance." };
    return;
  }

  // Check if instance has endTime (0 means unlimited, no renewal needed)
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService || !remoteService.available) {
    ctx.status = 400;
    ctx.body = { error: "Remote service is not available." };
    return;
  }

  try {
    const instanceInfo = await new RemoteRequest(remoteService).request("instance/section", {
      instanceUuids: [instanceUuid]
    });
    if (!instanceInfo || instanceInfo.length === 0) {
      ctx.status = 404;
      ctx.body = { error: "Instance not found." };
      return;
    }

    const currentEndTime = instanceInfo[0].config?.endTime;
    if (currentEndTime === 0) {
      ctx.status = 400;
      ctx.body = { error: "This instance has unlimited duration and does not require renewal." };
      return;
    }
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: "Failed to check instance status." };
    return;
  }

  // Check for existing pending order for this instance
  const existingOrder = shopOrderService.getPendingOrderByInstance(userUuid, daemonId, instanceUuid);
  if (existingOrder) {
    ctx.body = {
      orderId: existingOrder.id,
      payUrl: existingOrder.payUrl,
      status: existingOrder.status,
      message: "You already have a pending order for this instance."
    };
    return;
  }

  // Get pricing
  const priceInfo = shopPriceService.getPrice(daemonId, instanceUuid);
  if (!priceInfo) {
    ctx.status = 400;
    ctx.body = { error: "Pricing has not been set for this instance. Please contact the administrator." };
    return;
  }

  // Calculate amount
  const { amount, discountRate } = calculateAmount(
    priceInfo.basePrice,
    pt,
    priceInfo.quarterlyDiscount,
    priceInfo.yearlyDiscount
  );

  if (amount <= 0) {
    ctx.status = 400;
    ctx.body = { error: "Invalid order amount." };
    return;
  }

  // Get instance nickname
  let instanceNickname = instanceUuid;
  try {
    const instanceInfo = await new RemoteRequest(remoteService).request("instance/section", {
      instanceUuids: [instanceUuid]
    });
    if (instanceInfo?.[0]?.config?.nickname) {
      instanceNickname = instanceInfo[0].config.nickname;
    }
  } catch {
    // Use UUID as fallback
  }

  // Create order
  const orderId = v4().replace(/-/g, "");
  const tradeOrderId = generateTradeOrderId();
  const now = Math.floor(Date.now() / 1000);
  const expireTime = now + 15 * 60; // 15 minutes

  const order = {
    id: orderId,
    tradeOrderId,
    userUuid,
    userName: user.userName,
    daemonId,
    instanceUuid,
    instanceNickname,
    periodType: pt,
    periodMonths: PERIOD_MONTHS[pt],
    amount,
    basePrice: priceInfo.basePrice,
    discountRate,
    status: OrderStatus.PENDING,
    transactionId: "",
    payUrl: "",
    payTime: 0,
    expireTime
  };

  // Call payment gateway
  let payUrl = "";
  try {
    shopOrderService.createOrder(order);
    payUrl = await createPayment(order as any);
    shopOrderService.updateOrder(orderId, { payUrl });
  } catch (err: any) {
    logger.error(`[Shop] Failed to create payment order: ${err.message}`);
    ctx.status = 500;
    ctx.body = { error: err.message || "Failed to create payment order." };
    return;
  }

  ctx.body = {
    orderId,
    tradeOrderId,
    payUrl,
    amount,
    periodType: pt,
    status: OrderStatus.PENDING,
    expireTime
  };
});

// GET /shop/order - Get order details (query param: id)
router.get("/order", permission({ level: ROLE.USER }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (!userUuid) {
    ctx.status = 403;
    return;
  }

  const orderId = String(ctx.query.id || "");
  const order = shopOrderService.getOrderById(orderId);
  if (!order) {
    ctx.status = 404;
    ctx.body = { error: "Order not found." };
    return;
  }

  // Only allow viewing own orders
  if (order.userUuid !== userUuid) {
    ctx.status = 403;
    ctx.body = { error: "Access denied." };
    return;
  }

  ctx.body = order;
});

// GET /shop/order-status - Lightweight order status check for payment polling (query param: id)
router.get("/order-status", permission({ level: ROLE.USER }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (!userUuid) {
    ctx.status = 403;
    return;
  }

  const orderId = String(ctx.query.id || "");
  const order = shopOrderService.getOrderById(orderId);
  if (!order) {
    ctx.status = 404;
    ctx.body = { error: "Order not found." };
    return;
  }

  if (order.userUuid !== userUuid) {
    ctx.status = 403;
    ctx.body = { error: "Access denied." };
    return;
  }

  ctx.body = {
    id: order.id,
    status: order.status,
    payTime: order.payTime
  };
});

// GET /shop/my-orders - Get current user's order history
router.get("/my-orders", permission({ level: ROLE.USER }), async (ctx: Koa.ParameterizedContext) => {
  const userUuid = getUserUuid(ctx);
  if (!userUuid) {
    ctx.status = 403;
    return;
  }

  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(ctx.query.page_size) || 10));

  const result = shopOrderService.getOrdersByUserUuid(userUuid, page, pageSize);
  ctx.body = result;
});

// POST /shop/notify - Payment callback (no auth middleware)
router.post("/notify", async (ctx: Koa.ParameterizedContext) => {
  try {
    const callbackData = ctx.request.body as Record<string, any>;
    logger.info(`[ShopPayment] Received callback for order: ${callbackData.trade_order_id}`);
    const result = await processPaymentCallback(callbackData);
    ctx.body = result;
  } catch (err: any) {
    logger.error(`[ShopPayment] Callback processing error: ${err.message}`);
    ctx.body = "success";
  }
});

export default router;
