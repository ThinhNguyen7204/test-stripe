# Quy tắc tính tiền — bản nghiệp vụ

Bản này mô tả **hành vi thực tế** của hệ thống theo cấu hình đang chạy, viết cho
người không đọc code. Mọi con số trong đây đều đo được từ Stripe test mode, không
phải tính tay.

Phụ lục cuối file ánh xạ từng quy tắc sang ô cấu hình tương ứng, và nói rõ chỗ
nào chỉnh trong app, chỗ nào phải vào dashboard Stripe.

---

> ## 📌 Phạm vi SCIO Portal (MVP)
>
> Khi migrate sang **SCIO Portal**, chỉ mang sang **Standard plan** và **một X
> add-on theo MODEL V6** ($20/tháng hoặc $216/năm, quantity cố định 1), chạy cả
> **tháng và năm**. Tiền của X do Stripe prorate native như mọi item; quota do
> SCIO quản trên quota month cố định theo lịch (mục 10).
>
> Các mục dưới đây đều ghi rõ phần nào **trong** phạm vi MVP, phần nào **ngoài**.
> Bản chi tiết: **[scio-portal-mvp.md](scio-portal-mvp.md)**.
>
> | Trong MVP | Ngoài MVP |
> |---|---|
> | Standard plan | Pro Plus, Engage |
> | X Social (một add-on, quantity 1) | Background Music, Video Wall, Wireless Presentation |
> | Chu kỳ tháng ⇄ năm | Thêm / bớt màn hình |
> | Mua, huỷ, mua lại X, trial X | Lên / hạ gói ở mức plan |

---

## 1. Nguyên tắc xuyên suốt

> **Khách mua thêm thì trả tiền ngay. Khách bớt đi thì tiền ở lại trong tài khoản
> dưới dạng credit, không chảy ngược về thẻ.**

Hai hệ quả:

- Không có khoản nào "ghi nợ để sau trả" — trừ một ngoại lệ là bớt màn hình.
- Không có tiền rời khỏi Stripe trong luồng tự phục vụ. Muốn hoàn về thẻ thì phải
  là thao tác tay của CSKH.

---

## 2. Khách mua thêm

> **MVP:** chỉ còn một đường — **mua X**. Thêm màn hình và lên gói plan không có
> trong portal. Nguyên tắc *thu ngay, thẻ hỏng thì huỷ thao tác, ngày gia hạn
> không đổi* áp nguyên cho X: Stripe prorate từ lúc mua tới billing boundary.
> Riêng quota của X tính theo quota month của SCIO (mục 10).

Áp cho **thêm màn hình**, **lên gói cao hơn**, **mua add-on**.

- Tính theo **số ngày còn lại của kỳ**, không tính nguyên tháng.
- Xuất hoá đơn riêng và **trừ thẻ ngay** khi bấm mua.
- **Ngày gia hạn không đổi.**
- **Thẻ hỏng thì thao tác bị huỷ** — khách không được dùng thứ chưa trả tiền.
- Khi lên gói, phần gói cũ chưa dùng được hoàn trước rồi mới tính gói mới, nên
  khách chỉ trả đúng phần chênh.

| Tình huống đo thật | Thu ngay |
|---|---|
| Engage, 2 → 3 màn hình, còn 20/30 ngày | **$20.00** |
| Standard → Pro Plus, 4 màn hình, còn 20/30 ngày | **$13.33** (hoàn $26.67 + tính $40.00) |
| Mua 2 licence AeriCast, còn 20/30 ngày | **$26.67** |

---

## 3. Khách bớt đi — **không cho giữa kỳ**

> **MVP:** luật chặn này không chạm tới X: **huỷ X** là luồng riêng của MODEL V6
> (mục 10) — xoá item ngay, và chỉ credit phần đã trả nằm sau quotaMonthEnd, nếu có.
> Hạ gói ở mức plan và bớt màn hình đều không tồn tại trong MVP. Cửa chặn giữ lại
> cho giai đoạn sau khi portal mở thêm bậc.

Áp cho **bớt màn hình**, **hạ gói**, **bỏ add-on**.

