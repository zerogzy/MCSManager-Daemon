import { useDefineApi } from "@/stores/useDefineApi";

// Types for shop system
export interface ShopInstanceInfo {
  instanceUuid: string;
  daemonId: string;
  nickname: string;
  status: number;
  endTime: number;
  hostIp: string;
  remarks: string;
  price: InstancePrice | null;
}

export interface InstancePrice {
  daemonId: string;
  instanceUuid: string;
  basePrice: number;
  quarterlyDiscount: number;
  yearlyDiscount: number;
  updatedAt: number;
  updatedBy: string;
}

export interface ShopOrder {
  id: string;
  tradeOrderId: string;
  userUuid: string;
  userName: string;
  daemonId: string;
  instanceUuid: string;
  instanceNickname: string;
  periodType: "monthly" | "quarterly" | "yearly";
  periodMonths: number;
  amount: number;
  basePrice: number;
  discountRate: number;
  status: "pending" | "paid" | "failed" | "expired" | "renew_pending";
  transactionId: string;
  payUrl: string;
  payTime: number;
  expireTime: number;
  createdAt: number;
  updatedAt: number;
}

export interface AdminUserInfo {
  uuid: string;
  userName: string;
  registerTime: string;
  loginTime: string;
  instanceCount: number;
  instances: ShopInstanceInfo[];
}

export interface OrderPageResult {
  data: ShopOrder[];
  total: number;
  page: number;
  maxPage: number;
}

// API definitions

// Get my instances with pricing info
export const getMyShopInstances = useDefineApi<any, ShopInstanceInfo[]>({
  url: "/api/shop/my-instances",
  method: "GET"
});

// Create a renewal order
export const createShopOrder = useDefineApi<
  {
    data: {
      daemonId: string;
      instanceUuid: string;
      periodType: "monthly" | "quarterly" | "yearly";
    };
  },
  {
    orderId: string;
    tradeOrderId: string;
    payUrl: string;
    amount: number;
    periodType: string;
    status: string;
    expireTime: number;
  }
>({
  url: "/api/shop/create-order",
  method: "POST"
});

// Get order details (query param)
export const getShopOrder = useDefineApi<
  {
    params: { id: string };
  },
  ShopOrder
>({
  url: "/api/shop/order",
  method: "GET"
});

// Get order status (lightweight, for payment polling)
export const getShopOrderStatus = useDefineApi<
  {
    params: { id: string };
  },
  { id: string; status: string; payTime: number }
>({
  url: "/api/shop/order-status",
  method: "GET"
});

// Get my order history
export const getMyShopOrders = useDefineApi<
  {
    params: { page: number; page_size: number };
  },
  OrderPageResult
>({
  url: "/api/shop/my-orders",
  method: "GET"
});

// Admin: Get all users with instances
export const getAdminShopUsers = useDefineApi<any, AdminUserInfo[]>({
  url: "/api/shop/admin/users",
  method: "GET"
});

// Admin: Get all orders
export const getAdminShopOrders = useDefineApi<
  {
    params: { page: number; page_size: number; userName?: string; status?: string };
  },
  OrderPageResult
>({
  url: "/api/shop/admin/orders",
  method: "GET"
});

// Admin: Set instance pricing
export const setShopInstancePrice = useDefineApi<
  {
    data: {
      daemonId: string;
      instanceUuid: string;
      basePrice: number;
      quarterlyDiscount: number;
      yearlyDiscount: number;
    };
  },
  { success: boolean }
>({
  url: "/api/shop/admin/price",
  method: "PUT"
});

// Admin: Get instance pricing (query params)
export const getShopInstancePrice = useDefineApi<
  {
    params: { daemonId: string; instanceUuid: string };
  },
  InstancePrice
>({
  url: "/api/shop/admin/price",
  method: "GET"
});

// Admin: Delete a single order
export const deleteShopOrder = useDefineApi<
  {
    data: { id: string };
  },
  { success: boolean }
>({
  url: "/api/shop/admin/order",
  method: "DELETE"
});

// Admin: Delete all expired unpaid orders
export const deleteExpiredShopOrders = useDefineApi<
  any,
  { success: boolean; count: number }
>({
  url: "/api/shop/admin/expired-orders",
  method: "DELETE"
});
