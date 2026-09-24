# SCIO Portal — phạm vi MVP

Bản chi tiết cho đợt migrate sang SCIO Portal. Quy tắc đầy đủ của hệ thống nằm ở
[business-rules.md](business-rules.md); file này chỉ nói **phần nào được mang sang**
và phần đó chạy ra sao.

> **Chốt phạm vi (MODEL V6):** portal bán **Standard plan** và **một X add-on**
> ($20/tháng hoặc $216/năm, **quantity cố định 1**, mỗi tenant tối đa một), chạy
> cả **tháng và năm**. Tiền do **Stripe** quản và prorate native; quota do
> **SCIO** quản trên **quota month cố định theo lịch**. Nguồn: sheet *Suggestion*
> → tab **MODEL V6**.

Mọi con số "đo thật" dưới đây lấy từ `node scripts/verify-x-v6.mjs` chạy trên
Stripe test mode với test clock đặt đúng ngày của ví dụ trong MODEL V6.

---

## 1. Danh mục bán

| Mặt hàng | Tháng | Năm | Quota |
|---|---|---|---|
| **Standard plan** | $10.00 / màn hình | $108 / màn hình / năm | — |
| **X Social** | **$20.00** | **$216.00** ($20 × 12 × 90%) | **2.000 Post Updates** mỗi quota month trả đủ |

Không còn X Social Standard / Pro, không còn tăng giảm quantity (V6 row 48).
Quantity khác 1 bị chặn ở UI, API, và nếu Stripe có lệch thì reconcile tự đưa về
1, ghi cảnh báo, không cấp thêm quota (EASY 5).

---

## 2. Hai đồng hồ độc lập

| | Stripe | SCIO |
|---|---|---|
| Quản cái gì | tiền, hoá đơn, credit, proration, billing anchor | quota month, Granted / Used / Remaining |
| Mốc | ngày billing của subscription (có thể là 05, 20…) | **ngày 1 lúc 00:00 UTC** hằng tháng |
| Nguồn sự thật | invoice preview / invoice đã paid | quota ledger (`x_quota_ledgers`) |

```
GrantedTarget(Q) = floor(2.000 × giây ĐÃ TRẢ TIỀN nằm trong Q / số giây của Q)
Remaining        = max(0, Granted − Used)
```

- "Đã trả tiền" đọc lại từ **các dòng X trên hoá đơn đã `paid`**, lấy **hợp** các
  khoảng. Một khoảng thời gian trả hai lần (tháng rồi đổi sang năm) chỉ tính một
  lần — không bao giờ cấp trùng.
- Granted **chỉ tăng**: renewal, retry thanh toán, đổi interval chỉ cộng delta
  dương, **không reset Used**.
- Qua ngày 1 là ledger mới; phần chưa dùng của tháng cũ **mất**, không rollover.
- Discount / coupon không làm giảm quota: quota theo **thời gian** đã trả, không
  theo số tiền (row 54).

---

## 3. Ràng buộc cứng

1. **Phải có gói nền đã trả tiền.** Gói nền đang Stripe trial thì không mua được
   X. X được thêm vào **subscription đã có**, không gộp vào lúc tạo subscription
   mới (row 51).
2. **X bám interval của gói nền.** Không có trạng thái plan tháng + X năm.
3. **Mua / huỷ / resume X đi riêng**, không gộp với thay đổi khác — mỗi thao tác
   có mốc proration, reservation và cổng thanh toán riêng.
4. **Capacity** (row 17): trước khi gọi Stripe, tenant giữ một reservation 2.000
   (TTL 15 phút). Chỉ bán khi `Committed + Pending + 2.000 ≤ 2.500.000`; paid thì
   commit, fail / hết hạn thì release. 500.000 tới hard cap 3.000.000 là buffer
   không bán. Đổi interval không reserve thêm.

---

## 4. Mua X

Stripe prorate từ lúc mua tới billing boundary, **thu ngay** (`always_invoice`,
`error_if_incomplete`). Thẻ hỏng thì Stripe từ chối: không có item, không quota,
reservation được trả lại. Quota chỉ mở **sau khi hoá đơn paid**.

**Đo thật** — gói nền neo ngày 01, mua X ngày 15/09:

| | |
|---|---|
| Stripe thu | **$10.67** ($20 × 16/30) |
| Quota tháng 9 | floor(2.000 × 16/30) = **1.066** |
| Sang 01/10, renewal paid | ledger mới **2.000**, Used = 0 |

---

## 5. Billing anchor khác quota month

**Đo thật** — mua ngày 10/09 (billing neo ngày 10):

