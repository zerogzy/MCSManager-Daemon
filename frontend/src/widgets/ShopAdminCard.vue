<script setup lang="ts">
import type { LayoutCard } from "@/types";
import { ref, onMounted, computed } from "vue";
import { message, Modal } from "ant-design-vue";
import { useI18n } from "vue-i18n";
import {
  getAdminShopUsers,
  getAdminShopOrders,
  setShopInstancePrice,
  deleteShopOrder,
  deleteExpiredShopOrders,
  type AdminUserInfo,
  type ShopOrder,
  type OrderPageResult
} from "@/services/apis/shop";
import CardPanel from "@/components/CardPanel.vue";

// Instantiate API hooks (useDefineApi returns a factory function)
const adminUsersApi = getAdminShopUsers();
const adminOrdersApi = getAdminShopOrders();
const setPriceApi = setShopInstancePrice();
const deleteOrderApi = deleteShopOrder();
const deleteExpiredApi = deleteExpiredShopOrders();
import {
  TeamOutlined,
  FileTextOutlined,
  SettingOutlined,
  ReloadOutlined,
  DeleteOutlined,
  ClearOutlined
} from "@ant-design/icons-vue";

const { t } = useI18n();
const props = defineProps<{
  card: LayoutCard;
}>();

// State
const activeTab = ref("users");
const loadingUsers = ref(false);
const loadingOrders = ref(false);
const users = ref<AdminUserInfo[]>([]);
const orderResult = ref<OrderPageResult>({ data: [], total: 0, page: 1, maxPage: 1 });
const orderPage = ref(1);
const orderFilters = ref({ userName: "", status: "" });
const expandedUserKeys = ref<string[]>([]);

// Price editing
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

// Get remaining days
function getRemainingDays(endTime: number): number {
  if (endTime === 0) return Infinity;
  const diff = endTime - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// Format end time display
function formatEndTime(endTime: number): string {
  if (endTime === 0) return t("TXT_CODE_SHOP_UNLIMITED");
  const days = getRemainingDays(endTime);
  if (days <= 0) return t("TXT_CODE_SHOP_EXPIRED");
  return t("TXT_CODE_SHOP_REMAINING_DAYS", { days });
}

function getEndTimeColor(endTime: number): string {
  if (endTime === 0) return "green";
  const days = getRemainingDays(endTime);
  if (days <= 0) return "red";
  if (days <= 7) return "orange";
  return "blue";
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString();
}

// Load users
async function loadUsers() {
  loadingUsers.value = true;
  try {
    const res = await adminUsersApi.execute();
    if (res.value) {
      users.value = res.value;
    }
  } catch (err: any) {
    message.error(err.message || "Failed to load users");
  } finally {
    loadingUsers.value = false;
  }
}

// Load orders
async function loadOrders() {
  loadingOrders.value = true;
  try {
    const params: any = { page: orderPage.value, page_size: 10 };
    if (orderFilters.value.userName) params.userName = orderFilters.value.userName;
    if (orderFilters.value.status) params.status = orderFilters.value.status;

    const res = await adminOrdersApi.execute({ params });
    if (res.value) {
      orderResult.value = res.value;
    }
  } catch (err: any) {
    message.error(err.message || "Failed to load orders");
  } finally {
    loadingOrders.value = false;
  }
}

// Open price editor
function openPriceEditor(daemonId: string, instanceUuid: string, instanceName: string, price: any) {
  editingPrice.value = {
    daemonId,
    instanceUuid,
    instanceName,
    basePrice: price?.basePrice ?? 0,
    quarterlyDiscount: price?.quarterlyDiscount ?? 0.9,
    yearlyDiscount: price?.yearlyDiscount ?? 0.8
  };
  priceModalVisible.value = true;
}

// Save price
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
    // Reload users to reflect price changes
    loadUsers();
  } catch (err: any) {
    message.error(err.message || "Failed to save price");
  } finally {
    priceLoading.value = false;
  }
}

// Handle tab change
function handleTabChange(key: string | number) {
  activeTab.value = String(key);
  if (key === "users" && users.value.length === 0) loadUsers();
  if (key === "orders" && orderResult.value.data.length === 0) loadOrders();
}

// Handle order page change
function handleOrderPageChange(page: number) {
  orderPage.value = page;
  loadOrders();
}

// Search orders
function searchOrders() {
  orderPage.value = 1;
  loadOrders();
}

// Delete a single order
async function handleDeleteOrder(record: ShopOrder) {
  Modal.confirm({
    title: "确认删除",
    content: `确定要删除订单 ${record.tradeOrderId} 吗？`,
    okType: "danger",
    okText: "删除",
    cancelText: "取消",
    onOk: async () => {
      try {
        await deleteOrderApi.execute({ data: { id: record.id } });
        message.success("订单已删除");
        loadOrders();
      } catch (err: any) {
        message.error(err.message || "删除失败");
      }
    }
  });
}

