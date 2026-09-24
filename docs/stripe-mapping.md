# Billing policy → tham số Stripe

Toàn bộ "cơ chế" của app nằm trong một document duy nhất trong MongoDB
(`billing_policies`, key = `active`). Mỗi field ánh xạ thẳng sang một tham số
Stripe. Sửa policy = đổi hành vi thật của Stripe, không phải đổi phép tính nội
bộ của app.

## 1. Change rules

App phân loại mọi thay đổi vào đúng **một** rule, theo thứ tự ưu tiên:
`term → plan → screens → add-ons` (xem `subscription.util.ts:classifyChange`).

| Rule key | Khi nào |
|---|---|
| `screensIncrease` / `screensDecrease` | đổi số màn hình |
| `planUpgrade` / `planDowngrade` | đổi tier (so sánh `tierRank`) |
| `addOnIncrease` / `addOnDecrease` | đổi add-on |

Mặc định **cả ba rule "mua thêm"** — `screensIncrease`, `planUpgrade`,
`addOnIncrease` — đều dùng `always_invoice` + `error_if_incomplete`: khách mua
thêm thì **trả tiền ngay**, thẻ fail thì thay đổi bị huỷ.

Đối xứng với nó, **cả ba rule "bớt đi"** — `screensDecrease`, `planDowngrade`,
`addOnDecrease` — dùng `create_prorations` + `push_to_account_balance`: phần chưa
dùng thành account credit nhìn thấy được, không có tiền rời khỏi Stripe.

Ví dụ thêm màn hình (Engage, 2 → 3 màn hình, còn 20/30 ngày): hoá đơn
`subscription_update` **$20.00** = $30 × 20/30 cho màn hình thứ ba, thu ngay,
ngày gia hạn không đổi, hoá đơn kỳ sau sạch không còn khoản treo.

Ví dụ lên gói giữa kỳ (Standard → Pro Plus, 4 màn hình, còn 20/30 ngày):
Stripe xuất một hoá đơn `subscription_update` gồm `−$26.67` hoàn phần Standard
chưa dùng và `+$40.00` phần Pro Plus còn lại → **thu $13.33**, tức đúng phần
chênh lệch cho số ngày còn lại. Ngày gia hạn không đổi, không còn khoản nào treo
sang kỳ sau. Thẻ fail thì gói giữ nguyên, khách không được dùng tier cao hơn.

Mua
add-on là **thu tiền ngay** (phần prorate cho số ngày còn lại của kỳ), không treo
sang hoá đơn sau, và nếu thẻ bị từ chối thì thay đổi bị huỷ — khách không được
dùng add-on miễn phí. Ngày gia hạn giữ nguyên vì `billing_cycle_anchor` vẫn là
`unchanged`.

Lưu ý: `always_invoice` quét **mọi** proration đang treo trên subscription, nên
nếu trước đó khách đã thêm màn hình theo `create_prorations` thì khoản đó cũng
bị thu cùng lúc.
| `termToYearly` / `termToMonthly` | đổi chu kỳ |

Mỗi rule có 5 nút vặn:

| Field | Tham số Stripe | Ý nghĩa |
|---|---|---|
| `timing` | `subscriptions.update` vs `subscriptionSchedules.update` | áp ngay, hay chờ cuối kỳ |
| `prorationBehavior` | `proration_behavior` | `create_prorations` (dồn hoá đơn sau) / `always_invoice` (xuất hoá đơn ngay) / `none` |
| `billingCycleAnchor` | `billing_cycle_anchor` | `unchanged` giữ ngày gia hạn, `now` reset chu kỳ và thu trọn kỳ mới |
| `paymentBehavior` | `payment_behavior` | `error_if_incomplete` chặn thay đổi nếu thẻ fail, `default_incomplete` chờ 3DS, ... |
| `creditHandling` | (logic của app) | credit sinh ra đi đâu: để trên **customer balance**, **refund về thẻ**, hay **thu hồi** |

### Credit nằm ở đâu — và app đo nó bằng cách nào

Đây là chỗ dễ sai nhất. Tuỳ `proration_behavior`, credit của khách nằm ở hai
nơi hoàn toàn khác nhau:

