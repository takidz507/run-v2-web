# Run v2 Web (GitHub Pages Static Web App) — Implementation Notes (v2.1.0)

## 1. ملخص ما تم تنفيذه فعلاً في الكود (بصراحة تامة)

بُنيت نسخة الويب من **Run v2** كتطبيق ويب ثابت (HTML/CSS/JS) يعمل مباشرة على **GitHub Pages** بدون أي سيرفر خاص وبدون أي تكلفة، مع التزام كامل بتصميم **Design B** ومطابقة ميزات أندرويد **v2.1.0** وإصلاح مشكلة توافق التشفير مع **Element / Cinny**:

### أ. التصميم (Design B إلزامي) وإخفاء السيرفر
- **عمود واحد نظيف (Telegram-style Single-Column)**: متجاوب يعمل على الهاتف والكمبيوتر (`max-width: 520px` في الوسط على الكمبيوتر، وبملء الشاشة على الهاتف).
- **الألوان المعتمدة**:
  - الوضع الداكن الافتراضي **Warm Night**: خلفية `#171310`، واللون الذهبي الكهرماني `#E8A33D`.
  - الوضع الفاتح **Warm Paper**: خلفية `#FBF6EE`.
- **نص المحادثة صغير (`13.5px`)** ووزن خط عادي مريح للعين كما في النسخ الأولى من Run.
- **تبويبات سفلية ثابتة**: `Rooms` / `Calls` / `Account`.
- **أيقونة Run v2 المعتمدة (`icon-run-v2.svg`)**: حرف `R` ذهبي كهرماني مبسط بطية مخففة على خلفية داكنة `#171310`.
- **إخفاء السيرفر بالكامل**: ثوابت السيرفر (`https://matrix.unredacted.org` والنطاق `unredacted.org`) محصورة داخل `run-config.js` فقط، ولا تظهر كلمة `"Matrix"` أو اسم النطاق في أي شاشة للمستخدم.
- **صفر بيانات وهمية**: لا توجد غرف `Section D` أو `Study group` أو صديق `Amine`. الحساب الجديد يبدأ بقائمة غرف فارغة تماماً حتى تتزامن غرفه الحقيقية من السيرفر.

### ب. التسجيل الكامل من داخل تطبيق الويب نفسه (Multi-Stage UIAA)
- يحتوي نموذج إنشاء الحساب داخل شاشة البداية (`#scr-login`) على الحقول الأربعة المطلوبة:
  1. **اسم المستخدم** (`@username`)
  2. **الاسم الظاهر (اختياري)** (`displayName`)
  3. **كلمة السر** (`password`)
  4. **البريد الإلكتروني** (`email`)
- ينفذ `RunMatrixClient.registerStep` في `matrix-client.js` و`app.js` تدفق **UIAA** الكامل داخل التطبيق نفسه دون تحويل المستخدم إلى Element أو Cinny:
  - **المرحلة 1 (`m.login.recaptcha`)**: يقرأ `public_key` الذي يرجعه السيرفر في استجابة `401`، ويحمّل أداة Google reCAPTCHA الرسمية داخل بطاقة التحقق في التطبيق (`#uiaaRecaptchaWidget`)، وعند حلها يرسل تلقائياً `{ type: "m.login.recaptcha", session, response }` إلى `/_matrix/client/v3/register`.
  - **المرحلة 2 (`m.login.email.identity`)**: يولّد `client_secret` ويستدعي `POST /_matrix/client/v3/register/email/requestToken` لإرسال رسالة التحقق إلى البريد الإلكتروني للمستخدم، ويحفظ `sid`، ويتيح للمستخدم إدخال رمز التحقق (إن وجد) أو الضغط على رابط التأكيد في بريده ثم الضغط على زر **«تأكيد البريد وإكمال التسجيل»** الذي يرسل `{ type: "m.login.email.identity", session, threepid_creds: { sid, client_secret }, threepidCreds: { sid, client_secret } }` لإتمام التسجيل مباشرة داخل Run Web.
  - **المراحل الإضافية (`m.login.terms` / `m.login.dummy`)**: مدعومة تلقائياً إذا طلبها السيرفر.
