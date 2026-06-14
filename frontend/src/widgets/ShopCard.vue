<script setup lang="ts">
import type { LayoutCard } from "@/types";
import { ref, onMounted, computed } from "vue";
import { message, Modal } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import {
  getMyShopInstances,
  getMyShopOrders,
  createShopOrder,
  getShopOrderStatus,
  setShopInstancePrice,
  type ShopInstanceInfo,
  type ShopOrder,
  type OrderPageResult
} from "@/services/apis/shop";
import { useAppStateStore } from "@/stores/useAppStateStore";

// Instantiate API hooks (useDefineApi returns a factory function)
const instancesApi = getMyShopInstances();
const ordersApi = getMyShopOrders();
const createOrderApi = createShopOrder();
const setPriceApi = setShopInstancePrice();
const orderStatusApi = getShopOrderStatus();

const { isAdmin } = useAppStateStore();
import CardPanel from "@/components/CardPanel.vue";
import {
  ShoppingOutlined,
  ReloadOutlined,
  ClockCircleOutlined,
  HistoryOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  CheckCircleFilled,
  CheckCircleOutlined
} from "@ant-design/icons-vue";

const { t } = useI18n();
const props = defineProps<{
  card: LayoutCard;
}>();

// State
const loading = ref(false);
const instances = ref<ShopInstanceInfo[]>([]);
const activeTab = ref("instances");
const orderHistory = ref<OrderPageResult>({ data: [], total: 0, page: 1, maxPage: 1 });
const orderPage = ref(1);
const orderLoading = ref(false);
const creatingOrder = ref(false);
const payModalVisible = ref(false);
const payUrl = ref("");
const currentOrderInfo = ref<{ orderId: string; amount: number; expireTime: number } | null>(null);
const paySuccess = ref(false);
const payPollingTimer = ref<ReturnType<typeof setInterval> | null>(null);
let payWindowRef: Window | null = null;

// Price editing (admin only)
const priceModalVisible = ref(false);
const priceLoading = ref(false);
const editingPrice = ref({
  daemonId: "",
  instanceUuid: "",
  instanceName: "",
  basePrice: 0,
  quarterlyDiscount: 0.9,
  yearlyDiscount: 0.8
});

// Period type labels
const periodLabels: Record<string, string> = {
  monthly: t("TXT_CODE_SHOP_MONTHLY"),
  quarterly: t("TXT_CODE_SHOP_QUARTERLY"),
  yearly: t("TXT_CODE_SHOP_YEARLY")
};

// Period type sub-labels
const periodSubLabels: Record<string, string> = {
  monthly: "1个月",
  quarterly: "3个月",
  yearly: "12个月"
};

// Status colors
const statusColors: Record<string, string> = {
  pending: "orange",
  paid: "green",
  failed: "red",
  expired: "default",
  renew_pending: "gold"
};

const statusLabels: Record<string, string> = {
  pending: t("TXT_CODE_SHOP_ORDER_PENDING"),
  paid: t("TXT_CODE_SHOP_ORDER_PAID"),
  failed: t("TXT_CODE_SHOP_ORDER_FAILED"),
  expired: t("TXT_CODE_SHOP_ORDER_EXPIRED"),
  renew_pending: "续费中"
};