- `create_prorations` → credit là **pending invoice item âm** treo trên
  subscription, chờ hoá đơn kỳ sau quét vào. `customer.balance` **không đổi**.
- `always_invoice` → Stripe xuất hoá đơn ngay; nếu net âm thì phần dư rơi vào
  **customer balance** (`ending_balance` âm).

Vì vậy đo credit bằng cách so `customer.balance` trước/sau là **không đủ** — với
preset mặc định (create_prorations) luôn ra 0. App đo bằng chính Stripe: preview
hoá đơn sắp tới hai lần — một lần nguyên trạng, một lần "giả sử đã đổi" — rồi
lấy hiệu của tổng các dòng proration:

```
prorationsBefore = Σ(proration lines của upcoming invoice hiện tại)
prorationsAfter  = Σ(proration lines khi preview kèm items mới)
credit           = max(0, prorationsBefore − prorationsAfter)
```

`proration_date` được ghim cho cả preview lẫn lần update thật để hai bên tính ra
đúng cùng một con số.

**Gộp hay ròng — chọn đúng con số mới không hoàn dư.** Số dùng để hoàn tiền phụ
thuộc vào `proration_behavior`:

| proration_behavior | Credit nằm đâu | App dùng số nào |
|---|---|---|
| `create_prorations` | pending invoice item âm, balance không đổi | hiệu tổng dòng proration (**gộp**) |
| `always_invoice` | Stripe đã chốt hoá đơn — trong đó có cả kỳ mới bị tính tiền và mọi proration còn treo | biến động **customer balance** (**ròng**) |

Lấy `max` của hai tín hiệu là sai: với `always_invoice`, credit gộp $270.74 trong
khi hoá đơn cũng thu $30.00 cho kỳ mới, nên chỉ $240.74 thực sự còn dư. Hoàn
$270.74 là tặng không khách một tháng — và nếu còn cộng thêm bút toán bù trừ nữa
thì khách hoá ra đang **nợ** tiền.

Sau khi biết credit là bao nhiêu:

- `customer_balance` → để nguyên chỗ Stripe đặt. Với `always_invoice` đó là
  account balance; với `create_prorations` nó chỉ là một dòng âm treo trên hoá
  đơn kế tiếp, **`customer.balance` vẫn bằng 0**.
- `push_to_account_balance` → luôn kết thúc dưới dạng account credit nhìn thấy
  được. Nếu proration còn đang treo, app tạo một invoice item dương bằng đúng số
  đó để hoá đơn kế tiếp không bị trừ hai lần, rồi ghi `customer.balance` âm.
  Số tiền khách phải trả không đổi, chỉ khác chỗ nó hiển thị.
- `refund_to_payment_method` → `refunds.create` trên PaymentIntent của các hoá
  đơn đã trả gần nhất (hoàn tối đa bằng phần còn refund được), rồi ghi một
  balance transaction **dương** đúng bằng số đã hoàn. Bước ghi ngược này bắt
  buộc: tiền đã về thẻ thì pending proration âm không được phép trừ tiếp vào hoá
  đơn kỳ sau nữa.
- `none` → ghi balance transaction dương để xoá credit.

## 2. `timing: end_of_period` hoạt động thế nào

App tạo (hoặc tái dùng) một **subscription schedule** từ subscription hiện tại,
giữ nguyên các phase đang chạy và nối thêm một phase mới với cấu hình mong muốn,
`proration_behavior: 'none'`, `end_behavior: 'release'`. Subscription giữ nguyên
cho tới hết kỳ đã trả tiền rồi tự chuyển sang phase mới.

Khi có thay đổi `immediate` xảy ra trong lúc đang có schedule, app **release**
schedule trước để hai cơ chế không đánh nhau.

## 2b. Ví dụ đọc kỹ: yearly → monthly

Đây là thay đổi dễ gây tranh cãi nhất nên đáng nêu riêng.

**Mặc định (`termToMonthly`: immediate / always_invoice / anchor now / push_to_account_balance)**

1. `classifyChange` thấy term đổi → ruleKey `termToMonthly` (term có ưu tiên cao
   nhất, trên plan/screens/add-on).