> Chính sách hiện tại: hệ thống **từ chối** mọi thay đổi khiến công ty phải trả
> lại tiền cho khách giữa kỳ. Khách đã trả tiền cho cả kỳ thì dùng hết kỳ.

Cách hoạt động:

- Trước khi gọi Stripe, hệ thống **tính thử** hoá đơn mà thay đổi đó sẽ tạo ra.
- Nếu số tiền **âm** — tức là phải trả lại khách — thao tác bị **từ chối**, kèm
  thông báo nêu rõ số tiền.
- Vì kiểm tra chạy trên bản tính thử, **không có gì bị thay đổi** khi từ chối:
  gói, số màn hình, add-on, số hoá đơn, credit balance đều nguyên vẹn.
- **Không bao giờ có hoá đơn âm** trong lịch sử.

| Thao tác đo thật (đã dùng 15/30 ngày) | Kết quả |
|---|---|
| Bớt màn hình 4 → 2 | ❌ từ chối — *"would leave 15.00 USD owed back"* |
| Hạ gói Pro Plus → Standard | ❌ từ chối — *"would leave 10.00 USD owed back"* |
| Bỏ 2 add-on về 0 | ❌ từ chối — *"would leave 15.00 USD owed back"* |
| Lên gói Pro Plus → Engage | ✅ thu ngay $30.00 |

### Vậy khách muốn giảm thì làm sao

Hiện tại **không có đường tự phục vụ**. Ba lựa chọn:

1. **Chờ tới ngày gia hạn** rồi tự đổi — lúc đó không còn phần chưa dùng nên
   không phát sinh khoản trả lại.
2. **CSKH can thiệp** — dùng mục *One-off policy override* trên màn hình
   Subscription, đặt riêng cho lần đó `create_prorations` +
   `push_to_account_balance`. Thay đổi được áp và khách nhận credit, chỉ áp dụng
   đúng lần bấm đó, không ảnh hưởng chính sách chung.
3. **Đổi chính sách** cho rule tương ứng sang `end_of_period` — khi đó thay đổi
   được đặt lịch, có hiệu lực đúng ngày gia hạn, không ai phải trả lại gì.

> **Cân nhắc nghiệp vụ:** chặn hoàn toàn nghĩa là khách đang gặp khó khăn tài
> chính không thể tự giảm chi tiêu, phải liên hệ hỗ trợ. Đổi lại, công ty không
> bao giờ phải trả lại tiền giữa kỳ và sổ sách không có hoá đơn âm.

## 4. Đổi chu kỳ thanh toán

> **MVP: trong phạm vi.** X đang ACTIVE thì **cả plan lẫn X cùng nhảy**, Stripe
> prorate native cả hai; SCIO giữ Used và chỉ cộng delta dương nếu thời gian đã
> trả tăng. X đang FROZEN thì chỉ gói nền đổi.

**Tháng → Năm** (khách muốn rẻ hơn 10%)
- Chu kỳ **tính lại từ hôm nay**; ngày gia hạn mới là hôm nay + 1 năm.
- Thu ngay tiền cả năm, **trừ phần tháng chưa dùng**.
- Đo thật: Engage 1 màn hình, mới dùng 1 ngày → thu **$294.00** ($324 − $30).

**Năm → Tháng** (khách muốn giảm cam kết)
- Có hiệu lực **ngay**, không bắt chờ hết năm.
- Phần năm chưa dùng thành **credit**, tháng đầu của gói tháng được tính trong
  cùng lần đó.
- Credit thường đủ nuôi vài tháng tiếp theo.
- Đo thật: Pro Plus 2 màn hình, gói năm $324, đổi sau 2 tháng → credit
  **$240.74**, hoàn về thẻ **$0.00**, hoá đơn tháng kế tiếp **$0.00**.

---

## 5. Huỷ

> **MVP: trong phạm vi.** **Huỷ plan** (hạ về Free) có hiệu lực cuối kỳ đã trả,
> X chạy tới mốc đó rồi kết thúc cùng plan. **Huỷ riêng X** thì khác — có hiệu
> lực **ngay**, xem mục 10.

- Huỷ **vào cuối kỳ đã trả tiền** — khách xài hết những gì đã mua, nên **không có
  gì để hoàn**.