| Thời điểm | Quota |
|---|---|
| 10/09 | tháng 9: floor(2.000 × 21/30) = **1.400** |
| 02/10 (chưa tới renewal) | tháng 10: floor(2.000 × 9/31) = **580**, UI ghi rõ "đã cấp theo thời gian đã thanh toán", không gọi là quota bị mất |
| 10/10 renewal paid | cộng **+1.420** vào **cùng** ledger → 2.000, Used giữ nguyên |
| 10/11 renewal **fail** | tháng 11 chỉ có **600** (01/11 → 10/11); qua 10/11 là PAYMENT_PENDING, không fetch |
| trả được hoá đơn | cộng **+1.400**, ACTIVE lại |

---

## 6. Trừ quota

- Trừ theo số Post X **thực trả về và tính phí**: hỏi 50, X trả 12 → trừ **12**
  (row 12). X trả 0 → trừ 0 (EASY 2).
- Exactly-once theo `actionId`; mọi phép trừ bị **clamp** bởi Remaining.
- Initial / Auto / Manual và tạo Profile Source dùng **chung một số dư**, không
  còn AutoPool / ManualBalance / Daily Hard Cap.
- Remaining = 0 thì **không gọi provider**, không tính overage. Cảnh báo ở 80%
  và 100%.

---

## 7. Huỷ X — có hiệu lực ngay

Xoá X item khỏi subscription **ngay**, tenant **FROZEN** và tắt fan-out; gói nền
không đổi. Granted / Used / Remaining giữ **FROZEN tới hết quota month**.
Capacity reservation được trả lại.

| | Tiền |
|---|---|
| **Monthly** | `proration_behavior=none` — **không hoàn** |
| **Yearly** | `proration_date = quotaMonthEnd` → Stripe credit phần coverage từ quotaMonthEnd tới hết năm vào **customer balance** |

**Đo thật** — X gói năm mua 05/09/2026 (quota tháng 9 = **1.733**), huỷ ngày
20/09: Stripe credit **$200.61** cho 01/10/2026 → 05/09/2027; tháng 9 vẫn 1.733.

---

## 8. Resume

Charge lại từ **`max(bây giờ, hết phần đã trả)`** — không bao giờ thu trùng một
đoạn đã trả, và với gói năm thì debit lại **đúng mốc** đã credit (EASY 1).
Ledger chỉ mở lại **sau khi thanh toán thành công**; thẻ hỏng thì vẫn FROZEN.

| Trường hợp | Kết quả đo được |
|---|---|
| Monthly, huỷ 10/09, resume 15/09 | đã trả tới 01/10 → `proration_behavior=none`, **không có hoá đơn**; mở lại đúng ledger **2.000 / Used 300** |
| Yearly, huỷ 20/09, resume 25/09 | hoá đơn **$200.61** từ 01/10, trả bằng balance (**$0 trừ thẻ**); ledger 1.733 giữ nguyên, coverage liền một năm |
| Monthly, huỷ 20/09, resume **05/10** (qua quotaMonthEnd) | kích hoạt mới: thu **$17.42** (05/10 → 01/11), tháng 10 cấp floor(2.000 × 27/31) = **1.741**, Used 0 |

---

## 9. Đổi interval

- **X đang ACTIVE:** Monthly ⇄ Yearly có hiệu lực ngay sau payment, Stripe prorate
  native **cả gói nền lẫn X**. SCIO giữ quota month và Used, chỉ tăng Granted nếu
  coverage hợp tăng. Đo thật: mua 15/09 (1.066), đổi sang năm ngày 20/09 → vẫn
  **1.066**, không cộng thêm 733.
- **X đang FROZEN:** chỉ gói nền đổi, X không bị charge / credit và vẫn frozen.
  Resume sau đó dùng interval hiện tại của gói nền.

---

## 10. Gói nền hạ về Free / kết thúc

Hạ gói nền về Free là **scheduled downgrade** tại cuối kỳ gói nền đã trả, không
prorate (row 67). X chạy tiếp tới boundary đó, quota tháng cuối chỉ cấp tới
boundary (đo thật: gói neo ngày 10 → tháng 10 được **580**), tới boundary thì X
**ENDED** cùng gói nền và capacity được trả lại (row 55).

---

## 11. Dùng thử

- **Trial của plan** — 14 ngày cho khách chưa gắn thẻ (giữ nguyên).
- **Trial của X** (row 50) — **14 ngày / 200 Post Updates** trong ledger trial
  riêng, **một lần mỗi account**, **chỉ Manual Refresh**, không Stripe item,
  không rollover. Mua X thì trial kết thúc, số dư trial **không** chuyển sang.

---

## 12. Những gì **ngoài** demo billing này

| | Lý do |
|---|---|
| Global Batch Compliance, XAA `post.delete`, compliance lease 24 giờ | phần sync/compliance, không phải billing — demo chỉ giữ cờ fan-out |
| Profile cap 10 / tenant, canonical Source | nằm ở tầng X App, không ở billing |
| Gọi X API thật | provider fetch là ô nhập tay `returned` |
| Pro Plus, Engage, thêm / bớt màn hình, add-on theo đơn vị | vẫn còn trong hệ thống, portal MVP không bán |