2. `subscriptions.update` với `billing_cycle_anchor: 'now'` → chu kỳ khởi động
   lại ngay hôm nay, Stripe xuất một hoá đơn `subscription_update` gồm: phần năm
   **chưa dùng** (âm) cộng **tháng monthly đầu tiên** (dương).
3. Phần âm còn dư sau khi bù trừ rơi vào `customer.balance` — **tiền không rời
   khỏi Stripe**, không có refund nào về thẻ.
4. Các hoá đơn monthly kế tiếp tự tiêu credit đó cho tới khi hết.

Số thật đo được (Pro Plus, 2 màn hình, đổi sau 2/12 tháng):

| | |
|---|---|
| Đã thu cho năm | $324.00 (2 × $13.50 × 12) |
| Credit **gộp** phần năm chưa dùng | $270.74 |
| Tháng monthly đầu bị tính | $30.00 |
| Credit **ròng** → account balance | **−$240.74** |
| Refund về thẻ | **$0.00** |
| Hoá đơn monthly kế tiếp | $0.00 (`starting_balance` tự trừ) |

Muốn tiền chạy về thẻ thật thì đổi `creditHandling` của rule đó sang
`refund_to_payment_method` — preset `customer_friendly` đã set sẵn như vậy.

**Preset `annual_commitment` (end_of_period / none / không hoàn)**

Cùng thao tác nhưng không đụng subscription đang chạy: app tạo subscription
schedule, nối một phase monthly (`duration: 1 month`, `end_behavior: release`),
`pendingChange.effectiveAt` = ngày hết kỳ năm. Không thu thêm, không hoàn đồng
nào, số hoá đơn giữ nguyên. Tới ngày đó Stripe kích hoạt phase monthly và xuất
hoá đơn $30.00.

**Lưu ý về preview.** Với thay đổi `end_of_period`, app preview bằng
`preview_mode: 'recurring'` để lấy một kỳ đầy đủ ở cấu hình mới. Stripe vẫn định
giá nó dựa trên kỳ hiện tại nên **ngày trên từng dòng là khung tham chiếu của
Stripe, không phải ngày hiệu lực thật** — UI ẩn các ngày đó và chỉ hiện
`effectiveAt` lấy từ `current_period_end`.

**Lưu ý về test clock.** Khi đã có phase monthly nằm trong schedule, Stripe chỉ
cho tua tối đa 2 tháng mỗi lần (giới hạn theo chu kỳ ngắn nhất trên clock). Vì
vậy `simulator.advance` tự chia thành nhiều chặng, dùng đúng mốc trần Stripe báo
về, và ghi số chặng vào audit log.

## 2c. Nút vặn vô hiệu

`GET /api/policy` trả kèm `warnings[]`, và tab Billing policy hiện chúng ở khối
"Settings that cannot fire". Đây không phải lỗi — chỉ là những tổ hợp mà một ô
trông như đang bật nhưng không bao giờ chạy tới:

- `cancellation.refundUnusedTime` khác `none` trong khi `prorateUnusedTime` tắt
  và `timing = immediate` → huỷ ngay sẽ cắt dịch vụ mà **không trả lại gì**.
- `prorateUnusedTime` bật trong khi `timing = at_period_end` → không có thời
  gian nào chưa dùng để prorate.
- rule có `prorationBehavior = none` nhưng `creditHandling` khác `none` → không
  có credit nào được tạo để mà xử lý.
- rule có `timing = end_of_period` nhưng đặt `prorationBehavior` /
  `billingCycleAnchor` → phase mới bắt đầu sạch ở kỳ gia hạn, hai ô đó bị bỏ qua.
- `trial.requirePaymentMethod` bật trong khi `appliesTo = never`.

Cả 5 preset dựng sẵn đều cho 0 cảnh báo.

## 2d. X Social (MODEL V6): tiền native, quota riêng

X là một item thường trên subscription, nên **Stripe tính tiền theo thời gian như
mọi item** — không còn nhánh tự dựng dòng tiền theo hạn mức. MODEL V6 chỉ chốt
cứng tham số của ba thao tác (code: `backend/src/x-addon/x-addon.service.ts`):

