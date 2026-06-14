# 商城系统实现计划

基于设计文档 `2026-05-20-shop-system-design.md`，将实现分为7个阶段，每个阶段产出一个可测试的增量。

## 阶段一：后端基础设施（SQLite + 实体 + 配置扩展）

**目标：** 搭建 SQLite 数据库基础设施，扩展 SystemConfig 支付配置，创建订单实体类。

**步骤：**

1. **安装依赖**
   - 在 `panel/package.json` 中添加 `better-sqlite3` 和 `@types/better-sqlite3`
   - 运行 `npm install`

2. **创建 SQLite 初始化服务** `panel/src/app/service/shop_database.ts`
   - 初始化数据库连接（数据目录下 `shop.db`）
   - 设置 WAL 模式
   - 建表 SQL（shop_orders, shop_instance_prices）
   - 创建索引
   - 导出 `getDB()` 方法供其他服务使用
   - 导出 `initShopDatabase()` 供 Panel 启动时调用
   - 导出 `closeShopDatabase()` 供 Panel 关闭时调用

3. **创建订单实体类** `panel/src/app/entity/shop_order.ts`
   - 定义 `ShopOrder` 接口（字段与设计文档一致）
   - 定义 `InstancePrice` 接口
   - 定义订单状态枚举 `OrderStatus`
   - 定义周期类型枚举 `PeriodType`

4. **扩展 SystemConfig** `panel/src/app/entity/setting.ts`
   - 新增5个支付配置字段：payAppId, payAppSecret, payGatewayUrl, payBackupUrl, payNotifyUrl

5. **扩展设置路由** `panel/src/app/routers/settings_router.ts`
   - 在 PUT `/overview/setting` 路由中添加支付配置字段的写入逻辑
   - payAppSecret 需要做基本的非空校验

6. **注册数据库初始化**
   - 找到 Panel 启动入口（`panel/src/app/app.ts` 或类似文件）
   - 在启动流程中调用 `initShopDatabase()`
   - 在关闭流程中调用 `closeShopDatabase()`

**验证：**
- Panel 能正常启动
- `shop.db` 文件自动创建，包含两张表和索引
- 管理员可通过设置页面保存支付配置（此时前端还没改，用 API 测试工具验证）

---

## 阶段二：后端定价服务 + 内存锁

**目标：** 实现实例定价 CRUD 服务和内存锁工具。

**步骤：**

1. **创建定价服务** `panel/src/app/service/shop_price_service.ts`
   - `getPrice(daemonId, instanceUuid)` → 查询实例定价，未设置则返回 null
   - `setPrice(daemonId, instanceUuid, basePrice, quarterlyDiscount, yearlyDiscount, updatedBy)` → 插入或更新定价
   - `getAllPrices()` → 查询所有定价记录（管理员用）
   - `getPricesByInstances(instances: {daemonId, instanceUuid}[])` → 批量查询定价（用户实例列表用）

2. **创建内存锁** `panel/src/app/service/shop_lock.ts`
   - `acquireLock(key: string, timeout?: number)` → Promise<release function>
   - 基于 Map 实现，支持排队等待
   - 超时自动释放
   - 导出单例实例

3. **创建通用工具** `panel/src/app/service/shop_utils.ts`
   - `calculateAmount(basePrice, periodType, quarterlyDiscount, yearlyDiscount)` → 计算实付金额
   - `addMonthsToDate(date: Date, months: number)` → 月份加减工具
   - `generateTradeOrderId()` → 生成商户订单号（时间戳+随机数格式）
   - `isPaymentConfigured()` → 检查支付配置是否完整

**验证：**
- 单元测试：价格计算正确性
- 单元测试：内存锁并发控制
- 单元测试：月份加减边界情况

---

## 阶段三：后端支付服务 + 用户路由

**目标：** 实现支付核心流程（创建订单、支付回调、验签）和普通用户路由。

**步骤：**

1. **创建支付服务** `panel/src/app/service/shop_payment_service.ts`
   - `generateHash(params, appSecret)` → 按虎皮椒文档计算 MD5 签名
   - `createPayment(order)` → 调用虎皮椒支付网关，获取支付链接
   - `verifyCallback(params)` → 验证回调签名
   - `processPaymentCallback(params)` → 完整回调处理流程（验签→加锁→查订单→验金额→更新订单→延长实例→释放锁）
   - 延长实例 endTime 的实现：通过 `RemoteRequest` 向 Daemon 发送实例配置更新请求
   - `extendInstanceEndTime(daemonId, instanceUuid, periodType, periodMonths)` → 延长实例到期时间