// Calculate remaining days
function getRemainingDays(endTime: number): number {
  if (endTime === 0) return Infinity;
  const now = Date.now();
  const diff = endTime - now;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// Format end time display
function formatEndTime(endTime: number): string {
  if (endTime === 0) return t("TXT_CODE_SHOP_UNLIMITED");
  const days = getRemainingDays(endTime);
  if (days <= 0) return t("TXT_CODE_SHOP_EXPIRED");
  return t("TXT_CODE_SHOP_REMAINING_DAYS", { days });
}

// Get end time color
function getEndTimeColor(endTime: number): string {
  if (endTime === 0) return "green";
  const days = getRemainingDays(endTime);
  if (days <= 0) return "red";
  if (days <= 7) return "orange";
  return "blue";
}

// Calculate price for a period
function calculatePrice(instance: ShopInstanceInfo, periodType: string): number {
  if (!instance.price) return 0;
  const base = instance.price.basePrice;
  const months = periodType === "monthly" ? 1 : periodType === "quarterly" ? 3 : 12;
  const discount =
    periodType === "quarterly"
      ? instance.price.quarterlyDiscount
      : periodType === "yearly"
        ? instance.price.yearlyDiscount
        : 1;
  return Math.round(base * months * discount * 100) / 100;
}

// Calculate per-month price for a period
function calculatePerMonth(instance: ShopInstanceInfo, periodType: string): number {
  const total = calculatePrice(instance, periodType);
  const months = periodType === "monthly" ? 1 : periodType === "quarterly" ? 3 : 12;
  return Math.round((total / months) * 100) / 100;
}

// Get discount label
function getDiscountLabel(instance: ShopInstanceInfo, periodType: string): string {
  if (!instance.price) return "";
  const discount =
    periodType === "quarterly"
      ? instance.price.quarterlyDiscount
      : periodType === "yearly"
        ? instance.price.yearlyDiscount
        : 1;
  if (discount >= 1) return "";
  return `${Math.round(discount * 100)}%`;
}

// Check if period is recommended (has best discount)
function isRecommended(instance: ShopInstanceInfo, periodType: string): boolean {
  if (!instance.price) return false;
  if (periodType === "yearly" && instance.price.yearlyDiscount < instance.price.quarterlyDiscount) return true;
  if (periodType === "quarterly" && instance.price.quarterlyDiscount < 1 && instance.price.yearlyDiscount >= 1) return true;
  return false;
}

// Format date
function formatDate(timestamp: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString();
}

// Load instances
async function loadInstances() {
  loading.value = true;
  try {
    const res = await instancesApi.execute();
    if (res.value) {
      instances.value = res.value;
    }
  } catch (err: any) {
    message.error(err.message || "Failed to load instances");
  } finally {
    loading.value = false;
  }
}

// Load order history
async function loadOrderHistory() {
  orderLoading.value = true;
  try {
    const res = await ordersApi.execute({
      params: { page: orderPage.value, page_size: 10 }
    });
    if (res.value) {
      orderHistory.value = res.value;
    }
  } catch (err: any) {
    message.error(err.message || "Failed to load orders");
  } finally {
    orderLoading.value = false;
  }
}

// Create order
async function handleCreateOrder(daemonId: string, instanceUuid: string, periodType: string) {
  creatingOrder.value = true;
  try {
    const res = await createOrderApi.execute({
      data: { daemonId, instanceUuid, periodType: periodType as any }
    });
    if (res.value) {
      if (res.value.payUrl) {
        payUrl.value = res.value.payUrl;
        currentOrderInfo.value = {
          orderId: res.value.orderId,
          amount: res.value.amount,
          expireTime: res.value.expireTime
        };
        paySuccess.value = false;
        payModalVisible.value = true;
      }
      message.success(t("TXT_CODE_SHOP_ORDER_CREATED"));
    }
  } catch (err: any) {
    message.error(err.message || "Failed to create order");
  } finally {
    creatingOrder.value = false;
  }
}

// Open payment URL
function openPayUrl() {
  if (payUrl.value) {
    payWindowRef = (globalThis as any).open(payUrl.value, "_blank");
  }
  // Start polling for payment status after opening payment URL
  startPayPolling();
}

// Start polling order status
function startPayPolling() {
  stopPayPolling();
  if (!currentOrderInfo.value?.orderId) return;

  payPollingTimer.value = setInterval(async () => {
    try {
      const res = await orderStatusApi.execute({
        params: { id: currentOrderInfo.value!.orderId }
      });
      if (res.value && (res.value.status === "paid" || res.value.status === "renew_pending")) {
        paySuccess.value = true;
        stopPayPolling();
        // Close the payment tab
        try {
          if (payWindowRef && !payWindowRef.closed) payWindowRef.close();
        } catch { /* ignore cross-origin close */ }
        payWindowRef = null;
        // Focus back to this window
        (globalThis as any).focus();
        // Auto close after 1.5 seconds
        setTimeout(() => {
          payModalVisible.value = false;
          paySuccess.value = false;
          loadInstances();
          if (activeTab.value === "orders") {
            loadOrderHistory();
          }
        }, 1500);
      }
    } catch {
      // Ignore polling errors
    }
  }, 1500);
}

// Stop polling
function stopPayPolling() {
  if (payPollingTimer.value) {
    clearInterval(payPollingTimer.value);
    payPollingTimer.value = null;
  }
}

// Handle pay modal close
function handlePayModalClose() {
  stopPayPolling();
  paySuccess.value = false;
}

// Open payment URL from order record
function openPayUrlRecord(record: ShopOrder) {
  if (record.payUrl) {
    (globalThis as any).open(record.payUrl, "_blank");
  }
}

// Open price editor (admin only)
function openPriceEditor(inst: ShopInstanceInfo) {
  editingPrice.value = {
    daemonId: inst.daemonId,
    instanceUuid: inst.instanceUuid,
    instanceName: inst.nickname || inst.instanceUuid,
    basePrice: inst.price?.basePrice ?? 0,
    quarterlyDiscount: inst.price?.quarterlyDiscount ?? 0.9,
    yearlyDiscount: inst.price?.yearlyDiscount ?? 0.8
  };
  priceModalVisible.value = true;
}

// Save price (admin only)
async function savePrice() {
  priceLoading.value = true;
  try {
    await setPriceApi.execute({
      data: {
        daemonId: editingPrice.value.daemonId,
        instanceUuid: editingPrice.value.instanceUuid,
        basePrice: editingPrice.value.basePrice,
        quarterlyDiscount: editingPrice.value.quarterlyDiscount,
        yearlyDiscount: editingPrice.value.yearlyDiscount
      }
    });
    message.success(t("TXT_CODE_SHOP_SAVE_SUCCESS"));
    priceModalVisible.value = false;
    loadInstances();
  } catch (err: any) {
    message.error(err.message || "Failed to save price");
  } finally {
    priceLoading.value = false;
  }
}

// Handle tab change
function handleTabChange(key: string | number) {
  activeTab.value = String(key);
  if (key === "orders" && orderHistory.value.data.length === 0) {
    loadOrderHistory();
  }
}

// Handle order page change
function handleOrderPageChange(page: number) {
  orderPage.value = page;
  loadOrderHistory();
}

onMounted(() => {
  loadInstances();
});
</script>

<template>
  <CardPanel class="shop-card-wrapper h-100 w-100" :style="{ maxHeight: card.height }">
    <template #title>
      <ShoppingOutlined style="margin-right: 8px" />
      {{ t("TXT_CODE_5a408a5e") }}
    </template>
    <template #body>
      <div class="shop-container" :style="{ maxHeight: card.height }">
        <a-tabs v-model:activeKey="activeTab" @change="handleTabChange">
          <!-- My Instances Tab -->
          <a-tab-pane key="instances" :tab="t('TXT_CODE_SHOP_MY_INSTANCES')">
            <div class="shop-instances">
              <a-spin :spinning="loading">
                <a-empty v-if="instances.length === 0 && !loading" :description="t('TXT_CODE_SHOP_NO_INSTANCES')" />

                <div v-for="inst in instances" :key="`${inst.daemonId}-${inst.instanceUuid}`" class="instance-card">
                  <!-- Card Top: Instance Info + Price -->
                  <div class="instance-header">
                    <div class="instance-info">
                      <div class="instance-name-row">
                        <h3 class="instance-name">{{ inst.nickname || inst.instanceUuid }}</h3>
                        <a-tag v-if="inst.remarks" color="blue" size="small" class="instance-remarks">{{ inst.remarks }}</a-tag>
                      </div>
                      <div class="instance-meta">
                        <span class="meta-item" :class="'status-' + getEndTimeColor(inst.endTime)">
                          <ClockCircleOutlined />
                          {{ formatEndTime(inst.endTime) }}
                        </span>
                      </div>
                    </div>
                    <div class="instance-price-badge" v-if="inst.price">
                      <div class="price-amount">
                        <span class="price-currency">¥</span>
                        <span class="price-number">{{ inst.price.basePrice }}</span>
                      </div>
                      <div class="price-period">/月</div>
                    </div>
                    <div class="instance-price-badge no-price" v-else>
                      <span class="no-price-text">{{ t("TXT_CODE_SHOP_NO_PRICE") }}</span>
                    </div>
                    <a-button v-if="isAdmin" type="text" size="small" class="price-setting-btn" @click="openPriceEditor(inst)">
                      <SettingOutlined />
                    </a-button>
                  </div>

                  <!-- Renew Options (only for priced, non-unlimited instances) -->
                  <div class="instance-body" v-if="inst.endTime !== 0 && inst.price">
                    <div class="renew-options">
                      <div
                        v-for="period in ['monthly', 'quarterly', 'yearly']"
                        :key="period"
                        class="renew-card"
                        :class="{ recommended: isRecommended(inst, period) }"
                      >
                        <!-- Recommended Badge -->
                        <div v-if="isRecommended(inst, period)" class="recommend-badge">
                          <ThunderboltOutlined /> 推荐
                        </div>

                        <!-- Discount Tag -->
                        <div v-if="getDiscountLabel(inst, period)" class="discount-badge">
                          {{ getDiscountLabel(inst, period) }}
                        </div>

                        <!-- Period Name -->
                        <div class="renew-period">{{ periodLabels[period] }}</div>
                        <div class="renew-duration">{{ periodSubLabels[period] }}</div>

                        <!-- Price -->
                        <div class="renew-price">
                          <span class="renew-price-currency">¥</span>
                          <span class="renew-price-amount">{{ calculatePrice(inst, period) }}</span>
                        </div>

                        <!-- Per Month -->
                        <div class="renew-per-month">
                          <template v-if="period !== 'monthly'">约 ¥{{ calculatePerMonth(inst, period) }}/月</template>
                          <template v-else>&nbsp;</template>
                        </div>

                        <!-- Action -->
                        <a-button
                          :type="isRecommended(inst, period) ? 'primary' : 'default'"
                          size="middle"
                          :loading="creatingOrder"
                          @click="handleCreateOrder(inst.daemonId, inst.instanceUuid, period)"
                          class="renew-btn"
                        >
                          {{ t("TXT_CODE_SHOP_RENEW") }}
                        </a-button>
                      </div>
                    </div>
                  </div>

                  <!-- Unlimited Instance -->
                  <div class="instance-body unlimited" v-if="inst.endTime === 0">
                    <div class="unlimited-badge">
                      <CheckCircleFilled class="unlimited-icon" />
                      <span>{{ t("TXT_CODE_SHOP_UNLIMITED") }}</span>
                    </div>
                  </div>
                </div>
              </a-spin>
            </div>
          </a-tab-pane>

          <!-- Order History Tab -->
          <a-tab-pane key="orders" :tab="t('TXT_CODE_SHOP_ORDER_HISTORY')">
            <div class="shop-orders">
              <a-spin :spinning="orderLoading">
                <a-table
                  v-if="orderHistory.data.length > 0"
                  :dataSource="orderHistory.data"
                  :pagination="{
                    current: orderPage,
                    total: orderHistory.total,
                    pageSize: 10,
                    onChange: handleOrderPageChange,
                    showTotal: (total: number) => `共 ${total} 条`
                  }"
                  size="small"
                  :scroll="{ x: 600 }"
                  row-key="id"
                >
                  <a-table-column :title="t('TXT_CODE_SHOP_INSTANCE')" dataIndex="instanceNickname" :width="120" />
                  <a-table-column :title="t('TXT_CODE_SHOP_MONTHLY')" :width="80">
                    <template #default="{ record }">
                      {{ periodLabels[record.periodType] }}
                    </template>
                  </a-table-column>
                  <a-table-column :title="t('TXT_CODE_SHOP_AMOUNT')" dataIndex="amount" :width="80">
                    <template #default="{ record }">
                      <span class="order-amount">¥{{ record.amount }}</span>
                    </template>
                  </a-table-column>
                  <a-table-column title="状态" :width="80">
                    <template #default="{ record }">
                      <span class="status-text" :class="'status-' + record.status">{{ statusLabels[record.status] }}</span>
                    </template>
                  </a-table-column>
                  <a-table-column title="创建时间" :width="140">
                    <template #default="{ record }">
                      {{ formatDate(record.createdAt) }}
                    </template>
                  </a-table-column>
                  <a-table-column :width="80">
                    <template #default="{ record }">
                      <a-button
                        v-if="record.status === 'pending' && record.payUrl"
                        type="link"
                        size="small"
                        @click="openPayUrlRecord(record)"
                      >
                        {{ t("TXT_CODE_SHOP_PAY_NOW") }}
                      </a-button>
                    </template>
                  </a-table-column>
                </a-table>
                <a-empty v-else description="暂无订单记录" />
              </a-spin>
            </div>
          </a-tab-pane>
        </a-tabs>

        <div class="shop-refresh">
          <a-button type="text" size="small" @click="loadInstances">
            <ReloadOutlined /> 刷新
          </a-button>
        </div>
      </div>

      <!-- Payment Modal -->
      <a-modal
        v-model:open="payModalVisible"
        :title="null"
        :footer="null"
        :width="400"
        centered
        class="pay-modal"
        @cancel="handlePayModalClose"
        :maskClosable="false"
      >
        <!-- Pending payment state -->
        <div class="pay-modal-content" v-if="!paySuccess">
          <div class="pay-icon">
            <ShoppingOutlined />
          </div>
          <div class="pay-title">{{ t("TXT_CODE_SHOP_ORDER_CREATED") }}</div>
          <div class="pay-amount-block" v-if="currentOrderInfo">
            <div class="pay-amount-label">{{ t("TXT_CODE_SHOP_TOTAL_AMOUNT") }}</div>
            <div class="pay-amount-value">
              <span class="pay-currency">¥</span>
              <span class="pay-number">{{ currentOrderInfo.amount }}</span>
            </div>
          </div>
          <a-alert
            :message="t('TXT_CODE_SHOP_ORDER_EXPIRE_TIP')"
            type="warning"
            show-icon
            style="margin: 20px 0"
          />
          <a-button type="primary" block size="large" @click="openPayUrl" class="pay-action-btn">
            {{ t("TXT_CODE_SHOP_PAY_NOW") }}
          </a-button>
        </div>
        <!-- Payment success state -->
        <div class="pay-modal-content pay-success-content" v-else>
          <div class="pay-success-icon">
            <CheckCircleOutlined />
          </div>
          <div class="pay-success-title">付款成功</div>
          <div class="pay-success-desc">实例续费成功，即将自动关闭...</div>
        </div>
      </a-modal>

      <!-- Price Editor Modal (Admin Only) -->
      <a-modal
        v-model:open="priceModalVisible"
        :title="t('TXT_CODE_SHOP_ADMIN_SET_PRICE') + ' - ' + editingPrice.instanceName"
        :confirm-loading="priceLoading"
        @ok="savePrice"
        :width="480"
        centered
        ok-text="保存"
        cancel-text="取消"
      >
        <a-form layout="vertical" style="margin-top: 16px">
          <a-form-item :label="t('TXT_CODE_SHOP_BASE_PRICE')">
            <a-input-number
              v-model:value="editingPrice.basePrice"
              :min="0"
              :step="1"
              :precision="2"
              style="width: 100%"
              prefix="¥"
              size="large"
            />
          </a-form-item>
          <a-form-item :label="t('TXT_CODE_SHOP_QUARTERLY_DISCOUNT')">
            <a-input-number
              v-model:value="editingPrice.quarterlyDiscount"
              :min="0.01"
              :max="1"
              :step="0.05"
              :precision="2"
              style="width: 100%"
              size="large"
            />
            <div class="form-hint">
              例如 0.9 表示九折，当前季付价：
              <span class="hint-price">¥{{ (editingPrice.basePrice * 3 * editingPrice.quarterlyDiscount).toFixed(2) }}</span>
            </div>
          </a-form-item>
          <a-form-item :label="t('TXT_CODE_SHOP_YEARLY_DISCOUNT')">
            <a-input-number
              v-model:value="editingPrice.yearlyDiscount"
              :min="0.01"
              :max="1"
              :step="0.05"
              :precision="2"
              style="width: 100%"
              size="large"
            />
            <div class="form-hint">
              例如 0.8 表示八折，当前年付价：
              <span class="hint-price">¥{{ (editingPrice.basePrice * 12 * editingPrice.yearlyDiscount).toFixed(2) }}</span>
            </div>
          </a-form-item>
        </a-form>
      </a-modal>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.shop-container {
  overflow-y: auto;
  padding: 0 4px 16px;
}