| Thao tác | `subscriptions.update` |
|---|---|
| Mua | `items: [{price, quantity: 1}]`, `proration_behavior: always_invoice`, `proration_date: now`, `payment_behavior: error_if_incomplete` |
| Huỷ — Monthly | `items: [{id, deleted: true}]`, `proration_behavior: none` |
| Huỷ — Yearly | `items: [{id, deleted: true}]`, `proration_behavior: always_invoice`, **`proration_date: quotaMonthEnd`** |
| Resume | `items: [{price, quantity: 1}]`; nếu `max(now, hết phần đã trả)` < cuối kỳ thì `always_invoice` + `proration_date` = mốc đó + `error_if_incomplete`, ngược lại `none` |
| Đổi interval | không có luật riêng: item X đổi price cùng gói nền theo rule `termToYearly` / `termToMonthly` |

Đo được trên test mode (X năm $216 mua 05/09/2026, huỷ 20/09):

- Stripe **chấp nhận `proration_date` ở tương lai** trên item, miễn là nằm trong
  kỳ hiện tại: hoá đơn huỷ có đúng một dòng `−$200.61` kỳ `2026-10-01 →
  2027-09-05`, tự `paid`, ghi vào customer balance. Việc xoá item thì vẫn xảy ra
  **ngay**.
- Resume với cùng `proration_date` tạo dòng `+$200.61` đúng kỳ đó; hoá đơn trả
  bằng balance nên `amount_due = $0`.

**Quota không đọc từ Stripe mà suy ra từ Stripe**: SCIO replay các dòng X trên
mọi hoá đơn `status = paid` theo thứ tự tạo (trong cùng một hoá đơn, dòng âm
trước, dòng dương sau), lấy hợp các kỳ thành *paid coverage*, rồi
`Granted = floor(2.000 × coverage ∩ quota month / quota month)`. Replay nên
idempotent: webhook `invoice.paid` tới hai lần, hay đọc state mỗi lần mở trang,
đều ra cùng một kết quả.

## 3. Cancellation

| Field | Stripe |
|---|---|
| `timing: at_period_end` | `subscriptions.update({ cancel_at_period_end: true })` |
| `timing: immediate` | `subscriptions.cancel({ prorate, invoice_now })` |
| `prorateUnusedTime` | `prorate` |
| `invoiceImmediately` | `invoice_now` |
| `refundUnusedTime` | như `creditHandling` ở trên |
| `moveToFreePlan` | trạng thái nội bộ: về gói Free (3 màn hình) |

## 4. Trial

| Field | Stripe / tác dụng |
|---|---|
| `appliesTo` | quyết định có gắn `trial_period_days` hay không: `only_without_payment_method` (mặc định, giống OptiSigns), `always`, `never` |
| `days` | `trial_period_days` |
| `requirePaymentMethod` | từ chối mở trial nếu chưa có thẻ (lỗi 400 kèm lý do) |
| `missingPaymentMethodBehavior` | `trial_settings.end_behavior.missing_payment_method` |

Mỗi request `change` còn nhận `withTrial: true/false` để ghi đè policy cho đúng
lần đó; UI hiện thành checkbox "Start this subscription with a trial".
`POST /api/subscriptions/:id/end-trial` gửi `trial_end: 'now'` để kết thúc trial
ngay và xuất hoá đơn kỳ đầu.

Lưu ý một hành vi của Stripe: nếu subscription đang `trialing`, **chưa có thẻ**
và `missing_payment_method = cancel`, Stripe **từ chối** preview hoá đơn sắp tới
(vì sẽ không có hoá đơn nào — trial hết là huỷ). App bắt trường hợp này và trả
về lời giải thích thay vì lỗi.

## 5. Invoicing

| Field | Stripe |
|---|---|
| `collectionMethod` | `collection_method` |
| `daysUntilDue` | `days_until_due` (chỉ với `send_invoice`) |
| `billingMode` | `billing_mode.type` — `flexible` (mặc định mới, prorate theo giây) hoặc `classic` |
| `automaticTax` | `automatic_tax.enabled` |
| `defaultPaymentBehavior` | `payment_behavior` lúc tạo subscription |
| `anchorToFirstOfMonth` | `billing_cycle_anchor_config.day_of_month = 1` |