2. **创建订单服务** `panel/src/app/service/shop_order_service.ts`
   - `createOrder(params)` → 创建订单记录
   - `getOrderById(id)` → 查询订单
   - `getOrderByTradeOrderId(tradeOrderId)` → 按商户订单号查询
   - `updateOrder(id, updates)` → 更新订单
   - `getOrdersByUserUuid(userUuid, page, pageSize)` → 用户订单分页列表
   - `getAllOrders(page, pageSize, filters?)` → 管理员订单分页列表
   - `getPendingOrderByInstance(userUuid, daemonId, instanceUuid)` → 查找该实例的未支付订单
   - `cleanExpiredOrders()` → 清理过期订单

3. **创建用户路由** `panel/src/app/routers/shop_user_router.ts`
   - GET `/shop/my-instances` → 获取当前用户实例列表 + 定价信息 + 到期时间
     - 调用 `getInstancesByUuid` 获取实例详情
     - 调用 `shopPriceService.getPricesByInstances` 获取定价
     - 合并返回
   - POST `/shop/create-order` → 创建订单
     - 参数校验
     - 权限校验（实例是否属于该用户）
     - 无限期实例拒绝续费
     - 检查未支付订单
     - 读取定价计算金额
     - 创建订单 + 调用支付网关
     - 返回订单信息含 pay_url
   - GET `/shop/order/:id` → 查询订单详情（仅限自己的订单）
   - GET `/shop/my-orders` → 用户订单历史（分页）

4. **创建回调路由**（先放在 `shop_user_router.ts` 中）
   - POST `/shop/notify` → 支付回调（不走权限中间件）
   - 使用 `koa-body` 的 form 类型解析
   - 调用 `processPaymentCallback` 处理

5. **注册路由** `panel/src/app/index.ts`
   - 导入并注册 `shopUserRouter`

6. **启动过期订单清理定时任务**
   - 在 Panel 启动入口中添加 `setInterval(cleanExpiredOrders, 10 * 60 * 1000)`

**验证：**
- 单元测试：签名计算与验签
- 单元测试：完整回调处理流程
- API 测试：创建订单 → 获取支付链接
- API 测试：模拟回调 → 订单状态更新 → 实例时间延长

---

## 阶段四：后端管理员路由

**目标：** 实现管理员查看用户/实例、调价、订单记录的路由。

**步骤：**

1. **创建管理员路由** `panel/src/app/routers/shop_admin_router.ts`
   - GET `/shop/admin/users` → 所有普通用户及其实例
     - 从 `userSystem.objects` 中筛选 permission < 10 的用户
     - 对每个用户的实例调用 `RemoteRequest` 获取详情（endTime, nickname 等）
     - 合并定价信息
     - 返回结构化数据
   - GET `/shop/admin/orders` → 所有订单记录
     - 调用 `shopOrderService.getAllOrders`
     - 支持 userName 和 status 筛选
     - 分页
   - PUT `/shop/admin/price` → 设置/修改实例定价
     - 参数校验（basePrice ≥ 0, 0 < discount ≤ 1）
     - 调用 `shopPriceService.setPrice`
     - 通过 `operationLogger` 记录审计日志
   - GET `/shop/admin/price/:daemonId/:instanceUuid` → 获取单个实例定价
     - 调用 `shopPriceService.getPrice`

2. **注册路由** `panel/src/app/index.ts`
   - 导入并注册 `shopAdminRouter`

**验证：**
- API 测试：管理员获取用户列表
- API 测试：管理员设置/获取定价
- API 测试：管理员获取订单列表和筛选
- 权限测试：普通用户访问 admin 接口返回 403

---

## 阶段五：前端基础（API 定义 + 类型 + 路由修改 + 设置页面）

**目标：** 建立前端基础设施，修改路由，添加支付设置页面。

**步骤：**

1. **创建类型定义** `frontend/src/types/user.ts` 扩展
   - 新增 `ShopOrder` 接口
   - 新增 `InstancePrice` 接口
   - 新增 `ShopInstanceInfo` 接口（实例信息+定价+到期时间）
   - 新增 `AdminUserInfo` 接口