.shop-instances {
  .instance-card {
    background: var(--background-color-white, #fff);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    border: 1px solid var(--color-border-secondary, #f0f0f0);
    transition: all 0.25s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);

    &:hover {
      border-color: var(--color-primary, #4096ff);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      transform: translateY(-1px);
    }
  }

  .instance-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }

  .instance-info {
    flex: 1;
    min-width: 0;
  }

  .instance-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .instance-name {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    color: var(--color-text, #262626);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .instance-remarks {
    flex-shrink: 0;
  }

  .instance-meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .meta-item {
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    gap: 4px;

    &.status-green {
      color: var(--color-green-6, #52c41a);
    }
    &.status-blue {
      color: var(--color-blue-6, #1677ff);
    }
    &.status-orange {
      color: var(--color-orange-6, #fa8c16);
    }
    &.status-red {
      color: var(--color-red-5, #ff4d4f);
    }
  }

  // Price Badge
  .instance-price-badge {
    flex-shrink: 0;
    display: flex;
    align-items: baseline;
    gap: 2px;
    padding: 6px 14px;
    border-radius: 10px;
    background: linear-gradient(135deg, #fff1f0 0%, #ffccc7 100%);
    position: relative;

    .price-amount {
      display: flex;
      align-items: baseline;
    }

    .price-currency {
      font-size: 14px;
      font-weight: 600;
      color: var(--color-red-5, #ff4d4f);
    }

    .price-number {
      font-size: 28px;
      font-weight: 800;
      color: var(--color-red-5, #ff4d4f);
      line-height: 1.1;
      letter-spacing: -0.5px;
    }

    .price-period {
      font-size: 12px;
      color: var(--color-red-4, #ff7875);
      margin-left: 2px;
    }

    &.no-price {
      background: var(--color-fill-2, #fafafa);
      border: 1px dashed var(--color-border-secondary, #d9d9d9);

      .no-price-text {
        font-size: 13px;
        color: var(--color-text-3, #8c8c8c);
      }
    }
  }

  .price-setting-btn {
    flex-shrink: 0;
    color: var(--color-text-3, #8c8c8c);
    margin-left: 4px;

    &:hover {
      color: var(--color-primary, #4096ff);
    }
  }

  // Renew Options
  .instance-body {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid var(--color-border-secondary, #f0f0f0);

    &.unlimited {
      border-top: none;
      margin-top: 12px;
      padding-top: 0;
    }
  }

  .renew-options {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }

  .renew-card {
    position: relative;
    background: var(--color-fill-1, #fafafa);
    border: 2px solid var(--color-border-secondary, #f0f0f0);
    border-radius: 12px;
    padding: 16px 12px;
    text-align: center;
    transition: all 0.25s ease;
    overflow: hidden;

    &:hover {
      border-color: var(--color-primary, #4096ff);
      box-shadow: 0 2px 8px rgba(22, 119, 255, 0.12);
      transform: translateY(-2px);
    }

    &.recommended {
      border-color: var(--color-primary, #4096ff);
      background: linear-gradient(180deg, rgba(22, 119, 255, 0.04) 0%, var(--color-fill-1, #fafafa) 100%);
      box-shadow: 0 2px 8px rgba(22, 119, 255, 0.1);
    }
  }

  .recommend-badge {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: linear-gradient(135deg, var(--color-blue-5, #4096ff), var(--color-blue-6, #1677ff));
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 0;
    letter-spacing: 0.5px;
  }

  .discount-badge {
    position: absolute;
    top: 0;
    right: 0;
    background: linear-gradient(135deg, var(--color-orange-5, #ffa940), var(--color-orange-6, #fa8c16));
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 0 10px 0 8px;
  }

  .renew-period {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text, #262626);
    margin-top: 4px;
  }

  .renew-duration {
    font-size: 12px;
    color: var(--color-text-3, #8c8c8c);
    margin-top: 2px;
  }

  .renew-price {
    margin-top: 10px;
    display: flex;
    align-items: baseline;
    justify-content: center;
  }

  .renew-price-currency {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-red-5, #ff4d4f);
  }

  .renew-price-amount {
    font-size: 26px;
    font-weight: 800;
    color: var(--color-red-5, #ff4d4f);
    line-height: 1.1;
    letter-spacing: -0.5px;
  }

  .renew-per-month {
    font-size: 11px;
    color: var(--color-text-3, #8c8c8c);
    margin-top: 2px;
    margin-bottom: 8px;
  }

  .renew-btn {
    margin-top: 10px;
    width: 100%;
    border-radius: 6px;
    font-weight: 500;
  }

  // Unlimited badge
  .unlimited-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 16px;
    border-radius: 20px;
    background: linear-gradient(135deg, #f6ffed, #d9f7be);
    color: var(--color-green-7, #389e0d);
    font-size: 14px;
    font-weight: 500;

    .unlimited-icon {
      font-size: 16px;
    }
  }
}

.shop-refresh {
  position: absolute;
  top: 8px;
  right: 12px;
}

.shop-orders {
  :deep(.ant-table) {
    background: transparent;
  }

  .order-amount {
    color: var(--color-red-5, #ff4d4f);
    font-weight: 600;
  }

  .status-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 500;

    &::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    &.status-pending {
      color: #fa8c16;
      &::before { background: #fa8c16; }
    }
    &.status-paid {
      color: #52c41a;
      &::before { background: #52c41a; }
    }
    &.status-failed {
      color: #ff4d4f;
      &::before { background: #ff4d4f; }
    }
    &.status-expired {
      color: #8c8c8c;
      &::before { background: #8c8c8c; }
    }
    &.status-renew_pending {
      color: #faad14;
      &::before { background: #faad14; }
    }
  }
}

// Payment Modal
.pay-modal-content {
  text-align: center;
  padding: 12px 0 8px;

  .pay-icon {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--color-blue-5, #4096ff), var(--color-blue-6, #1677ff));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;

    .anticon {
      font-size: 28px;
      color: #fff;
    }
  }

  .pay-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-text, #262626);
    margin-bottom: 20px;
  }

  .pay-amount-block {
    background: linear-gradient(135deg, #fff1f0, #ffccc7);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 4px;
  }

  .pay-amount-label {
    font-size: 13px;
    color: var(--color-text-3, #8c8c8c);
    margin-bottom: 4px;
  }

  .pay-amount-value {
    display: flex;
    align-items: baseline;
    justify-content: center;
  }

  .pay-currency {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-red-5, #ff4d4f);
  }

  .pay-number {
    font-size: 40px;
    font-weight: 800;
    color: var(--color-red-5, #ff4d4f);
    line-height: 1.1;
    letter-spacing: -1px;
  }

  .pay-action-btn {
    border-radius: 8px;
    height: 44px;
    font-size: 16px;
    font-weight: 600;
  }
}

// Payment Success
.pay-success-content {
  padding: 32px 0 24px !important;

  .pay-success-icon {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: linear-gradient(135deg, #52c41a, #389e0d);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
    animation: paySuccessPop 0.4s ease;

    .anticon {
      font-size: 40px;
      color: #fff;
    }
  }

  .pay-success-title {
    font-size: 22px;
    font-weight: 700;
    color: var(--color-green-7, #389e0d);
    margin-bottom: 8px;
  }

  .pay-success-desc {
    font-size: 14px;
    color: var(--color-text-3, #8c8c8c);
  }
}

@keyframes paySuccessPop {
  0% {
    transform: scale(0.5);
    opacity: 0;
  }
  70% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

// Form hints
.form-hint {
  display: block;
  font-size: 12px;
  color: var(--color-text-3, #8c8c8c);
  margin-top: 6px;

  .hint-price {
    color: var(--color-red-5, #ff4d4f);
    font-weight: 600;
  }
}

// Responsive: stack renew cards on small screens
@media (max-width: 600px) {
  .shop-instances .renew-options {
    grid-template-columns: 1fr;
  }

  .shop-instances .instance-header {
    flex-direction: column;
    gap: 10px;
  }

  .shop-instances .instance-price-badge {
    align-self: flex-start;
  }
}
</style>
