# Context bàn giao — mang cơ chế billing sang SCIO Portal

Viết cho người sẽ tích hợp cơ chế này vào SCIO Portal. Tóm tắt project đang có,
cấu hình đã chốt, và phần nào port thẳng được / phần nào phải dựng lại.

---

## 1. Vị trí project

| | |
|---|---|
| Thư mục trên máy | `/Users/ryanngo/Desktop/test-stripe` |
| Repo | https://github.com/quangtienngo661/test-stripe (branch `main`) |
| Backend | NestJS, port **3123** |
| Frontend | React + Vite, port **5555** |
| MongoDB | port **27099** |
| Khoá Stripe | `backend/.env` (**không** nằm trong repo; mẫu ở `backend/.env.example`) |

Chạy: `mongod --port 27099 --dbpath ./.mongo-data`, rồi `npm run dev` ở
`backend/` và `npm run dev` ở `frontend/`. Chi tiết trong
[README](../README.md) mục 1.

---

## 2. Project này là gì, và không là gì

**Là:** một bản demo chạy được, mọi luật tính tiền là **cấu hình** chứ không phải
code — sửa policy là đổi hành vi thật của Stripe, không phải đổi số học nội bộ.
Toàn bộ con số trong docs đều đo từ Stripe test mode.

**Không là:** hệ thống production. Không có auth, không có metering thật, không
có webhook secret. Xem mục 7.

**Ý tưởng trung tâm đáng mang sang nhất:** một document policy duy nhất trong
Mongo, mỗi nút trong đó ánh xạ thẳng sang một tham số Stripe. Bảng ánh xạ đầy đủ:
[stripe-mapping.md](stripe-mapping.md).

---

## 3. Stack

| | |
|---|---|
| NestJS | `^12.0.3` |
| Stripe SDK | `^22.6.2` → API version **`2026-08-26.dahlia`** |
| Mongoose | `^9.10.1` |
| TypeScript | `^6.0.3` (bản 7 chưa có compiler API mà nest CLI cần) |
| React / Vite | `^19.3.0` / `^8.3.0` |

API version quan trọng: ở `dahlia`, `current_period_*` nằm trên **SubscriptionItem**
chứ không phải Subscription, và cờ proration nằm ở
`line.parent.subscription_item_details.proration`.

---

## 4. Cấu hình đã chốt cho SCIO

Chọn preset **`scio_portal_mvp`** (tab Billing policy, hoặc
`POST /api/policy/presets/scio_portal_mvp`). Định nghĩa ở
[policy.presets.ts](../backend/src/policy/policy.presets.ts).

### Danh mục trong phạm vi

| Mã | Tên | Tháng | Năm | Ghi chú |
|---|---|---|---|---|
| `standard` | Standard plan | $10.00 | $108/năm | theo màn hình |
| `x_social` | X Social | **$20.00** | **$216/năm** | quantity cố định 1, 2.000 Post Updates / quota month |

### Luật (MODEL V6)

| Thao tác | Tiền (Stripe) | Quota (SCIO) |
|---|---|---|
| Mua X | prorate tới billing boundary, thu ngay, thẻ hỏng thì không đổi gì | reservation 2.000 trước; paid → grant `floor(2.000 × đã trả / tháng)` |
| **Huỷ X** | xoá item **ngay**; tháng không hoàn; năm credit từ quotaMonthEnd | FROZEN tới hết quota month, fan-out tắt |
| Resume X | charge từ `max(now, hết phần đã trả)` | cùng tháng → mở lại ledger cũ; qua tháng → kích hoạt mới |
| Đổi term | native cùng gói nền (X ACTIVE) | giữ Used, chỉ cộng delta dương |
| Huỷ plan | cuối kỳ, không prorate | X ENDED cùng plan |

### Bốn ràng buộc cứng

1. Phải có gói nền đã trả tiền mới mua được X (`addOnsRequirePaidPlan`, và gói
   nền không được đang trial)
2. X bám interval của gói nền
3. Một X mỗi tenant, quantity 1
4. Capacity: `Committed + Pending + 2.000 ≤ 2.500.000` (`xCommercialCeilingUnits`)

### Ngoài phạm vi

Pro Plus, Engage, thêm/bớt màn hình, Background Music, Video Wall, Wireless
Presentation, `planUpgrade`/`planDowngrade`. Vẫn còn trong hệ thống, portal MVP
không chạm tới.

Chi tiết đầy đủ: [scio-portal-mvp.md](scio-portal-mvp.md).

---

## 5. Cơ chế cốt lõi cần hiểu trước khi port

### Phân giải rule — 3 tầng

[`policy.service.ts:191`](../backend/src/policy/policy.service.ts:191)

```ts
return { ...rule, ...itemRule, ...(override ?? {}) };
//        toàn cục   theo họ add-on   một lần duy nhất
```

