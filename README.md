# Run v2 — نسخة الويب (Web v2.3.2)

تطبيق ويب ثابت (Static Web App — HTML/CSS/JS) مطابق لنسخة الأندرويد **Run v2.3.2** ولتصميم **Design B**، جاهز للاستضافة مجاناً على **GitHub Pages** بدون أي سيرفر خاص وبدون أي تكلفة.

## محتويات المشروع

- `index.html` — واجهة التطبيق الكاملة بتصميم Design B (الوضع الداكن `Warm Night` `#171310` + `#E8A33D` والوضع الفاتح `Warm Paper` `#FBF6EE`).
- `styles.css` — تنسيقات العمود الواحد المتجاوبة للهاتف والكمبيوتر مع خط المحادثة الصغير (`13.5px`).
- `run-config.js` — إعدادات السيرفر المخفية داخلياً (`https://matrix.unredacted.org` / `unredacted.org`) ودوال تحويل المعرفات (`@username`) وأكواد الغرف (`run://join/<code>`).
- `crypto-engine.js` — محرك التشفير القياسي من الطرف إلى الطرف (**Olm/Megolm**) المبني على مكتبة Matrix الرسمية (`@matrix-org/olm` WebAssembly + `@matrix-org/matrix-sdk-crypto-wasm`) والنسخة الاحتياطية المحمية برمز PIN من 6 أرقام (`PBKDF2-HMAC-SHA256` + `AES-256-GCM`).
- `matrix-client.js` — عميل الشبكة الكامل (الدخول، التسجيل متعدد المراحل داخل التطبيق `UIAA`: `reCAPTCHA` + `m.login.email.identity`، المزامنة `/sync`، تبادل مفاتيح Megolm مع جميع أجهزة الأعضاء والرد التلقائي على `m.room_key_request`، البحث عن الأصدقاء والغرف العامة، وإشارات المكالمات).
- `webrtc-call.js` — محرك مكالمات الصوت والفيديو الفردية (1-to-1 WebRTC) بجودة `480p` افتراضياً ووضع توفير البيانات `240p` وفحص TURN عبر `/v3/voip/turnServer`.
- `app.js` — ربط حالة الواجهة بجميع العمليات الحقيقية على السيرفر.
- `icon-run-v2.svg` و `manifest.json` و `.nojekyll` — ملفات الأيقونة المعتمدة والاستضافة على GitHub Pages.
- `IMPLEMENTATION-NOTES.md` — توثيق تقني مفصل وصادق لما تم تنفيذه وما لم يُختبر حياً بعد.