- Huỷ xong tài khoản **rơi về gói Free**, giữ tối đa 3 màn hình, không bị khoá sạch.
- Đổi ý trước ngày hết hạn thì hoàn tác được.
- Có tuỳ chọn huỷ ngay lập tức. Nếu bật thì **phải bật kèm "tính lại phần chưa
  dùng"**, không thì khách vừa mất dịch vụ vừa không được gì — trang Billing
  policy sẽ cảnh báo nếu rơi vào trạng thái này.

---

## 6. Dùng thử

> **MVP: trong phạm vi.** Trial của plan mô tả dưới đây **đã dựng**.
>
> **Trial của X add-on — đã dựng** (MODEL V6 row 50): 14 ngày, 200 Post Updates
> trong ledger riêng, một lần mỗi account, chỉ Manual Refresh, không có Stripe
> item. Xem mục 10.

- **14 ngày**, chỉ cho khách **chưa gắn thẻ**. Ai đã gắn thẻ thì tính tiền ngay
  từ đầu.
- Trong trial mọi thay đổi có hiệu lực ngay nhưng **không thu đồng nào**.
- Hết trial mà chưa có thẻ → **subscription bị huỷ**.
- Có thể **kết thúc trial sớm**: hệ thống chốt luôn và xuất hoá đơn kỳ đầu tiên.
- Người vận hành ép bật/tắt trial cho từng lần tạo được, không phụ thuộc quy tắc chung.

---

## 7. Thu tiền thất bại

- **Lúc mua thêm:** chặn luôn, không cho dùng trước trả sau.
- **Lúc gia hạn:** hoá đơn chuyển sang quá hạn, Stripe tự retry theo lịch cấu hình
  trong dashboard, subscription giữ nguyên. App hiện cảnh báo trên màn hình tài khoản.
- **Lúc giảm quy mô:** không bị chặn, vì không cần charge.
- **Tạm dừng theo mùa:** dừng xuất hoá đơn mà không mất cấu hình, mở lại bất cứ lúc nào.

---

## 8. Hoàn tiền về thẻ (thao tác tay của CSKH)

Đây là con đường **duy nhất** tiền rời khỏi Stripe.

- Chỉ hoàn được hoá đơn **đã thanh toán**.
- Phát hành **credit note** — vừa chỉnh hoá đơn cho đúng sổ sách/thuế, vừa chuyển
  tiền về thẻ.
- **Cửa sổ 30 ngày** kể từ ngày lập hoá đơn; quá hạn bị từ chối, muốn vượt phải
  tick ô ghi đè.
- **Trần tự động duyệt $500**; trên mức đó phải ghi đè thủ công.
- Cho phép hoàn một phần.
- Không hoàn quá số thực còn lại — hệ thống trừ cả phần đã hoàn trước đó.

---

## 9. Ràng buộc hệ thống không cho vi phạm

> **MVP:** ràng buộc quan trọng nhất là **phải có subscription trả phí mới mua
> được add-on**. Gói nền đang trial thì cũng chưa mua được X.

- **Add-on phải có gói trả phí đỡ bên dưới** — ít nhất 1 màn hình. Không có
  subscription thì không mua được add-on nào, kể cả X.
- Gói **Free tối đa 3 màn hình**, **không được dùng add-on**.
- Add-on tính theo màn hình (Background Music, AeriCast) **không được nhiều hơn
  số màn hình**.
- Mỗi gói có số màn hình tối thiểu riêng.
- Cho phép **giảm về 0 màn hình** để tạm dừng theo mùa.

---

## 10. X Social — MODEL V6

> **MVP: đây là phần lõi của portal.** Bản đầy đủ kèm số đo thật:
> **[scio-portal-mvp.md](scio-portal-mvp.md)**. Code: `backend/src/x-addon/`.

Một add-on duy nhất mỗi tenant, **quantity cố định 1**, **$20/tháng hoặc
$216/năm**, 2.000 Post Updates cho mỗi quota month trả đủ. Không còn tier
Standard/Pro và không còn quantity (V6 row 48).

### Hai đồng hồ

