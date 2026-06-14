export enum OrderStatus {
  PENDING = "pending",
  PAID = "paid",
  FAILED = "failed",
  EXPIRED = "expired",
  RENEW_PENDING = "renew_pending"
}

export enum PeriodType {
  MONTHLY = "monthly",
  QUARTERLY = "quarterly",
  YEARLY = "yearly"
}

export const PERIOD_MONTHS: Record<PeriodType, number> = {
  [PeriodType.MONTHLY]: 1,
  [PeriodType.QUARTERLY]: 3,
  [PeriodType.YEARLY]: 12
};

export interface ShopOrder {
  id: string;
  tradeOrderId: string;
  userUuid: string;
  userName: string;
  daemonId: string;
  instanceUuid: string;
  instanceNickname: string;
  periodType: PeriodType;
  periodMonths: number;
  amount: number;
  basePrice: number;
  discountRate: number;
  status: OrderStatus;
  transactionId: string;
  payUrl: string;
  payTime: number;
  expireTime: number;
  createdAt: number;
  updatedAt: number;
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
