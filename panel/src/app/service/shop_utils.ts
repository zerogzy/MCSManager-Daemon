import { PeriodType, PERIOD_MONTHS } from "../entity/shop_order";
import { systemConfig } from "../setting";

/**
 * Calculate payment amount based on base price, period type and discounts
 */
export function calculateAmount(
  basePrice: number,
  periodType: PeriodType,
  quarterlyDiscount: number = 0.9,
  yearlyDiscount: number = 0.8
): { amount: number; discountRate: number } {
  const months = PERIOD_MONTHS[periodType];
  let discountRate = 1;

  if (periodType === PeriodType.QUARTERLY) {
    discountRate = quarterlyDiscount;
  } else if (periodType === PeriodType.YEARLY) {
    discountRate = yearlyDiscount;
  }

  const amount = Math.round(basePrice * months * discountRate * 100) / 100;
  return { amount, discountRate };
}

/**
 * Add months to a date, correctly handling month boundaries
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);
  // If the original day was the last day of the month and the target month is shorter,
  // setMonth will roll over. We want to clamp to the last day of the target month.
  if (result.getDate() !== day) {
    result.setDate(0); // Last day of previous month (= target month's last day)
  }
  return result;
}

/**
 * Generate a unique trade order ID
 */
export function generateTradeOrderId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `SHP${timestamp}${random}`.toUpperCase();
}

/**
 * Check if payment is configured
 */
export function isPaymentConfigured(): boolean {
  return !!(
    systemConfig?.payAppId &&
    systemConfig?.payAppSecret &&
    systemConfig?.payNotifyUrl
  );
}

/**
 * Get period display name
 */
export function getPeriodDisplayName(periodType: PeriodType): string {
  switch (periodType) {
    case PeriodType.MONTHLY:
      return "月付";
    case PeriodType.QUARTERLY:
      return "季付";
    case PeriodType.YEARLY:
      return "年付";
    default:
      return periodType;
  }
}