2. **扩展 Settings 类型** `frontend/src/types/index.ts`
   - `Settings` 接口新增：payAppId, payAppSecret, payGatewayUrl, payBackupUrl, payNotifyUrl

3. **扩展 PanelStatus** `frontend/src/types/index.ts`
   - `settings` 中新增 `paymentConfigured: boolean`（可选，若前端需要判断）

4. **创建 API 定义** `frontend/src/services/apis/shop.ts`
   - 参照设计文档 3.6 节定义所有 API

5. **修改路由** `frontend/src/config/router.ts`
   - `/shop` 路由：permission 改为 `ROLE.USER`，移除 `onlyDisplayEditMode`
   - 保留 `businessMode` condition 作为商城功能总开关

6. **修改设置页面** `frontend/src/widgets/Settings.vue`
   - menus 数组中新增"支付设置"项
   - 新增 `#payment` 模板插槽，包含：
     - 虎皮椒 APP ID 输入框
     - 虎皮椒密钥输入框（a-input-password）
     - 支付网关 URL 输入框（默认值预填）
     - 备用网关 URL 输入框（默认值预填）
     - 回调通知 URL 输入框（带提示文字）
   - 在 submit 函数中处理支付配置字段的提交

7. **扩展 useAppStateStore** `frontend/src/stores/useAppStateStore.ts`
   - settings 中新增支付相关字段（如 `paymentConfigured`）

**验证：**
- 设置页面能正确显示"支付设置"选项卡
- 能保存和加载支付配置
- `/shop` 路由可被普通用户和管理员访问

---

## 阶段六：前端用户商城页面

**目标：** 实现普通用户的商城界面（实例列表+续费弹窗+订单记录）。

**步骤：**

1. **创建商城主页面** `frontend/src/widgets/shop/ShopPage.vue`
   - 使用 `LeftMenusPanel` 组件
   - 根据 `isAdmin` 显示不同菜单和视图
   - 普通用户菜单：我的实例 | 订单记录
   - 管理员菜单：用户与实例 | 订单记录

2. **创建用户实例列表** `frontend/src/widgets/shop/UserInstanceList.vue`
   - 调用 `getMyShopInstances` API
   - 每个实例一个 `CardPanel` 卡片，显示：
     - 实例名称
     - 所在节点
     - 到期时间（格式化显示）
     - endTime === 0：显示绿色 `a-tag` "无限期，无需续费"，不显示续费按钮
     - 已过期：显示红色 "已过期"
     - 即将到期（7天内）：橙色预警
     - 剩余天数进度条
     - 续费按钮（仅有限期实例显示）→ 点击打开 RenewDialog
   - 如果实例没有定价，显示"未设置价格"提示

3. **创建续费弹窗** `frontend/src/widgets/shop/RenewDialog.vue`
   - `a-modal` 弹窗
   - 顶部显示：实例名称 + 当前到期时间
   - 三个 `a-radio-button` 选项：月付 / 季付 / 年付
   - 每个选项旁显示计算后的价格
   - 底部显示实付金额（大号字体，红色）
   - "立即支付"按钮
   - 支付流程：
     - 点击"立即支付" → 调用 `createShopOrder`
     - 成功后 `window.open(payUrl)` 新窗口打开支付
     - 开始轮询订单状态（每3秒，最多100次/5分钟）
     - 成功：`message.success` + 刷新实例列表 + 关闭弹窗
     - 超时：显示提示信息
   - loading 状态管理

4. **创建订单列表** `frontend/src/widgets/shop/OrderList.vue`
   - `a-table` 表格
   - 列：订单号、实例名、周期类型、金额、状态（Tag 颜色区分）、创建时间
   - 分页
   - 状态映射：pending=蓝、paid=绿、failed=红、expired=灰

5. **修改 ShelvesCard** `frontend/src/widgets/ShelvesCard.vue`
   - 替换为引用 ShopPage 组件
   - 或者直接修改路由指向新组件

**验证：**
- 普通用户登录后可看到商城菜单
- 实例列表正确显示到期时间、定价
- 无限期实例不显示续费按钮
- 续费弹窗价格计算正确
- 支付流程完整：创建订单→打开支付窗口→轮询状态→成功刷新
- 订单列表正确显示历史订单

---

## 阶段七：前端管理员商城页面

**目标：** 实现管理员商城界面（用户实例表格+价格编辑+订单记录）。

