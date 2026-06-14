# 商城系统设计文档

## 概述

为 MCSM 面板新增商城系统，替代现有 `/shop` 路由的 Pro 面板 Iframe 实现。商城系统支持普通用户对自有实例进行续费（月付/季付/年付），通过虎皮椒支付网关完成支付，支付回调后自动延长实例到期时间。管理员可查看所有用户实例信息、调整实例定价、查看订单记录。

## 关键决策记录

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 导航位置 | 替换现有 `/shop` 路由 | 功能定位一致，避免两个商城入口造成用户困惑 |
| 定价模型 | 每实例独立定价 + 折扣率自动计算 | 灵活且减少管理员配置工作量 |
| 支付方式 | 虎皮椒自动识别端内支付 | 开发成本最低，用户体验最顺畅 |
| 到期处理 | 已有实现，不重复开发 | 现有逻辑已处理到期停服 |
| 管理员功能 | 查看 + 调价 + 订单记录（不含手动续费） | 手动续期已存在于其他功能中 |
| 并发安全 | 内存锁 + 数据库幂等 | 对 MCSM 规模足够，无需 Redis |
| 前端布局 | 独立页面，不参与卡片布局系统 | 商城交互流程复杂，独立页面更连贯 |
| 存储方案 | SQLite (better-sqlite3) | 零部署成本，事务支持，比 JSONL 可靠 |
| 架构模式 | Panel 内独立模块，单体架构 | 不引入外部服务依赖 |

## 一、数据模型

### 1.1 订单表 (`shop_orders`)

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PRIMARY KEY | UUID，订单唯一标识 |
| `trade_order_id` | TEXT | UNIQUE | 商户订单号，传给虎皮椒的 `trade_order_id` |
| `user_uuid` | TEXT | NOT NULL | 下单用户 UUID |
| `user_name` | TEXT | NOT NULL | 下单用户名（冗余存储，便于管理员查看） |
| `daemon_id` | TEXT | NOT NULL | 实例所属守护进程 ID |
| `instance_uuid` | TEXT | NOT NULL | 实例 UUID |
| `instance_nickname` | TEXT | | 实例名称（冗余存储） |
| `period_type` | TEXT | NOT NULL | 续费周期：`monthly` / `quarterly` / `yearly` |
| `period_months` | INTEGER | NOT NULL | 周期月数：1 / 3 / 12 |
| `amount` | REAL | NOT NULL | 实付金额（元） |
| `base_price` | REAL | NOT NULL | 基础月价（元） |
| `discount_rate` | REAL | NOT NULL | 折扣率（如 0.9 表示九折） |
| `status` | TEXT | NOT NULL | 订单状态：`pending` / `paid` / `failed` / `expired` |
| `transaction_id` | TEXT | | 虎皮椒交易号 |
| `pay_url` | TEXT | | 支付跳转链接 |
| `pay_time` | INTEGER | | 支付成功时间戳 |
| `expire_time` | INTEGER | NOT NULL | 订单过期时间戳（未支付订单15分钟过期） |
| `created_at` | INTEGER | NOT NULL | 创建时间戳 |
| `updated_at` | INTEGER | NOT NULL | 更新时间戳 |

索引：
- `idx_orders_user_uuid` ON (`user_uuid`)
- `idx_orders_status` ON (`status`)
- `idx_orders_daemon_instance` ON (`daemon_id`, `instance_uuid`)

### 1.2 实例定价表 (`shop_instance_prices`)

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `daemon_id` | TEXT | PRIMARY KEY (联合) | 守护进程 ID |
| `instance_uuid` | TEXT | PRIMARY KEY (联合) | 实例 UUID |
| `base_price` | REAL | NOT NULL | 基础月价（元） |
| `quarterly_discount` | REAL | NOT NULL DEFAULT 0.9 | 季付折扣率 |
| `yearly_discount` | REAL | NOT NULL DEFAULT 0.8 | 年付折扣率 |
| `updated_at` | INTEGER | NOT NULL | 更新时间戳 |
| `updated_by` | TEXT | NOT NULL | 最后修改者 UUID |

### 1.3 SystemConfig 新增字段

在现有 `SystemConfig` 类（`panel/src/app/entity/setting.ts`）中新增：

```typescript
// 虎皮椒支付配置
payAppId: string = "";           // 虎皮椒 APP ID
payAppSecret: string = "";       // 虎皮椒密钥
payGatewayUrl: string = "https://api.xunhupay.com/payment/do.html";  // 支付网关URL
payBackupUrl: string = "https://api.dpweixin.com/payment/do.html";   // 备用网关URL
payNotifyUrl: string = "";       // 回调通知URL（需管理员配置公网地址）
```