- **Tiền là của Stripe**: X là một item thường, cùng subscription / thẻ /
  interval với gói nền, **prorate native**. Không còn phép tính tay theo hạn mức.
- **Quota là của SCIO**: quota month cố định `[ngày 1, ngày 1 tháng sau)` UTC.
  `Granted = floor(2.000 × thời gian đã trả trong tháng / độ dài tháng)`, đọc lại
  từ các dòng X trên hoá đơn **đã paid**, lấy hợp các khoảng — không cấp trùng
  khi đổi interval, chỉ tăng chứ không giảm, không reset Used, không rollover.

### Vòng đời

| | Stripe | SCIO |
|---|---|---|
| Mua | prorate tới billing boundary, thu ngay; thẻ hỏng → không có gì | reservation 2.000 trước khi gọi Stripe; paid → commit + grant |
| Renewal | thu kỳ mới | cộng delta còn thiếu vào cùng ledger |
| Huỷ X | xoá item ngay; nếu `quotaMonthEnd < xPaidThrough` thì credit `quotaMonthEnd → xPaidThrough` vào balance, ngược lại không credit — như nhau cho tháng và năm | FROZEN tới hết quota month, tắt fan-out, trả reservation, giữ FrozenRemaining |
| Mua lại X | không có nút khôi phục; re-add như một lần mua, không thu trùng tới `min(oldPaidThrough, quotaMonthEnd)`, debit lại phần đã credit | trước quotaMonthEnd → khôi phục FrozenRemaining; từ quotaMonthEnd → kích hoạt mới |
| Đổi interval | native cùng gói nền (chỉ khi X ACTIVE) | giữ Used, delta dương nếu có |
| Gói nền về Free / kết thúc | cuối kỳ gói nền | X ENDED cùng gói nền |
| Payment fail | không có coverage mới | qua paidThrough thì dừng fetch; trả được thì cộng delta |

### Trừ quota

Theo số Post X **thực trả về và tính phí**, clamp bởi Remaining, exactly-once
theo `actionId`. Initial / Auto / Manual dùng chung một số dư. Hết quota thì
không gọi provider, không tính overage.

### Mô phỏng trong demo

Khối **X add-on** ở cột trái: status, quota month, Granted / Used / Remaining,
paidThrough, capacity, các nút *Cancel X* / *Buy X again* / *Start 14-day trial*, và
ô **Provider fetch** (chọn Initial/Auto/Manual, nhập *asked* và *returned*) đóng
vai X API. API: `/api/x-addon/:id` và `/api/x-addon/:id/sync-runs`.

Capacity chỉnh ở tab **Billing policy** → Constraints
(`xCommercialCeilingUnits`, `xProviderHardCapUnits`).

---

## Phụ lục A — Ánh xạ sang ô cấu hình

Chỉnh ở tab **Billing policy** trong app. Mọi thay đổi lưu ngay và nhãn preset
chuyển thành `custom`.

| Quy tắc | timing | proration | anchor | payment | credit |
|---|---|---|---|---|---|
| Thêm màn hình | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Lên gói | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Mua add-on | immediate | `always_invoice` | unchanged | `error_if_incomplete` | — |
| Bớt màn hình | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Hạ gói | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Bỏ add-on | immediate | `always_invoice` | unchanged | `error_if_incomplete` | **`block`** |
| Tháng → Năm | immediate | `always_invoice` | **now** | `error_if_incomplete` | — |
| Năm → Tháng | immediate | `always_invoice` | **now** | `error_if_incomplete` | `push_to_account_balance` |

Ngoài các luật chung, còn một tầng **override theo từng add-on** (`addOnRules`,
theo code của add-on). X Social **không** dùng tầng này: mua, huỷ và mua lại của
nó do MODEL V6 chốt cứng trong `backend/src/x-addon/x-addon.service.ts`.

**Bốn cách xử lý khi thay đổi sinh ra khoản phải trả lại khách:**

| Giá trị | Hành vi | Có hoá đơn âm không |
|---|---|---|
| `block` | **đang dùng** — từ chối thao tác, không thay đổi gì | không |
| `push_to_account_balance` | cho đổi, credit hiện ngay trên account balance | tuỳ proration |
| `customer_balance` | cho đổi, credit nằm ẩn dưới dạng điều chỉnh treo | tuỳ proration |
| `refund_to_payment_method` | cho đổi, hoàn tiền thật về thẻ | có thể |

