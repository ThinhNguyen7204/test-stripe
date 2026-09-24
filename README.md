# OptiSigns Billing Demo — NestJS + React + Stripe + MongoDB

App demo mô phỏng cơ chế subscription + add-on của OptiSigns, với **toàn bộ luật
tính tiền, prorate, downgrade và hoàn tiền là cấu hình chạy được** — sửa policy
là đổi hành vi thật của Stripe.

| Thành phần | Port |
|---|---|
| Backend (NestJS) | `3123` |
| Frontend (React + Vite) | `5555` |
| MongoDB | `27099` |

Đọc thêm:
- [`docs/scio-integration-context.md`](docs/scio-integration-context.md) — **context bàn giao** để mang cơ chế này sang SCIO Portal
- [`docs/business-rules.md`](docs/business-rules.md) — **quy tắc tính tiền bằng ngôn ngữ nghiệp vụ** (bắt đầu từ đây)
- [`docs/scio-portal-mvp.md`](docs/scio-portal-mvp.md) — phạm vi mang sang **SCIO Portal**: Standard plan + X add-on
- [`docs/optisigns-billing-model.md`](docs/optisigns-billing-model.md) — OptiSigns tính tiền thế nào (kèm nguồn)
- [`docs/stripe-mapping.md`](docs/stripe-mapping.md) — từng nút vặn ánh xạ sang tham số Stripe nào

---

## 1. Chạy

### MongoDB (port 27099)

```bash
mongod --port 27099 --dbpath ./.mongo-data
```

### Backend