前端 `Settings` 类型（`frontend/src/types/index.ts`）和 `PanelStatus.settings` 也需同步扩展。

## 二、后端架构

### 2.1 新增文件结构

```
panel/src/app/
├── entity/
│   └── shop_order.ts            # 订单实体类
├── service/
│   ├── shop_order_service.ts     # 订单服务：CRUD + SQLite 操作
│   ├── shop_price_service.ts     # 定价服务：读写实例价格
│   └── shop_payment_service.ts   # 支付服务：发起支付 + 回调验签 + 幂等处理
├── routers/
│   ├── shop_user_router.ts       # 普通用户商城路由
│   └── shop_admin_router.ts      # 管理员商城路由
```

### 2.2 路由设计

**普通用户路由 (`shop_user_router.ts`，前缀 `/shop`)：**

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/shop/my-instances` | USER | 获取当前用户的实例列表及到期时间、价格信息 |
| POST | `/shop/create-order` | USER | 创建续费订单（参数: daemonId, instanceUuid, periodType） |
| GET | `/shop/order/:id` | USER | 查询订单详情及状态 |
| GET | `/shop/my-orders` | USER | 获取当前用户的历史订单列表（分页） |

**管理员路由 (`shop_admin_router.ts`，前缀 `/shop/admin`)：**

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/shop/admin/users` | ADMIN | 获取所有普通用户及其实例列表 |
| GET | `/shop/admin/orders` | ADMIN | 获取所有订单记录（分页、可筛选） |
| PUT | `/shop/admin/price` | ADMIN | 设置/修改实例定价 |
| GET | `/shop/admin/price/:daemonId/:instanceUuid` | ADMIN | 获取单个实例定价 |

**支付回调路由（公开，不走权限中间件）：**

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/shop/notify` | 无（独立验签） | 虎皮椒支付回调通知 |

### 2.3 核心流程

#### 创建订单流程

1. 用户选择实例 + 周期 → POST `/shop/create-order`
2. 后端校验：实例是否属于该用户、实例是否无限期（endTime === 0 则拒绝续费）
3. 检查是否已有该实例的 pending 订单（防止重复下单）
4. 读取实例定价，计算金额：
   - 月付：`base_price × 1`
   - 季付：`base_price × 3 × quarterly_discount`
   - 年付：`base_price × 12 × yearly_discount`
5. 生成订单记录（status=pending, expire_time=当前时间+15分钟）
6. 构造虎皮椒支付参数，计算 hash 签名
7. POST 请求虎皮椒支付网关，获取支付链接
8. 更新订单 pay_url 字段
9. 返回订单信息（含 pay_url）给前端

#### 支付回调流程

1. 虎皮椒 POST → `/shop/notify`（form 表单格式）
2. 验签：用 `hash` 参数外的所有非空参数按 ASCII 码排序拼接，末尾加 appSecret，MD5 计算后与 `hash` 比对
3. 验签失败：记录警告日志（含原始参数），返回 `success`（避免反复重试）
4. 获取内存锁（key=trade_order_id），获取失败则等待重试
5. 查询订单状态：
   - 若已 paid → 释放锁，返回 `success`（幂等）
   - 若非 pending → 释放锁，返回 `success`
6. 校验 `total_fee` 是否与订单 `amount` 一致
   - 不一致 → 标记订单 failed，记录日志，释放锁，返回 `success`
7. 校验 `status` 是否为 `OD`（已支付）
   - 非 OD → 释放锁，返回 `success`
8. 更新订单：status=paid, transaction_id, pay_time
9. 延长实例 endTime（使用月份计算，非固定秒数，以正确处理不同月份天数）：
   - 若当前 endTime > 当前时间：`newEndTime = endTime 对应日期 + period_months 个月`
   - 若当前 endTime ≤ 当前时间（已过期）：`newEndTime = 当前日期 + period_months 个月`
   - 具体实现：基于 Date 对象的 setMonth/getMonth 进行月份加减
10. 释放内存锁
11. 返回 `success`

#### 过期订单清理

定时任务每10分钟执行一次：
- 查询所有 status=pending 且 expire_time < 当前时间的订单
- 批量更新 status=expired

### 2.4 SQLite 初始化

- 数据库文件：Panel 数据目录下的 `shop.db`
- 启动时自动建表（IF NOT EXISTS）
- WAL 模式提升并发读性能
- better-sqlite3 同步 API，与 Koa 中间件配合使用时用 `await next()` 确保执行顺序

```typescript
import Database from 'better-sqlite3';