Tầng giữa (`addOnRules`) cho phép một add-on hành xử khác **mà không phải rẽ
nhánh trong engine**. X Social không dùng nó: luồng của X do MODEL V6 chốt cứng.

### X Social: hai đồng hồ

- Tiền: Stripe prorate native — không có phép tính tay nào cho X.
- Quota: [`quota-math.ts`](../backend/src/x-addon/quota-math.ts) — thuần hàm,
  replay coverage từ hoá đơn đã paid, quota month cố định theo lịch, true-up gói
  năm. [`x-addon.service.ts`](../backend/src/x-addon/x-addon.service.ts) — trạng
  thái, ledger, capacity, cancel / resume / trial / trừ quota.
- Reconcile chạy **mỗi lần đọc state** và khi nhận `invoice.paid`, nên webhook
  lỡ chỉ làm grant đến muộn, không bao giờ mất hay trùng.

---

## 6. File phải đọc, theo thứ tự

1. [`policy.types.ts`](../backend/src/policy/policy.types.ts) — hình dạng cấu hình
2. [`policy.presets.ts`](../backend/src/policy/policy.presets.ts) — giá trị chốt
3. [`subscription.util.ts:64`](../backend/src/subscriptions/subscription.util.ts:64) `classifyChange` — nhận diện tình huống → chọn rule
4. [`subscriptions.service.ts`](../backend/src/subscriptions/subscriptions.service.ts) `change()` — cửa vào, rẽ sang X khi thêm/bỏ `x_social`
5. [`x-addon/quota-math.ts`](../backend/src/x-addon/quota-math.ts) — công thức quota của X
6. [`x-addon/x-addon.service.ts`](../backend/src/x-addon/x-addon.service.ts) — vòng đời X

---

## 7. Phải tự dựng lại ở SCIO — **không port thẳng được**

| Hạng mục | Tình trạng ở demo | Cần làm ở SCIO |
|---|---|---|
| **Đếm post thật** | ô nhập tay (`POST /api/x-addon/:id/sync-runs`) | mỗi lần fetch X gọi cùng hàm với số Post X thật trả về và tính phí, `actionId` là id của SyncRun |
| **Compliance / fan-out** | chỉ có cờ `fanOut` | Global Batch Compliance, XAA `post.delete`, lease 24 giờ nằm ngoài billing |
| **Webhook** | không có secret → dunning tự động không chạy | cấu hình `STRIPE_WEBHOOK_SECRET` |
| **Auth** | không có, mọi endpoint mở | bắt buộc |
| **Test clock** | dùng để tua thời gian | production không có; bỏ đường `nowFor()` hoặc để nó trả về giờ thật |

---

## 8. Đã kiểm chứng tới đâu

`node scripts/verify.mjs` — **chạy trên Stripe test mode thật**, không phải
mock: plan, màn hình, add-on theo đơn vị, chặn hoá đơn âm, ràng buộc add-on cần
plan. X Social theo MODEL V6 có bộ riêng `node scripts/verify-x-v6.mjs` (test
clock đặt đúng ngày của ví dụ trong model) và `node scripts/test-x-quota.mjs`
(phép tính quota, không cần Stripe).

> Suite **đổi preset toàn cục** trong lúc chạy và reset về `optisigns_default` ở
> cuối. Đừng chạy khi đang có người test trên cùng backend.

---

## 9. Bẫy đã gặp — đừng lặp lại

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Replay coverage sai thứ tự | huỷ rồi resume trong cùng một giây bị đọc thành mất coverage | sắp theo `created` rồi số hoá đơn; trong một hoá đơn dòng âm trước, dòng dương sau |
| Đọc thời gian bằng đồng hồ máy | account có test clock bị tính sai prorate | mọi lần đọc giờ đi qua `stripe.nowFor(testClockId)` |
| Nuốt lỗi khi đọc subscription | tạo trùng subscription thứ hai | chỉ `resource_missing`/404 mới coi là "không có"; lỗi khác phải ném |
| `create_prorations` thì balance không đổi | tưởng credit không được cấp | đo bằng chênh lệch dòng proration giữa hai lần preview, với `proration_date` ghim cố định |
| Nhầm gross/net khi hoàn tiền | từng hoàn dư $30 và ghi nợ hai lần | chọn gross hay net theo `prorationBehavior` |
| Test clock chỉ nhảy được 2 interval ngắn nhất mỗi lần | nhảy 1 năm thất bại | chia chặng (`advanceInSteps`) |

---

## 10. Tài liệu liên quan

- [business-rules.md](business-rules.md) — luật đầy đủ, ngôn ngữ nghiệp vụ
- [scio-portal-mvp.md](scio-portal-mvp.md) — phạm vi MVP chi tiết
- [stripe-mapping.md](stripe-mapping.md) — từng nút → tham số Stripe
- [optisigns-billing-model.md](optisigns-billing-model.md) — OptiSigns tính tiền thế nào