// Delete all expired unpaid orders
async function handleDeleteExpiredOrders() {
  Modal.confirm({
    title: "清理过期订单",
    content: "确定要删除所有过期未付款的订单吗？此操作不可撤销。",
    okType: "danger",
    okText: "确认清理",
    cancelText: "取消",
    onOk: async () => {
      try {
        const res = await deleteExpiredApi.execute({});
        if (res.value) {
          message.success(`已清理 ${res.value.count} 条过期订单`);
          loadOrders();
        }
      } catch (err: any) {
        message.error(err.message || "清理失败");
      }
    }
  });
}

onMounted(() => {
  loadUsers();
});
</script>

<template>
  <CardPanel class="shop-admin-wrapper h-100 w-100" :style="{ maxHeight: card.height }">
    <template #title>
      <SettingOutlined style="margin-right: 8px" />
      {{ t("TXT_CODE_SHOP_ADMIN_USERS") }}
    </template>
    <template #body>
      <div class="shop-admin-container" :style="{ maxHeight: card.height }">
        <a-tabs v-model:activeKey="activeTab" @change="handleTabChange">
          <!-- Users Tab -->
          <a-tab-pane key="users" :tab="t('TXT_CODE_SHOP_ADMIN_USERS')">
            <div class="admin-users">
              <a-spin :spinning="loadingUsers">
                <a-empty v-if="users.length === 0 && !loadingUsers" />

                <a-collapse v-model:activeKey="expandedUserKeys" accordion>
                  <a-collapse-panel v-for="user in users" :key="user.uuid" :header="user.userName">
                    <template #extra>
                      <a-tag color="blue">{{ user.instanceCount }} 个实例</a-tag>
                    </template>

                    <div class="user-instances">
                      <div
                        v-for="inst in user.instances"
                        :key="`${inst.daemonId}-${inst.instanceUuid}`"
                        class="admin-instance-card"
                      >
                        <div class="admin-instance-header">
                          <div class="admin-instance-info">
                            <span class="admin-instance-name">{{ inst.nickname || inst.instanceUuid }}</span>
                            <a-tag v-if="inst.remarks" size="small" style="margin-left: 6px">{{ inst.remarks }}</a-tag>
                          </div>
                          <a-tag :color="getEndTimeColor(inst.endTime)" size="small">
                            {{ formatEndTime(inst.endTime) }}
                          </a-tag>
                        </div>

                        <div class="admin-instance-price">
                          <template v-if="inst.price">
                            <span class="price-set">
                              ¥{{ inst.price.basePrice }}/月 ·
                              季付{{ Math.round(inst.price.quarterlyDiscount * 100) }}% ·
                              年付{{ Math.round(inst.price.yearlyDiscount * 100) }}%
                            </span>
                          </template>
                          <template v-else>
                            <a-tag color="default" size="small">{{ t("TXT_CODE_SHOP_PRICE_NOT_SET") }}</a-tag>
                          </template>
                          <a-button
                            type="link"
                            size="small"
                            @click="openPriceEditor(inst.daemonId, inst.instanceUuid, inst.nickname || inst.instanceUuid, inst.price)"
                          >
                            <SettingOutlined /> {{ t("TXT_CODE_SHOP_ADMIN_SET_PRICE") }}
                          </a-button>
                        </div>
                      </div>
                    </div>
                  </a-collapse-panel>
                </a-collapse>
              </a-spin>
            </div>
          </a-tab-pane>

          <!-- Orders Tab -->
          <a-tab-pane key="orders" :tab="t('TXT_CODE_SHOP_ADMIN_ORDERS')">
            <div class="admin-orders">
              <!-- Filters -->
              <div class="order-filters">
                <a-input
                  v-model:value="orderFilters.userName"
                  :placeholder="t('TXT_CODE_SHOP_USER')"
                  style="width: 160px"
                  size="small"
                  allow-clear
                  @pressEnter="searchOrders"
                />
                <a-select
                  v-model:value="orderFilters.status"
                  :placeholder="'状态'"
                  style="width: 120px"
                  size="small"
                  allow-clear
                >
                  <a-select-option value="pending">{{ t("TXT_CODE_SHOP_ORDER_PENDING") }}</a-select-option>
                  <a-select-option value="renew_pending">续费中</a-select-option>
                  <a-select-option value="paid">{{ t("TXT_CODE_SHOP_ORDER_PAID") }}</a-select-option>
                  <a-select-option value="failed">{{ t("TXT_CODE_SHOP_ORDER_FAILED") }}</a-select-option>
                  <a-select-option value="expired">{{ t("TXT_CODE_SHOP_ORDER_EXPIRED") }}</a-select-option>
                </a-select>
                <a-button type="primary" size="small" @click="searchOrders">查询</a-button>
                <a-button size="small" @click="loadOrders">
                  <ReloadOutlined />
                </a-button>
                <a-button size="small" danger @click="handleDeleteExpiredOrders">
                  <ClearOutlined /> 清理过期
                </a-button>
              </div>

              <a-spin :spinning="loadingOrders">
                <a-table
                  v-if="orderResult.data.length > 0"
                  :dataSource="orderResult.data"
                  :pagination="{
                    current: orderPage,
                    total: orderResult.total,
                    pageSize: 10,
                    onChange: handleOrderPageChange,
                    showTotal: (total: number) => `共 ${total} 条`
                  }"
                  size="small"
                  :scroll="{ x: 800 }"
                  row-key="id"
                >
                  <a-table-column :title="t('TXT_CODE_SHOP_USER')" dataIndex="userName" :width="90" />
                  <a-table-column :title="t('TXT_CODE_SHOP_INSTANCE')" dataIndex="instanceNickname" :width="120" />
                  <a-table-column :title="t('TXT_CODE_SHOP_MONTHLY')" :width="70">
                    <template #default="{ record }">
                      {{ record.periodType === "monthly" ? t("TXT_CODE_SHOP_MONTHLY") : record.periodType === "quarterly" ? t("TXT_CODE_SHOP_QUARTERLY") : t("TXT_CODE_SHOP_YEARLY") }}
                    </template>
                  </a-table-column>
                  <a-table-column :title="t('TXT_CODE_SHOP_AMOUNT')" dataIndex="amount" :width="70">
                    <template #default="{ record }">
                      <span style="color: #f5222d; font-weight: 600">¥{{ record.amount }}</span>
                    </template>
                  </a-table-column>
                  <a-table-column title="状态" :width="70">
                    <template #default="{ record }">
                      <span class="status-text" :class="'status-' + record.status">{{ statusLabels[record.status] }}</span>
                    </template>
                  </a-table-column>
                  <a-table-column title="交易号" dataIndex="transactionId" :width="120" ellipsis />
                  <a-table-column title="创建时间" :width="130">
                    <template #default="{ record }">
                      {{ formatDate(record.createdAt) }}
                    </template>
                  </a-table-column>
                  <a-table-column title="操作" :width="60" fixed="right">
                    <template #default="{ record }">
                      <a-button type="link" size="small" danger @click="handleDeleteOrder(record)">
                        <DeleteOutlined />
                      </a-button>
                    </template>
                  </a-table-column>
                </a-table>
                <a-empty v-else />
              </a-spin>
            </div>
          </a-tab-pane>
        </a-tabs>
      </div>

      <!-- Price Editor Modal -->
      <a-modal
        v-model:open="priceModalVisible"
        :title="`${t('TXT_CODE_SHOP_ADMIN_SET_PRICE')} - ${editingPrice.instanceName}`"
        :confirm-loading="priceLoading"
        @ok="savePrice"
        :width="460"
        centered
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
            />
            <span class="form-hint">例如 0.9 表示九折，当前季付价：¥{{ (editingPrice.basePrice * 3 * editingPrice.quarterlyDiscount).toFixed(2) }}</span>
          </a-form-item>
          <a-form-item :label="t('TXT_CODE_SHOP_YEARLY_DISCOUNT')">
            <a-input-number
              v-model:value="editingPrice.yearlyDiscount"
              :min="0.01"
              :max="1"
              :step="0.05"
              :precision="2"
              style="width: 100%"
            />
            <span class="form-hint">例如 0.8 表示八折，当前年付价：¥{{ (editingPrice.basePrice * 12 * editingPrice.yearlyDiscount).toFixed(2) }}</span>
          </a-form-item>
        </a-form>
      </a-modal>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.shop-admin-container {
  overflow-y: auto;
  padding: 0 8px 16px;
}

.admin-users {
  .user-instances {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .admin-instance-card {
    background: var(--color-fill-1);
    border: 1px solid var(--color-border-secondary);
    border-radius: 6px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .admin-instance-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .admin-instance-info {
    display: flex;
    align-items: center;
  }

  .admin-instance-name {
    font-weight: 500;
    color: var(--color-text-1);
  }

  .admin-instance-price {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .price-set {
      font-size: 13px;
      color: var(--color-text-2);
    }
  }
}

.admin-orders {
  .order-filters {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  :deep(.ant-table) {
    background: transparent;
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

.form-hint {
  font-size: 12px;
  color: var(--color-text-3);
  margin-top: 4px;
}
</style>