```bash
cd backend
cp .env.example .env     # rồi điền STRIPE_SECRET_KEY (sk_test_...)
npm install
npm run build && npm start      # hoặc: npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Mở http://localhost:5555

### Đẩy bảng giá lên Stripe

```bash
node scripts/seed.mjs
```

Hoặc bấm **Sync catalog → Stripe** trên UI. Script idempotent: price được so
khớp bằng `lookup_key` nên chạy lại không tạo trùng.

### Webhook (tuỳ chọn nhưng nên có)

```bash
stripe listen --forward-to localhost:3123/api/webhooks/stripe
```

Dán `whsec_...` vào `STRIPE_WEBHOOK_SECRET`. Không có secret thì endpoint vẫn
nhận payload chưa ký (tiện cho demo local).

### Kiểm thử toàn bộ vòng đời

```bash
node scripts/verify.mjs               # thêm --keep để giữ lại account trong Stripe
node scripts/verify-x-v6.mjs          # X add-on theo MODEL V6 (chạy riêng, không song song)
node scripts/test-x-quota.mjs         # phép tính quota V6, không cần Stripe (build backend trước)
```

Script đi hết 15 bước: trial → subscribe → thêm màn hình (prorate) → add-on →
ràng buộc add-on ≤ màn hình → bớt màn hình (credit) → downgrade có refund về thẻ
→ đổi sang annual → downgrade theo lịch → refund hoá đơn → guard rail refund →
tua đồng hồ tới kỳ gia hạn → pause/resume → huỷ ngay có prorate → audit log.
Backend phải đang chạy; script tự tạo rồi tự xoá account demo (dùng `--keep`
để giữ lại mà soi trong Stripe dashboard).

---

## 2. Bảng giá được mô phỏng

Giá lấy từ optisigns.com/pricing (đối chiếu cả Monthly lẫn Annual ngày
17/09/2026). Gói tính **theo màn hình / tháng**, annual giảm đúng 10% và thu
trọn 12 tháng:

| Gói | Monthly | Annual | Ghi chú |
|---|---|---|---|
| Free | $0 | — | tối đa 3 màn hình, không tạo Stripe subscription |
| Standard | $10.00 | $9.00 | tối đa 25 user |
| Pro Plus | $15.00 | $13.50 | Most Popular · unlimited user |
| Engage | $30.00 | $27.00 | kiosk tương tác |

Add-on nằm chung subscription, cùng term với gói nền:

| Add-on | Đơn vị | Monthly | Annual |
|---|---|---|---|
| Video Wall | wall | $25.00 | $22.50 |
| Background Music | screen | $15.00 | $13.50 |
| Wireless Presentation | screen | $20.00 | $18.00 |

**X Social** theo **MODEL V6**: mỗi tenant **tối đa 1 add-on, quantity cố định
bằng 1**, không còn tier Standard/Pro:

| Add-on | Monthly | Annual | Quota |
|---|---|---|---|
| X Social | $20.00 | $216.00 ($20 × 12 × 90%) | 2.000 Post Updates / quota month trả đủ |

Có **hai đồng hồ độc lập** (V6 row 6):

- **Tiền là của Stripe.** X là một item bình thường trên cùng subscription,
  cùng thẻ, cùng interval với gói nền, và được **Stripe prorate native**. Mua
  giữa kỳ thì trả phần kỳ còn lại, thu ngay (`always_invoice` +
  `error_if_incomplete`), thẻ hỏng thì không có gì thay đổi.
- **Quota là của SCIO**, tính trên **quota month cố định theo lịch UTC**
  (`[ngày 1 00:00, ngày 1 tháng sau)`), không theo ngày billing của Stripe:

```
GrantedTarget(Q) = floor(2.000 × giây đã trả tiền nằm trong Q / số giây của Q)
Remaining        = max(0, Granted − Used)
```

Thời gian đã trả tiền đọc lại từ **các dòng X trên hoá đơn đã `paid`** (chưa
`invoice.paid` thì chưa có quota) và lấy **hợp** các khoảng, nên đổi Monthly →
Yearly không bao giờ cấp trùng. Renewal hay đổi interval **không reset Used**,
chỉ cộng phần delta dương. Gói năm vẫn cấp theo từng quota month (1.733 +
11 × 2.000 + 267 = 24.000 cho kỳ 05/09 → 05/09, tháng cuối được true-up).

| Thao tác | Tiền (Stripe) | Quota (SCIO) |
|---|---|---|
| Mua giữa quota month | prorate tới billing boundary, thu ngay | `floor(2.000 × phần đã trả / tháng)` — mua 15/09, trả tới 01/10 → **1.066** |
| Renewal giữa quota month | Stripe thu kỳ mới | cộng phần còn thiếu vào **cùng** ledger (580 → +1.420 = 2.000) |
| Monthly ⇄ Yearly (X đang ACTIVE) | native proration cùng gói nền | giữ Used, chỉ tăng nếu coverage tăng |
| **Cancel X** | xoá item **ngay**. Monthly: `proration_behavior=none`, không hoàn. Yearly: `proration_date = quotaMonthEnd` → credit phần từ quotaMonthEnd vào customer balance | **FROZEN** tới quotaMonthEnd, tắt fan-out, giải phóng capacity |
| **Resume** cùng quota month | re-add item, charge từ `max(now, paidThrough)` — Monthly không thu trùng, Yearly debit lại đúng mốc đã credit | mở lại **đúng ledger cũ** (Granted/Used giữ nguyên) sau khi payment thành công |
| Resume sau quotaMonthEnd | như mua mới | quota cũ hết hạn, tháng mới cấp theo paid coverage |
| Hạ gói nền về Free | cuối kỳ đã trả, không prorate | X chạy tới boundary rồi ENDED cùng gói nền |
| Payment fail | không có coverage mới | chỉ dùng phần đã grant, qua paidThrough thì dừng fetch; trả được thì cộng delta |

**Trial X** (row 50): 14 ngày, 200 Post Updates trong ledger riêng, một lần mỗi
account, **chỉ Manual Refresh**, không có Stripe item. Mua add-on thì trial kết
thúc, số dư trial không chuyển sang.

**Trừ quota** (row 12): theo số Post X **thực trả về và tính phí** — hỏi 50, X
trả 12 thì trừ 12 — clamp bởi Remaining, **exactly-once** theo `actionId`. Hết
quota thì không gọi provider nữa, không tính overage.

**Capacity admission** (row 17): trước khi gọi Stripe, tenant giữ một
reservation 2.000 (TTL 15 phút); `Committed + Pending + 2.000 ≤ 2.500.000` mới
được bán; paid thì commit, fail/hết hạn thì release. 500.000 còn lại tới hard cap
3.000.000 là buffer không bán. Đổi interval không reserve thêm.

**Enterprise** ($45.00 / $40.50, tối thiểu 25 màn hình) là kênh "Talk With
Sales" nên không dựng trong demo self-serve này — thêm lại bằng một entry trong
[`catalog.constants.ts`](backend/src/catalog/catalog.constants.ts). Bảng giá
OptiSigns **không có gói "Pro"**.

Ràng buộc được enforce ở backend: `minQuantity` của gói, Free ≤ 3 màn hình và
không add-on, add-on tính theo màn hình không vượt quá số màn hình.

---

## 3. Cấu hình cơ chế ở đâu

Tab **Billing policy** trong UI (hoặc `GET/PUT /api/policy`) chỉnh:

- **8 change rule** — `screensIncrease`, `screensDecrease`, `planUpgrade`,
  `planDowngrade`, `addOnIncrease`, `addOnDecrease`, `termToYearly`,
  `termToMonthly`. Mỗi rule có `timing`, `prorationBehavior`,
  `billingCycleAnchor`, `paymentBehavior`, `creditHandling`.
  `creditHandling` có 5 giá trị: `customer_balance` (để nguyên chỗ Stripe đặt),
  `push_to_account_balance` (luôn hiện thành account credit),
  `refund_to_payment_method` (hoàn về thẻ), `none` (thu hồi credit),
  `block` (**từ chối** thao tác nếu nó khiến công ty phải trả lại tiền).
- **Per-add-on override** (`addOnRules`) — đè rule riêng cho từng add-on theo
  code. X Social **không** đi qua đây: mua / huỷ / resume của nó do MODEL V6
  chốt cứng trong `backend/src/x-addon/`.
- **Cancellation** — huỷ cuối kỳ hay huỷ ngay, có prorate không, phần chưa dùng
  thành credit hay hoàn về thẻ.
- **Trial** — `appliesTo` (`only_without_payment_method` như OptiSigns / `always` /
  `never`), số ngày, `requirePaymentMethod`, xử lý khi hết trial mà không có thẻ.
  Mỗi lần tạo subscription còn có checkbox riêng để bật/tắt trial cho lần đó,
  và nút **End trial now** để kết thúc trial giữa chừng (`trial_end: 'now'`).
- **Invoicing** — `collection_method`, `days_until_due`, `billing_mode`
  (flexible/classic), automatic tax, `payment_behavior`, neo kỳ về ngày 1.
- **Refunds** — cửa sổ ngày, credit note hay refund thuần, cho phép refund một
  phần, trần tự động duyệt.
- **Constraints** — min/max số lượng, quan hệ add-on ↔ màn hình, cho phép về 0
  màn hình, **add-on bắt buộc phải có subscription trả phí** mới mua được, và
  capacity của X (`xCommercialCeilingUnits`, `xProviderHardCapUnits`).
- **Dunning** — làm gì khi `invoice.payment_failed`, `pause_collection.behavior`.

### 6 preset dựng sẵn

| Preset | Hành vi |
|---|---|
| `scio_portal_mvp` | **Phạm vi migrate sang SCIO Portal**: Standard plan + X Social (MODEL V6), tháng hoặc năm. Hạ gói nền về Free có hiệu lực cuối kỳ đã trả; X chạy tới boundary đó |
| `optisigns_default` | Mọi credit ở lại trong Stripe dưới dạng **account credit**, không refund về thẻ. Prorate dồn vào hoá đơn kỳ sau; riêng **yearly → monthly áp dụng ngay** và phần năm chưa dùng thành credit |
| `charge_immediately` | Mọi thay đổi xuất hoá đơn và thu tiền ngay |
| `annual_commitment` | Upgrade ngay, mọi thao tác giảm — kể cả yearly → monthly — phải chờ tới kỳ gia hạn (subscription schedule), không hoàn tiền |
| `customer_friendly` | Giảm quy mô thì phát hành credit note và hoàn tiền về thẻ |
| `no_proration` | `proration_behavior=none` toàn bộ: đổi số lượng ngay, tiền đổi ở kỳ sau |

Ngoài ra mỗi thao tác có thể **override một lần** (mục "One-off policy override"
trong UI, hoặc field `overrides` khi gọi API) để so sánh hai hành vi cạnh nhau
mà không cần đổi policy chung.

---

## 4. Demo theo kịch bản

1. **Thêm màn hình thu tiền ngay** — tạo account có test clock, gắn thẻ test,
   mua Engage 2 màn hình. Tua +10 ngày, tăng lên 3 màn hình: Stripe xuất hoá đơn
   `subscription_update` **$20.00** ($30 × 20/30 ngày còn lại) và thu luôn, ngày
   gia hạn giữ nguyên — khớp hành vi production của OptiSigns. Đổi
   `screensIncrease.prorationBehavior` sang `create_prorations` để thấy hành vi
   dồn vào hoá đơn kỳ sau (đây là điều bài support công khai mô tả, nhưng đã lỗi
   thời — xem [docs/optisigns-billing-model.md](docs/optisigns-billing-model.md)).
2. **Credit khi bớt màn hình** — giảm về 2 màn hình: account credit tăng lên
   (hiển thị ở sidebar), hoá đơn kỳ sau tự trừ.
3a. **Lên gói thu tiền ngay** — Standard → Pro Plus giữa kỳ: một hoá đơn
   `subscription_update` gồm phần cũ chưa dùng (âm) + phần mới còn lại (dương),
   thu đúng chênh lệch. Ngày gia hạn giữ nguyên.
3b. **Mua add-on thu tiền ngay** — thêm AeriCast giữa kỳ: Stripe xuất hoá đơn
   riêng cho phần prorate và thu luôn, ngày gia hạn không đổi. Đổi sang thẻ
   `charge_fails` rồi mua tiếp để thấy `error_if_incomplete` chặn thẳng.
3. **Hoàn tiền thật khi downgrade** — đổi preset sang `customer_friendly`, lặp
   lại thao tác giảm: app phát hiện credit vừa sinh, hoàn về thẻ và ghi bút
   toán ngược để không cấn hai lần.
4. **Đổi monthly → yearly** — `billing_cycle_anchor: now`, chu kỳ reset, Stripe
   thu trọn 12 tháng ngay và trừ phần tháng chưa dùng.
4b. **Đổi yearly → monthly** — mặc định áp ngay: Stripe xuất hoá đơn gồm phần năm
   chưa dùng (âm) + tháng monthly đầu (dương), phần dư **ròng** thành account
   credit (`−$240.74`), tiền không rời Stripe. Preset `annual_commitment` cho
   hành vi chờ hết năm; `customer_friendly` cho hành vi hoàn thẳng về thẻ.
5. **Downgrade chờ cuối kỳ** — preset `annual_commitment`, hạ gói: app tạo
   subscription schedule, plan hiện tại giữ nguyên tới hết kỳ, tab Subscription
   hiện "Scheduled change".
6. **Tua thời gian** — nút *Next renewal* trong Time machine: Stripe xuất hoá
   đơn gia hạn thật, gồm cả proration tồn đọng và phase đã schedule.
7. **Dunning** — gắn thẻ `declined`, tua tới kỳ gia hạn: hoá đơn `past_due`,
   policy `dunning.pastDueBehavior` quyết định huỷ / pause / để Stripe retry.
8. **Refund** — tab *Invoices & refunds*, bấm Refund trên hoá đơn đã trả. Thử
   hạ `maxAutoApproveCents` hoặc `windowDays` để thấy API chặn đúng luật.
9. **Pause theo mùa** — *Pause (seasonal)*: `pause_collection` với behavior lấy
   từ policy, tương ứng luồng OnHold của OptiSigns.
10. **X Social theo MODEL V6** — tạo account có test clock, mua Standard, tua
    tới giữa tháng rồi bật **X Social: On**: preview hiện hoá đơn Stripe prorate
    và quota `floor(2.000 × ngày đã trả / ngày của quota month)`. Khối **X
    add-on** ở cột trái hiện status, quota month, Granted/Used/Remaining,
    paidThrough và capacity.
10b. **Provider fetch** — trong khối X add-on chọn Initial/Auto/Manual, nhập
    *asked* và *returned*: quota trừ theo *returned*, clamp theo Remaining.
10c. **Cancel → Resume** — *Cancel X*: tenant FROZEN tới hết quota month. Gói
    tháng không hoàn; gói năm credit từ quotaMonthEnd. *Resume X* trong cùng
    quota month mở lại đúng ledger cũ; tua qua ngày 1 rồi resume thì là kích hoạt
    mới. Kịch bản đầy đủ: `node scripts/verify-x-v6.mjs`.

Tab **Activity log** ghi lại mọi thao tác: rule nào được áp, policy lúc đó ra
sao, payload gửi sang Stripe là gì và Stripe trả về gì.

---

## 5. API

| Method | Endpoint | Việc |
|---|---|---|
| `GET` | `/api/catalog` | bảng giá + trạng thái sync |
| `POST` | `/api/catalog/sync-stripe` | tạo/cập nhật product & price trên Stripe |
| `POST` | `/api/catalog/reseed` | ghi lại bảng giá từ code vào Mongo |
| `GET/POST` | `/api/accounts` | danh sách / tạo account (kèm test clock) |
| `POST` | `/api/accounts/:id/payment-method/test` | gắn thẻ test (`visa`, `declined`, `authentication_required`, …) |
| `POST` | `/api/accounts/:id/checkout-setup` | Checkout session mode=setup để nhập thẻ thật |
| `GET/POST` | `/api/accounts/:id/balance` | xem / điều chỉnh customer balance |
| `GET` | `/api/subscriptions/:id` | trạng thái subscription + schedule |
| `POST` | `/api/subscriptions/:id/preview` | **dry-run**: hoá đơn Stripe sẽ tạo + giải thích rule |
| `POST` | `/api/subscriptions/:id/change` | áp thay đổi theo policy |
| `POST` | `/api/subscriptions/:id/cancel` \| `/resume` \| `/pause` \| `/unpause` \| `/end-trial` | vòng đời |
| `POST` | `/api/subscriptions/:id/cancel-scheduled-change` | huỷ một thay đổi đang chờ cuối kỳ, trước khi nó có hiệu lực |
| `GET` | `/api/subscriptions/:id/renewal-preview` | hoá đơn gia hạn kế tiếp |
| `GET` | `/api/billing/accounts/:id/invoices` | hoá đơn kèm line item, đánh dấu proration |
| `POST` | `/api/billing/invoices/:id/pay` \| `/void` \| `/finalize` \| `/uncollectible` | thao tác hoá đơn |
| `POST` | `/api/billing/accounts/:id/refund` | refund / credit note theo policy |
| `POST` | `/api/billing/portal/configuration` | đẩy policy sang Customer Portal config |
| `GET/PUT` | `/api/policy` | đọc / sửa billing policy |
| `POST` | `/api/policy/presets/:key` | áp preset |
| `POST` | `/api/simulator/:id/advance` | tua test clock |
| `GET` | `/api/x-addon/:id` | X add-on: status, quota month, ledger, paidThrough, coverage, capacity (reconcile từ hoá đơn đã paid) |
| `POST` | `/api/x-addon/:id/preview/:action` | dry-run `purchase` \| `cancel` \| `resume` |
| `POST` | `/api/x-addon/:id/cancel` \| `/resume` \| `/trial` | vòng đời X theo MODEL V6 |
| `POST` | `/api/x-addon/:id/sync-runs` | một lần fetch provider `{kind, requested, returned, actionId}` — trừ quota exactly-once |
| `POST` | `/api/webhooks/stripe` | webhook (raw body, có verify chữ ký) |
| `GET` | `/api/events` | nhật ký audit |

---

## 6. Kiến trúc

```
backend/src/
  catalog/      bảng giá OptiSigns ↔ Stripe Product/Price (lookup_key, idempotent)
  policy/       billing policy + preset  ← toàn bộ "cơ chế" nằm ở đây
  accounts/     tenant demo, Stripe customer, thẻ test, test clock, balance
  subscriptions/phân loại thay đổi → dựng item → update / schedule / cancel
  billing/      hoá đơn, refund, credit note, customer portal
  simulator/    test clock
  x-addon/      X Social MODEL V6: quota ledger theo quota month, capacity, cancel/resume/trial
  webhooks/     nhận sự kiện, sync ngược về Mongo, thực thi dunning
  events/       audit log (policy + payload + kết quả)