Hoá đơn âm chỉ sinh ra khi `proration_behavior = always_invoice` **và** số tiền
ra âm. Với `block` thì trường hợp đó bị chặn trước, nên không bao giờ xảy ra.
Với `create_prorations` thì Stripe không chốt sổ nên cũng không có hoá đơn nào.

| Nhóm khác | Giá trị hiện tại |
|---|---|
| Huỷ | cuối kỳ · không prorate · về gói Free (không có gì để trả lại) |
| Trial | 14 ngày · chỉ khi chưa có thẻ · hết trial không thẻ thì huỷ |
| Hoá đơn | thu tự động bằng thẻ · engine prorate theo giây · không tính thuế tự động |
| Hoàn tiền | credit note · cửa sổ 30 ngày · trần tự duyệt $500 · cho hoàn một phần |
| Ràng buộc | ép số lượng tối thiểu · **add-on cần gói trả phí** · add-on ≤ màn hình · Free ≤ 3 màn hình · cho về 0 |
| Allowance | X Standard 600 · X Pro 2.000 Monthly Post Updates — sửa được lúc chạy |
| Thu thất bại | để Stripe tự retry · tạm dừng kiểu `void` |

---

## Phụ lục B — Chỉnh ở đâu

### Chỉ chỉnh được trong app này

Những thứ dưới đây là **tham số của từng lời gọi API**, Stripe không có màn hình
nào để set mặc định:

- Prorate hay không, và prorate xong thu ngay hay để dành (`proration_behavior`)
- Áp ngay hay chờ cuối kỳ
- Có reset chu kỳ thanh toán không (`billing_cycle_anchor`)
- Thẻ hỏng thì chặn hay cho qua (`payment_behavior`)
- Credit đi đâu: balance / hoàn thẻ / thu hồi
- Toàn bộ quy tắc trial, cửa sổ hoàn tiền, trần tự duyệt, và mọi ràng buộc gói

### Phải vào dashboard Stripe

| Việc | Vị trí trong dashboard |
|---|---|
| Lịch retry khi thu tiền hỏng, và làm gì sau lần retry cuối | Settings → Billing → Subscriptions and emails |
| Email gửi khách: biên lai, báo thu hỏng, nhắc gia hạn | Settings → Billing → Subscriptions and emails |
| Giao diện hoá đơn: logo, màu, số hiệu, memo, footer | Settings → Billing → Invoices |
| Đăng ký thuế để tính thuế tự động | Settings → Tax |
| Loại phương thức thanh toán chấp nhận | Settings → Payment methods |
| Card updater, thu hồi doanh thu | Settings → Billing → Revenue recovery |

### Cả hai nơi, app ghi đè

| Việc | Ghi chú |
|---|---|
| **Customer Portal** | Dashboard có cấu hình mặc định, nhưng app tạo cấu hình riêng từ billing policy và dùng cấu hình đó. Bấm *Sync portal config* trong app để đẩy sang. |
| **Sản phẩm và bảng giá** | Sửa được trong dashboard, nhưng app là nguồn chân lý — chạy sync sẽ ghi đè tên/mô tả và tạo Price mới nếu giá lệch. Đừng sửa giá trực tiếp trên dashboard. |

### Nằm trong code, không có UI

| Việc | File |
|---|---|
| Bảng giá gốc: gói, giá, add-on, ràng buộc số lượng | `backend/src/catalog/catalog.constants.ts` |
| Giá trị mặc định và 5 preset | `backend/src/policy/policy.presets.ts` |
| Danh sách lựa chọn hiện trên dropdown | `backend/src/policy/policy.fields.ts` |
| Quy tắc phát hiện cấu hình vô hiệu | `backend/src/policy/policy.service.ts` |

Cấu hình đang chạy lưu trong MongoDB, collection `billing_policies`, một document
duy nhất. Sửa trên UI là ghi thẳng vào đó, không cần deploy lại.