- **رسائل الخطأ الصادقة (`mapErrorToArabic`)**:
  - إذا أرجع السيرفر `403 M_FORBIDDEN` مع `"Registration has been disabled"` يعرض: **`"التسجيل مغلق على هذا السيرفر"`**.
  - إذا كان الاسم محجوزاً (`M_USER_IN_USE`) يعرض: **`"اسم المستخدم هذا محجوز بالفعل، اختر اسمًا آخر"`**.
  - إذا لم يكتمل تأكيد البريد بعد (`M_UNAUTHORIZED` / `M_THREEPID_AUTH_FAILED`) يوضح للمستخدم أنه بانتظار الضغط على رابط التأكيد في البريد.

### ج. إصلاح التشفير الحقيقي (Olm/Megolm) للتوافق التام مع Element وCinny
في `crypto-engine.js` و`matrix-client.js` تم تشخيص وإصلاح الأسباب التي منعت فك تشفير رسائل Run في Element/Cinny في نسخة الأندرويد 2.1.0:
1. **استخدام مكتبة التشفير الرسمية المعتمدة فقط**:
   - يعتمد التطبيق على مكتبة Matrix الرسمية `@matrix-org/olm@3.2.15` (`olm.js` + `olm.wasm`) مع تحميل `@matrix-org/matrix-sdk-crypto-wasm` عند توفره، بدون أي تشفير AES مخصص للرسائل.
2. **إصلاح Canonical JSON לתواقيع Ed25519 (السبب الجذري لفشل التحقق في أندرويد)**:
   - في أندرويد، كانت `JSONObject.quote` تحوّل المحرف `/` داخل مفاتيح Base64 إلى `\/`، مما يكسر التحقق من توقيع `ed25519` لأجهزة Element ويرفضها. في `crypto-engine.js` تم تنفيذ `toCanonicalJson` المطابق لمواصفة Matrix RFC-8785 بدون تهريب `/` إطلاقاً.
3. **مشاركة مفتاح Megolm مع جميع أجهزة الأعضاء (الموثقة وغير الموثقة)**:
   - عند إرسال رسالة في غرفة مشفرة، يجلب `shareMegolmKeyWithAllRoomDevices` في `matrix-client.js` جميع أعضاء الغرفة (`join` و`invite`)، ويستعلم عن أجهزتهم عبر `/_matrix/client/v3/keys/query`، ويطالب بمفاتيح `signed_curve25519` عبر `/_matrix/client/v3/keys/claim`، ويرسل حدث `m.room_key` مشفراً عبر Olm (`PUT /_matrix/client/v3/sendToDevice/m.room.encrypted/{txnId}`) إلى **جميع أجهزة الأعضاء بدون استثناء** (وليس الأجهزة الموثقة يدوياً فقط).
4. **الرد التلقائي على طلبات المفاتيح الواردة (`m.room_key_request`)**:
   - يفحص `processIncomingToDeviceEvents` في `crypto-engine.js` كلاً من أحداث `m.room_key_request` الصريحة والمشفرة عبر Olm.
   - عندما يطلب أي عميل (Element أو Cinny أو Run) مفتاح جلسة (`action === "request"`)، يقوم `answerIncomingRoomKeyRequests` في `matrix-client.js` بتصدير الجلسة عبر `inboundSession.export_session(first_known_index)` وإرسالها فوراً كحدث `m.forwarded_room_key` مشفر عبر Olm إلى الجهاز الطالب.
   - كما يرسل Run Web تلقائياً طلب `m.room_key_request` عندما يصادف رسالة مشفرة لا يملك مفتاح جلستها، ويعيد فك تشفير الرسالة تلقائياً فور وصول المفتاح في `/sync`.