const db = new Database(path.join(dataDir, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
```

### 2.5 内存锁实现

```typescript
// 基于 Map 的简易内存锁
const lockMap = new Map<string, { locked: boolean; queue: Array<() => void> }>();

async function acquireLock(key: string, timeout: number = 5000): Promise<() => void> {
  // 尝试获取锁，若已被占用则排队等待
  // 超时后自动放弃
  // 返回 release 函数
}
```

### 2.6 虎皮椒签名算法

```typescript
function generateHash(params: Record<string, any>, appSecret: string): string {
  const sortedKeys = Object.keys(params)
    .filter(key => key !== 'hash' && params[key] !== '' && params[key] != null)
    .sort();
  const stringA = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  const stringSignTemp = stringA + appSecret;
  return md5(stringSignTemp);
}
```

## 三、前端设计

### 3.1 新增文件结构

```
frontend/src/
├── widgets/
│   └── shop/
│       ├── ShopPage.vue            # 商城主页面（替代原 ShelvesCard）
│       ├── UserInstanceList.vue     # 用户实例列表（含到期时间、续费按钮）
│       ├── RenewDialog.vue         # 续费弹窗（选周期、显示价格、确认支付）
│       ├── OrderList.vue           # 历史订单列表
│       ├── AdminView.vue           # 管理员视图（用户+实例+价格管理）
│       ├── AdminUserTable.vue      # 管理员-用户实例表格
│       ├── AdminOrderTable.vue     # 管理员-订单记录表格
│       └── AdminPriceEditor.vue    # 管理员-价格编辑弹窗
├── services/apis/
│   └── shop.ts                     # 商城相关 API 定义
```

### 3.2 路由修改

修改 `frontend/src/config/router.ts`：
- `/shop` 路由：移除 `condition` 中的 `businessMode` 检查（或保留为可选开关）
- 权限改为 `ROLE.USER`（普通用户和管理员均可访问）
- 移除 `onlyDisplayEditMode: true`

```typescript
{
  path: "/shop",
  name: t("TXT_CODE_5a408a5e"),
  component: LayoutContainer,
  meta: {
    permission: ROLE.USER,
    mainMenu: true,
    condition: () => {
      const { state: appConfig } = useAppStateStore();
      return appConfig.settings.businessMode;
    }
  }
}
```

### 3.3 页面布局

商城页面使用 `LeftMenusPanel`（与设置页一致风格），根据用户角色自动切换视图：

**普通用户视图：**
- 左侧菜单：我的实例 | 订单记录
- 右侧内容区：
  - **我的实例页**：卡片式列表，每个实例一个 `CardPanel`，显示：
    - 实例名称
    - 到期时间（无限期显示"无限期，无需续费"绿色标签，已过期显示红色"已过期"）
    - 剩余天数进度条（到期前7天变橙色预警）
    - 续费按钮 → 打开 RenewDialog（无限期实例不显示续费按钮）
  - **订单记录页**：`a-table` 显示历史订单，列：订单号、实例名、周期、金额、状态（Tag颜色区分）、创建时间

**管理员视图：**
- 左侧菜单：用户与实例 | 订单记录
- 右侧内容区：
  - **用户与实例页**：`a-table` 列出所有普通用户及其实例，可展开行查看实例详情，每行有"设置价格"操作按钮
  - **订单记录页**：所有用户的订单记录，支持按用户名/状态筛选，分页显示

### 3.4 核心交互流程

#### 续费流程

1. 用户点击实例卡片的「续费」按钮
2. 弹出 `RenewDialog`，显示：
   - 实例名称 + 当前到期时间
   - 三个周期选项卡：月付 / 季付 / 年付，每个显示计算后的价格
   - 底部显示实付金额
3. 用户选择周期 → 点击「立即支付」
4. 调用 POST `/shop/create-order`
5. 后端返回订单信息（含 pay_url）
6. 前端 `window.open(pay_url)` 新窗口打开支付页面
7. 前端开始轮询订单状态（每3秒 GET `/shop/order/:id`，最多5分钟）
8. 支付成功 → 轮询检测到 status=paid → 刷新实例列表，显示成功提示
9. 轮询超时 → 停止轮询，显示"支付结果确认中，请稍后在订单记录中查看"

#### 管理员调价流程

1. 在用户实例表格中点击「设置价格」
2. 弹出 `AdminPriceEditor`，显示：
   - 基础月价输入框
   - 季付折扣率输入框（默认0.9）
   - 年付折扣率输入框（默认0.8）
   - 实时预览：月付 ¥X / 季付 ¥X / 年付 ¥X
3. 确认保存 → PUT `/shop/admin/price`

### 3.5 设置页面集成

在现有 `Settings.vue` 的左侧菜单中新增菜单项：

```typescript
{
  title: t("TXT_CODE_SHOP_PAYMENT_SETTINGS"),
  key: "payment",
  icon: PayCircleOutlined
}
```

对应内容区显示：
- 虎皮椒 APP ID 输入框
- 虎皮椒密钥输入框（`a-input-password`）
- 支付网关 URL（默认值预填，可修改）
- 备用网关 URL（默认值预填，可修改）
- 回调通知 URL 输入框（提示：需填写服务器公网地址，如 `https://your-domain.com/api/shop/notify`）

需同步修改：
- `panel/src/app/routers/settings_router.ts`：在 PUT 路由中添加支付配置字段的写入逻辑
- `frontend/src/types/index.ts`：`Settings` 接口新增支付配置字段
- `frontend/src/types/index.ts`：`PanelStatus.settings` 新增相关字段（如果需要前端判断支付是否已配置）

### 3.6 API 定义文件

`frontend/src/services/apis/shop.ts`：

```typescript
import { useDefineApi } from "@/stores/useDefineApi";

// 获取我的实例列表（含价格信息）
export const getMyShopInstances = useDefineApi<any, ShopInstanceInfo[]>({
  url: "/shop/my-instances",
  method: "GET"
});

// 创建续费订单
export const createShopOrder = useDefineApi<{
  data: {
    daemonId: string;
    instanceUuid: string;
    periodType: "monthly" | "quarterly" | "yearly";
  }
}, ShopOrder>({
  url: "/shop/create-order",
  method: "POST"
});

// 查询订单详情
export const getShopOrder = useDefineApi<{
  params: { id: string };
}, ShopOrder>({
  url: "/shop/order/:id",
  method: "GET"
});

// 获取我的订单列表
export const getMyShopOrders = useDefineApi<{
  params: { page: number; page_size: number };
}, { data: ShopOrder[]; total: number; page: number; maxPage: number }>({
  url: "/shop/my-orders",
  method: "GET"
});

// 管理员：获取用户及实例列表
export const getAdminShopUsers = useDefineApi<any, AdminUserInfo[]>({
  url: "/shop/admin/users",
  method: "GET"
});

// 管理员：获取所有订单
export const getAdminShopOrders = useDefineApi<{
  params: { page: number; page_size: number; userName?: string; status?: string };
}, { data: ShopOrder[]; total: number; page: number; maxPage: number }>({
  url: "/shop/admin/orders",
  method: "GET"
});

// 管理员：设置实例定价
export const setShopInstancePrice = useDefineApi<{
  data: {
    daemonId: string;
    instanceUuid: string;
    basePrice: number;
    quarterlyDiscount: number;
    yearlyDiscount: number;
  };
}, any>({
  url: "/shop/admin/price",
  method: "PUT"
});

// 管理员：获取实例定价
export const getShopInstancePrice = useDefineApi<{
  params: { daemonId: string; instanceUuid: string };
}, InstancePrice>({
  url: "/shop/admin/price/:daemonId/:instanceUuid",
  method: "GET"
});
```

## 四、安全与错误处理

### 4.1 权限安全

| 安全点 | 措施 |
|--------|------|
| 普通用户越权访问管理员接口 | `shop_admin_router.ts` 所有路由使用 `permission({ level: ROLE.ADMIN })` 中间件 |
| 普通用户越权操作他人实例 | `create-order` 接口校验 `user.instances` 中是否包含该 daemonId + instanceUuid |
| 普通用户查看他人订单 | `my-orders` 和 `order/:id` 接口只返回当前用户 UUID 关联的订单 |
| 支付回调伪造 | 回调接口严格验签：按文档规则计算 hash，与传入 hash 比对，不匹配直接拒绝 |
| 订单金额篡改 | 回调时校验 `total_fee` 是否与订单记录中的 `amount` 一致 |
| APP Secret 泄露 | 密钥不在前端暴露，仅后端使用；设置页面用密码输入框显示 |

### 4.2 并发安全

| 安全点 | 措施 |
|--------|------|
| 同一订单并发回调 | 内存锁（Map 结构，key=trade_order_id），同一时刻只有一个回调进入处理逻辑 |
| 订单重复处理 | 数据库级别幂等：处理前先查 status，若已 paid 直接返回 success |
| 创建重复订单 | 同一用户同一实例的 pending 订单未过期时，不允许再创建 |
| Panel 重启后锁丢失 | 数据库幂等是兜底——即使锁丢失，查询到 paid 状态也不会重复处理 |
| 未支付订单堆积 | 定时任务每10分钟扫描，将超过15分钟的 pending 订单标记为 expired |

### 4.3 错误处理

| 场景 | 处理方式 |
|------|----------|
| 支付网关不可达 | 创建订单时 try/catch，失败返回前端友好提示"支付服务暂时不可用，请稍后重试" |
| 回调验签失败 | 记录警告日志（含原始参数），返回 `success`（避免虎皮椒反复重试） |
| 回调金额不匹配 | 标记订单为 failed，记录日志，返回 `success`，管理员可在订单记录中看到异常 |
| 续期失败（实例不存在等） | 标记订单为 paid 但记录错误日志，不回滚支付状态（已付的钱不能丢），管理员人工处理 |
| 前端支付轮询超时 | 5分钟后停止轮询，显示"支付结果确认中，请稍后在订单记录中查看" |
| SQLite 操作异常 | try/catch 包裹所有数据库操作，异常时 throw 给 Koa 全局错误处理 |

### 4.4 日志与审计

- 所有关键操作（创建订单、支付成功、续期完成、验签失败、金额不匹配）记录到 Panel 的 `logger`
- 管理员操作（调价、查看订单）通过 `operationLogger` 记录操作审计日志

## 五、测试策略

### 5.1 后端单元测试重点

| 测试项 | 测试内容 |
|--------|----------|
| 签名生成与验签 | 用开发文档中的示例数据验证 hash 计算正确性；伪造参数验证验签拒绝 |
| 价格计算 | 月付=base，季付=base×3×0.9，年付=base×12×0.8；边界值：0元、极大值 |
| 订单幂等 | 同一订单号连续回调两次，第二次应直接返回 success，不重复续期 |
| 内存锁 | 同一订单并发回调，只有一个进入处理逻辑 |
| 金额校验 | 回调金额与订单不匹配时，订单标记 failed |
| 过期订单清理 | 超过15分钟的 pending 订单被标记 expired |
| 权限拦截 | 普通用户访问 admin 接口返回 403；操作他人实例返回 403 |

### 5.2 前端交互测试重点

| 测试项 | 测试内容 |
|--------|----------|
| 无限期实例 | 不显示续费按钮，显示"无限期，无需续费"标签 |
| 已过期实例 | 到期时间红色显示，续费从当前时间开始计算 |
| 续费弹窗 | 周期切换时价格实时更新；点击支付后新窗口打开支付链接 |
| 支付轮询 | 创建订单后开始轮询；支付成功后自动刷新；超时后停止并提示 |
| 管理员视图 | 价格编辑实时预览；订单列表筛选和分页 |

### 5.3 集成测试场景

| 场景 | 流程 |
|------|------|
| 完整续费流程 | 创建订单 → 获取支付链接 → 模拟回调 → 订单变 paid → 实例 endTime 延长 |
| 并发回调 | 同一订单同时发送两次回调 → 只处理一次 |
| 重复下单 | 同实例有 pending 订单时再创建 → 被拒绝 |

## 六、依赖变更

### 6.1 后端新增依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| better-sqlite3 | ^11.0.0 | SQLite 数据库驱动 |
| @types/better-sqlite3 | ^7.6.0 | TypeScript 类型定义 |

### 6.2 前端无新增依赖

所有使用的组件（CardPanel, LeftMenusPanel, a-table, a-modal 等）已在项目中存在。

## 七、现有文件修改清单

### 后端修改

| 文件 | 修改内容 |
|------|----------|
| `panel/src/app/entity/setting.ts` | 新增支付配置字段（payAppId, payAppSecret, payGatewayUrl, payBackupUrl, payNotifyUrl） |
| `panel/src/app/routers/settings_router.ts` | PUT 路由中添加支付配置字段的写入逻辑 |
| `panel/src/app/index.ts` | 注册商城路由、初始化 SQLite 数据库、启动过期订单清理定时任务 |

### 前端修改

| 文件 | 修改内容 |
|------|----------|
| `frontend/src/config/router.ts` | `/shop` 路由权限改为 ROLE.USER，移除 onlyDisplayEditMode |
| `frontend/src/types/index.ts` | Settings 接口新增支付配置字段 |
| `frontend/src/types/user.ts` | 新增商城相关类型定义 |
| `frontend/src/widgets/Settings.vue` | 新增"支付设置"菜单项和对应内容区 |
| `frontend/src/stores/useAppStateStore.ts` | settings 中新增支付相关字段（如需要前端判断支付是否已配置） |
