import Koa from "koa";
import Router from "@koa/router";
import permission from "../middleware/permission";
import { getUserUuid } from "../service/passport_service";
import userSystem from "../service/user_service";
import shopPriceService from "../service/shop_price_service";
import shopOrderService from "../service/shop_order_service";
import { dbFlush } from "../service/shop_database";
import { ROLE } from "../entity/user";
import { logger } from "../service/log";
import { operationLogger } from "../service/operation_logger";
import { getInstancesByUuid } from "../service/instance_service";
import RemoteServiceSubsystem from "../service/remote_service";
import RemoteRequest from "../service/remote_command";

const router = new Router({ prefix: "/shop/admin" });

// GET /shop/admin/users - Get all normal users with their instances
router.get("/users", permission({ level: ROLE.ADMIN }), async (ctx: Koa.ParameterizedContext) => {
  const users: any[] = [];

  for (const [uuid, user] of userSystem.objects) {
    // Only include normal users (not admins)
    if (user.permission >= ROLE.ADMIN) continue;

    const userInstances = user.instances || [];
    const instanceDetails: any[] = [];

    for (const inst of userInstances) {
      const remoteService = RemoteServiceSubsystem.getInstance(inst.daemonId);
      let detail: any = {
        instanceUuid: inst.instanceUuid,
        daemonId: inst.daemonId,
        nickname: "",
        endTime: 0,
        status: 0,
        hostIp: "",
        remarks: ""
      };

      if (remoteService && remoteService.available) {
        try {
          const info = await new RemoteRequest(remoteService).request("instance/section", {
            instanceUuids: [inst.instanceUuid]
          });
          if (info && info.length > 0) {
            detail.nickname = info[0].config?.nickname || "";
            detail.endTime = info[0].config?.endTime || 0;
            detail.status = info[0].status ?? 0;
            detail.hostIp = `${remoteService.config.ip}:${remoteService.config.port}`;
            detail.remarks = remoteService.config.remarks;
          }
        } catch {
          // Ignore errors for individual instances
        }
      }

      // Add pricing info
      const priceInfo = shopPriceService.getPrice(inst.daemonId, inst.instanceUuid);
      (detail as any).price = priceInfo;
      instanceDetails.push(detail);
    }

    users.push({
      uuid: user.uuid,
      userName: user.userName,
      registerTime: user.registerTime,
      loginTime: user.loginTime,
      instanceCount: userInstances.length,
      instances: instanceDetails
    });
  }

  ctx.body = users;
});

// GET /shop/admin/orders - Get all orders (with filters)
router.get("/orders", permission({ level: ROLE.ADMIN }), async (ctx: Koa.ParameterizedContext) => {
  const page = Math.max(1, Number(ctx.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(ctx.query.page_size) || 10));
  const userName = ctx.query.userName ? String(ctx.query.userName) : undefined;
  const status = ctx.query.status ? String(ctx.query.status) : undefined;

  const result = shopOrderService.getAllOrders(page, pageSize, { userName, status });
  ctx.body = result;
});

// PUT /shop/admin/price - Set/update instance pricing
router.put("/price", permission({ level: ROLE.ADMIN }), async (ctx: Koa.ParameterizedContext) => {
  const { daemonId, instanceUuid, basePrice, quarterlyDiscount, yearlyDiscount } = ctx.request.body as {
    daemonId: string;
    instanceUuid: string;
    basePrice: number;
    quarterlyDiscount: number;
    yearlyDiscount: number;
  };

  // Validate
  if (!daemonId || !instanceUuid) {
    ctx.status = 400;
    ctx.body = { error: "daemonId and instanceUuid are required." };
    return;
  }

  if (basePrice < 0) {
    ctx.status = 400;
    ctx.body = { error: "Base price must be >= 0." };
    return;
  }

  if (quarterlyDiscount <= 0 || quarterlyDiscount > 1 || yearlyDiscount <= 0 || yearlyDiscount > 1) {
    ctx.status = 400;
    ctx.body = { error: "Discount rates must be between 0 and 1 (exclusive)." };
    return;
  }

  const adminUuid = getUserUuid(ctx) || "";

  shopPriceService.setPrice(
    daemonId,
    instanceUuid,
    basePrice,
    quarterlyDiscount,
    yearlyDiscount,
    adminUuid
  );

  // Audit log
  operationLogger.log("shop_price_change", {
    operator_ip: ctx.ip,
    operator_name: ctx.session?.["userName"],
    target_daemon: daemonId,
    target_instance: instanceUuid,
    new_price: basePrice
  });

  logger.info(
    `[Shop] Price updated for ${daemonId}/${instanceUuid}: base=${basePrice}, quarterly=${quarterlyDiscount}, yearly=${yearlyDiscount}`
  );

  ctx.body = { success: true };
});

// GET /shop/admin/price - Get instance pricing (query params)
router.get("/price", permission({ level: ROLE.ADMIN }), async (ctx: Koa.ParameterizedContext) => {
  const daemonId = String(ctx.query.daemonId || "");
  const instanceUuid = String(ctx.query.instanceUuid || "");
  const priceInfo = shopPriceService.getPrice(daemonId, instanceUuid);
  ctx.body = priceInfo || { basePrice: 0, quarterlyDiscount: 0.9, yearlyDiscount: 0.8 };
});

// DELETE /shop/admin/order - Delete a single order
router.delete("/order", permission({ level: ROLE.ADMIN }), async (ctx: Koa.ParameterizedContext) => {
  const { id } = ctx.request.body as { id: string };
  if (!id) {
    ctx.status = 400;
    ctx.body = { error: "Order ID is required." };
    return;
  }

  const deleted = shopOrderService.deleteOrder(id);
  if (!deleted) {
    ctx.status = 404;
    ctx.body = { error: "Order not found." };
    return;
  }

  dbFlush();
  logger.info(`[Shop] Order deleted by admin: ${id}`);
  ctx.body = { success: true };
});

// DELETE /shop/admin/expired-orders - Delete all expired unpaid orders
router.delete("/expired-orders", permission({ level: ROLE.ADMIN }), async (ctx: Koa.ParameterizedContext) => {
  const count = shopOrderService.deleteExpiredOrders();
  dbFlush();
  logger.info(`[Shop] Admin deleted ${count} expired unpaid order(s).`);
  ctx.body = { success: true, count };
});

export default router;