**步骤：**

1. **创建管理员视图** `frontend/src/widgets/shop/AdminView.vue`
   - 管理员专用的左侧菜单和内容区

2. **创建用户实例表格** `frontend/src/widgets/shop/AdminUserTable.vue`
   - `a-table` 可展开表格
   - 主行：用户名、实例数量、操作
   - 展开行：该用户的所有实例，列：实例名、所在节点、到期时间、月付价格、操作
   - 操作列："设置价格"按钮 → 打开 AdminPriceEditor

3. **创建价格编辑弹窗** `frontend/src/widgets/shop/AdminPriceEditor.vue`
   - `a-modal` 弹窗
   - 显示实例名称
   - 基础月价输入框（`a-input-number`，min=0）
   - 季付折扣率输入框（`a-input-number`，min=0.01, max=1, step=0.01, default=0.9）
   - 年付折扣率输入框（`a-input-number`，min=0.01, max=1, step=0.01, default=0.8）
   - 实时预览区域：
     - 月付：¥XX
     - 季付：¥XX（原价 ¥XX，已省 ¥XX）
     - 年付：¥XX（原价 ¥XX，已省 ¥XX）
   - "保存"按钮 → 调用 `setShopInstancePrice`

4. **创建管理员订单表格** `frontend/src/widgets/shop/AdminOrderTable.vue`
   - `a-table` 表格
   - 筛选区：用户名输入框 + 状态下拉选择
   - 列：订单号、用户名、实例名、周期、金额、状态（Tag）、支付时间、创建时间
   - 分页

5. **整合到 ShopPage**
   - ShopPage 根据 `isAdmin` 切换渲染 UserInstanceList+OrderList 或 AdminView

**验证：**
- 管理员登录后商城页面显示管理员视图
- 用户实例表格正确显示所有用户
- 价格编辑弹窗实时预览正确
- 保存价格后实例列表价格更新
- 订单记录筛选和分页正常
- 普通用户无法看到管理员界面

---

## 文件变更总结

### 新增文件（13个）

| 文件路径 | 阶段 |
|----------|------|
| `panel/src/app/service/shop_database.ts` | 一 |
| `panel/src/app/entity/shop_order.ts` | 一 |
| `panel/src/app/service/shop_price_service.ts` | 二 |
| `panel/src/app/service/shop_lock.ts` | 二 |
| `panel/src/app/service/shop_utils.ts` | 二 |
| `panel/src/app/service/shop_payment_service.ts` | 三 |
| `panel/src/app/service/shop_order_service.ts` | 三 |
| `panel/src/app/routers/shop_user_router.ts` | 三 |
| `panel/src/app/routers/shop_admin_router.ts` | 四 |
| `frontend/src/services/apis/shop.ts` | 五 |
| `frontend/src/widgets/shop/ShopPage.vue` | 六 |
| `frontend/src/widgets/shop/UserInstanceList.vue` | 六 |
| `frontend/src/widgets/shop/RenewDialog.vue` | 六 |
| `frontend/src/widgets/shop/OrderList.vue` | 六 |
| `frontend/src/widgets/shop/AdminView.vue` | 七 |
| `frontend/src/widgets/shop/AdminUserTable.vue` | 七 |
| `frontend/src/widgets/shop/AdminPriceEditor.vue` | 七 |
| `frontend/src/widgets/shop/AdminOrderTable.vue` | 七 |

### 修改文件（8个）

| 文件路径 | 阶段 | 修改内容 |
|----------|------|----------|
| `panel/package.json` | 一 | 添加 better-sqlite3 依赖 |
| `panel/src/app/entity/setting.ts` | 一 | 新增5个支付配置字段 |
| `panel/src/app/routers/settings_router.ts` | 一 | 支付配置写入逻辑 |
| `panel/src/app/index.ts` | 三+四 | 注册商城路由 |
| `frontend/src/types/index.ts` | 五 | Settings 接口扩展 |
| `frontend/src/types/user.ts` | 五 | 商城类型定义 |
| `frontend/src/config/router.ts` | 五 | `/shop` 路由修改 |
| `frontend/src/widgets/Settings.vue` | 五 | 支付设置选项卡 |
| `frontend/src/stores/useAppStateStore.ts` | 五 | 支付配置状态 |
| `frontend/src/widgets/ShelvesCard.vue` | 六 | 替换为 ShopPage 引用 |