5. **إعادة مشاركة المفتاح عند انضمام عضو جديد أو بعد توثيق جهاز**:
   - عند وصول حدث `m.room.member` (`join` أو `invite`) في `/sync` أو تغير `device_lists.changed`، يقوم التطبيق تلقائياً بمشاركة مفتاح Megolm مع العضو/الجهاز الجديد.
   - عند الضغط على زر **«توثيق الجهاز»** في شاشة تفاصيل الغرفة (`#scr-roominfo`)، يوثق التطبيق الجهاز ويعيد فوراً إرسال مفتاح Megolm للغرفة إلى ذلك الجهاز، بالإضافة إلى توفير زر يدوي **«إعادة مشاركة مفتاح Megolm مع جميع أجهزة الغرفة الآن»**.
6. **تفعيل التشفير افتراضياً والواجهة الصادقة**:
   - الغرف الجماعية والمحادثات الخاصة الجديدة تُنشأ مع حدث الحالة `m.room.encryption` (`algorithm: "m.megolm.v1.aes-sha2"`).
   - إذا كانت الغرفة غير مشفرة، تعرض الواجهة بوضوح شارة **`غير مشفرة`** وشريط **`⚠️ غير مشفرة — الرسائل في هذه الغرفة غير مشفرة`**، ولا تدّعي أبداً أنها مشفرة.

### د. النسخة الاحتياطية برمز PIN (6 أرقام) والمكالمات (WebRTC 1-to-1)
- **نسخة المفاتيح الاحتياطية برمز PIN**: تصدّر جميع جلسات Megolm (`export_session`) وتشفرها عبر Web Crypto API (`PBKDF2-HMAC-SHA256` بـ 120,000 دورة + `AES-256-GCM`) وترفعها إلى Account Data (`m.runv2.key_backup.v2`)، وتسترجعها عند إدخال رمز PIN على جهاز/متصفح جديد.
- **مكالمات الفيديو والصوت 1-to-1 (`webrtc-call.js`)**: تستخدم `navigator.mediaDevices.getUserMedia` و`RTCPeerConnection` الحقيقيين في المتصفح، وتدعم الجودة الافتراضية `480p` ووضع توفير البيانات `240p` ووضع `صوت فقط`، وتفحص `/_matrix/client/v3/voip/turnServer` بعد الدخول وتعرض تنبيهاً صادقاً إذا لم يوفر السيرفر عناوين TURN.

---

## 2. ما لم يُختبر حياً بعد (بصراحة تامة)

بما أن بيئة البناء الحالية معزولة عن الإنترنت الخارجي (Sandbox بدون وصول للشبكة الخارجية):
1. **لم يتم إجراء تسجيل حساب حي أو دخول حي من داخل هذه البيئة على `https://matrix.unredacted.org`**:
   - تحميل أداة Google reCAPTCHA (`https://www.google.com/recaptcha/api.js`) ومكتبة `@matrix-org/olm` (`https://cdn.jsdelivr.net/npm/@matrix-org/olm@3.2.15/olm.js`) يتم في متصفح المستخدم عند فتح الصفحة المستضافة على GitHub Pages.
   - ملاحظة مهمة لـ reCAPTCHA على الدومينات المستضافة: إذا كان مفتاح Google reCAPTCHA الخاص بسيرفر `matrix.unredacted.org` مقيداً في إعدادات Google بنطاق `unredacted.org` فقط، فقد تعرض أداة Google reCAPTCHA رسالة خطأ نطاق (`Invalid domain for site key`) عند فتحها من نطاق `github.io`. الكود يعرض الأداة الحقيقية مباشرة كما يرسلها السيرفر ويبلغ بصراحة عن أي خطأ يرجعه السيرفر.
2. **لم يتم إجراء اختبار حي متبادل (Live Cross-Client E2EE Test) بين متصفح يشغل Run Web ومتصفح/هاتف يشغل Element أو Cinny على `unredacted.org` بعد**:
   - يحتاج الكود إلى رفعه أو فتحه في متصفح متصل بالإنترنت وتجربة إرسال واستقبال رسائل مشفرة بين حسابين حقيقيين على **Run Web** و**Element / Cinny**، وتجربة مكالمة WebRTC بين متصفحين/جهازين.