```

Luồng của một thay đổi:

```
desired state → validate ràng buộc → classifyChange() → rule = policy + override
   → timing=immediate ? subscriptions.update : subscriptionSchedules.update
   → đo customer.balance trước/sau → áp creditHandling
   → ghi audit → sync về Mongo
```

## 7. Giới hạn đã biết

- **Không có auth.** Mọi endpoint đều mở — demo chạy local, đừng expose ra ngoài.
- **X add-on chỉ mô phỏng phần billing/quota của MODEL V6.** Không gọi X API:
  provider fetch là ô nhập tay (`/x-addon/:id/sync-runs`), fan-out là một cờ
  trạng thái. Global Batch Compliance, XAA `post.delete`, compliance lease 24 giờ
  và Profile cap 10 không nằm trong demo này.
- **Không có webhook secret** trong cấu hình mặc định, nên các hành động dunning
  tự động không tự kích hoạt.
- `billing_mode` chỉ đặt được lúc tạo subscription (giới hạn của Stripe). Đổi
  trong policy chỉ ảnh hưởng subscription tạo sau đó; app sẽ cảnh báo khi
  subscription đang chạy lệch với policy.
- `automatic_tax` và `anchorToFirstOfMonth` cũng chỉ áp lúc tạo.
- `payment_behavior = default_incomplete` cần confirm PaymentIntent phía client;
  app không nhúng Stripe Elements nên sẽ hiện cảnh báo kèm link hosted invoice
  để hoàn tất.
- Đổi `CURRENCY` sau khi đã sync sẽ tạo bộ Price mới (price cũ được archive).
- Subscription chứa Price đã bị gỡ khỏi catalog sẽ được cảnh báo rõ ràng thay vì
  đọc sai âm thầm.

## 8. Lưu ý

- Chỉ dùng **khoá test mode** (`sk_test_…`). App không bao giờ chạm vào dữ liệu
  thẻ thật: thẻ demo dùng payment method token dùng chung của Stripe.
- Test clock chỉ gắn được **lúc tạo customer**, nên hãy bật tuỳ chọn đó khi tạo
  account nếu muốn tua thời gian.
- `billing_mode` chỉ đặt được khi tạo subscription; đổi trong policy chỉ ảnh
  hưởng subscription tạo sau đó.