`billing_mode` chỉ set được lúc tạo subscription, không đổi được sau đó.

## 6. Refunds

| Field | Tác dụng |
|---|---|
| `windowDays` | quá hạn thì API từ chối, trừ khi gửi `force: true` |
| `mode: credit_note` | `creditNotes.create({ invoice, amount, refund_amount })` — vừa điều chỉnh hoá đơn (đúng cho thuế/kế toán) vừa hoàn tiền |
| `mode: refund` | `refunds.create({ payment_intent, amount })` — chỉ chuyển tiền, hoá đơn giữ nguyên |
| `allowPartial` | bắt buộc hoàn toàn phần hay cho phép một phần |
| `maxAutoApproveCents` | trần tự động duyệt, vượt trần phải `force: true` |

## 7. Dunning

`invoice.payment_failed` đến qua webhook. Tuỳ `pastDueBehavior`, app để Stripe
retry theo Smart Retries (`leave_past_due`), hoặc `subscriptions.cancel`, hoặc
set `pause_collection` với `pauseBehavior` (`void` / `keep_as_draft` /
`mark_uncollectible`).

## 8. Customer Portal

`POST /api/billing/portal/configuration` dựng một
`billingPortal.configurations` từ policy hiện hành: `subscription_update.
proration_behavior` lấy từ rule `screensIncrease`, `subscription_cancel.mode`
lấy từ `cancellation.timing`. Nhờ vậy khách tự thao tác trong portal của Stripe
vẫn chịu đúng luật như thao tác qua app.

## 9. Thời gian: luôn hỏi test clock, đừng hỏi đồng hồ máy

Account gắn test clock sống trong thời gian mô phỏng. Dùng `Date.now()` cho họ
sẽ hỏng âm thầm ở ba chỗ: `proration_date` tính từ sai mốc (prorate ra nguyên
tháng thay vì phần còn lại), cửa sổ refund không bao giờ hết hạn, và phase của
subscription schedule bị hiểu nhầm là "tương lai". Vì vậy mọi mốc thời gian đều
đi qua `StripeService.nowFor(testClockId)`.

## 10. Test clock

Customer được tạo kèm `test_clock`. `POST /api/simulator/:id/advance` gọi
`testHelpers.testClocks.advance` rồi chờ tới khi `status = ready`. Stripe chạy
thật toàn bộ engine: xuất hoá đơn gia hạn, quét proration tồn đọng, kích hoạt
phase đã schedule, bắt đầu dunning nếu thẻ fail.

## 10b. Đọc hỏng không được coi là "không tồn tại"

`change()` quyết định tạo subscription mới dựa vào việc đọc subscription hiện
tại trả về `null`. Nên một lần đọc **thất bại** (timeout, rate limit, 5xx) mà bị
nuốt thành `null` sẽ khiến app lặng lẽ tạo subscription thứ hai — khách bị tính
tiền hai lần, chỉ để lại một dòng WARN.

Quy tắc: chỉ `resource_missing` / HTTP 404 mới là "không còn"; mọi lỗi khác ném
`ServiceUnavailableException` kèm thông điệp *nothing was changed — retry in a
moment*. Stripe client cũng bật `maxNetworkRetries: 3` và `timeout: 40000` để lỗi
mạng thoáng qua tự được retry.

## 11. Những chỗ Stripe API đã đổi (bản 2026-08-26.dahlia)

- `current_period_start/end` **không còn** trên object Subscription — nằm trên
  từng subscription item (`StripeService.periodEnd`).
- Preview hoá đơn dùng `invoices.createPreview({ subscription_details })`,
  không còn `invoices.retrieveUpcoming`.
- Line item không còn cờ `proration` ở cấp cao nhất; nó nằm ở
  `line.parent.subscription_item_details.proration`.
- PaymentIntent của hoá đơn lấy qua `invoice.payments` (cần `expand`).
- Phase của subscription schedule **không còn** `iterations`; thay bằng
  `duration: { interval, interval_count }` (hoặc `end_date`).
- Không được gửi `proration_date` cùng lúc với `billing_cycle_anchor: 'now'` —
  Stripe trả lỗi 400; việc dời anchor chính là mốc prorate.
