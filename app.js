/**
 * Run v2 Web (v2.3.2) — Main UI Controller & State Loop.
 *
 * Fixes implemented in v2.3.2:
 * 1. Bug 1 Fix (Sync failing on slow mobile data 12–30 KB/s):
 *    - Splits initial load into a lightweight first pass (`syncFirstPassLight`: `timeline.limit: 1`,
 *      `lazy_load_members: true`, `presence.types: []`, plus `/joined_rooms` minimal fallback) so
 *      the rooms list renders and saves to `localStorage` within seconds even when the account is in
 *      9,000-member public rooms (`Unredacted Space`).
 *    - Follows immediately with a filtered timeline sync (`timeline.limit: 10`, `lazy_load_members: true`)
 *      and progressive lazy member loading (`lazyLoadRoomMembersForSmallRooms`).
 *    - Persists `sinceToken` in `localStorage` so page reloads resume incremental sync directly.
 *    - Implements exponential backoff (`3.5s -> 7s -> 15s`) on sync errors while keeping the
 *      immediate «إعادة المحاولة» button and loading/error indicators from v2.3.1.
 * 2. Bug 2 Fix (Responsive layout for Mobile <=540px, Tablet 541–1023px, Desktop >=1024px):
 *    - Mobile (`<=540px`): Single-column layout unchanged (`13.5px` chat font).
 *    - Tablet (`541–1023px`): Wider single-column layout (`max-width: 720px`).
 *    - Desktop (`>=1024px`): Full-width two-pane layout (`336px` left sidebar for Rooms/Search/Calls/Account
 *      + `1fr` right conversation pane for Chat/RoomInfo/Call) with zero wasted side margins.
 */
(function () {
  var BACKOFF_DELAYS_MS = [3500, 7000, 15000];

  var state = {
    currentScreen: "login",
    sidebarScreen: "rooms",
    mainPaneScreen: "chat",
    authMode: "login",
    theme: "dark",
    callQuality: "DEFAULT_480P",
    account: null,
    // Strictly empty by default: populated from localStorage cache on login/reload, then updated by /sync
    rooms: [],
    initialSyncCompleted: false,
    isSyncInProgress: false,
    syncError: null,
    syncRetryDelaySec: 3.5,
    spaceFilter: "ALL",
    activeRoom: null,
    messagesByRoom: {},
    activeRoomMembers: [],
    activeRoomDevices: [],
    // Search & Friends
    searchTab: "FRIENDS",
    searchQuery: "",
    friendSearchResults: [],
    publicRoomResults: [],
    incomingFriendInvites: [],
    outgoingFriendInvites: [],
    friends: [],
    // Create Group Room
    pickedCreateMembers: {},
    createMemberCandidates: [],
    // PIN Screen state
    pinMode: "create",
    pinFirstEntry: "",
    pinCurrentValue: "",
    // Multi-Stage UIAA Registration state
    uiaa: {
      active: false,
      session: "",
      selectedStages: [],
      completed: [],
      nextStage: "",
      params: {},
      clientSecret: "",
      emailSid: "",
      emailSubmitUrl: "",
      sendAttempt: 1,
      recaptchaWidgetId: null
    },
    // Calls & WebRTC
    turnStatusMessage: "",
    callLogs: [],
    activeCall: {
      phase: "IDLE",
      callId: "",
      roomId: "",
      peerName: "",
      isVideo: true,
      durationSeconds: 0,
      isMicMuted: false,
      isCameraEnabled: true,
      isSpeakerOn: true,
      remoteOfferSdp: null,
      avatarColor: "#8a6d3b"
    }
  };

  var syncLoopActive = false;
  var syncRetryWakeResolver = null;
  var consecutiveSyncFailures = 0;
  var callTimerInterval = null;
  var searchDebounceTimer = null;

  // =========================================================================
  // INITIALIZATION & PERSISTED PREFERENCES
  // =========================================================================

  function loadPreferences() {
    try {
      var savedTheme = localStorage.getItem("run_v2_web_theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        state.theme = savedTheme;
      }
      var savedQuality = localStorage.getItem("run_v2_web_call_quality");
      if (
        savedQuality === "DEFAULT_480P" ||
        savedQuality === "DATA_SAVER" ||
        savedQuality === "AUDIO_ONLY"
      ) {
        state.callQuality = savedQuality;
      }
      var savedLogs = localStorage.getItem("run_v2_web_call_logs");
      if (savedLogs) {
        state.callLogs = JSON.parse(savedLogs);
      }
    } catch (_) {}
    applyTheme(state.theme);
    renderQualityButtons();
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("run_v2_web_theme", theme);
    } catch (_) {}
    var btnDark = document.getElementById("btnThemeDark");
    var btnLight = document.getElementById("btnThemeLight");
    if (btnDark && btnLight) {
      btnDark.classList.toggle("ghost", theme !== "dark");
      btnLight.classList.toggle("ghost", theme !== "light");
    }
  }

  function showToast(message, isError) {
    var toast = document.getElementById("statusToast");
    var textEl = document.getElementById("statusToastText");
    if (!toast || !textEl) return;
    textEl.textContent = message;
    toast.classList.remove("hidden");
    toast.classList.toggle("error", Boolean(isError));
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(function () {
      toast.classList.add("hidden");
    }, 5500);
  }

  /**
   * Navigates between screens while supporting BOTH:
   * - Single-column mobile/tablet view (`< 1024px`, via `.screen.active`)
   * - Two-pane desktop split view (`>= 1024px`, via `.authenticated-layout`,
   *   `.desktop-sidebar-active` in the 336px left sidebar, and `.desktop-main-active`
   *   in the right conversation pane).
   */
  function showScreen(screenId) {
    state.currentScreen = screenId;
    var isAuthFlow =
      screenId === "login" || screenId === "pin" || screenId === "restored";

    var appShell = document.getElementById("appShell");
    if (appShell) {
      appShell.classList.toggle("authenticated-layout", !isAuthFlow);
    }

    if (
      screenId === "rooms" ||
      screenId === "search" ||
      screenId === "create" ||
      screenId === "calls" ||
      screenId === "settings"
    ) {
      state.sidebarScreen = screenId;
      if (state.mainPaneScreen === "call" && state.activeCall.phase === "IDLE") {
        state.mainPaneScreen = "chat";
      }
    } else if (screenId === "chat" || screenId === "roominfo" || screenId === "call") {
      state.mainPaneScreen = screenId;
    }

    var allScreens = document.querySelectorAll(".screen");
    for (var i = 0; i < allScreens.length; i++) {
      var el = allScreens[i];
      el.classList.toggle("active", el.id === "scr-" + screenId);
      el.classList.toggle(
        "desktop-sidebar-active",
        !isAuthFlow && el.id === "scr-" + state.sidebarScreen
      );
      el.classList.toggle(
        "desktop-main-active",
        !isAuthFlow && el.id === "scr-" + state.mainPaneScreen
      );
    }

    var tabBar = document.getElementById("bottomTabBar");
    var isMainTab = screenId === "rooms" || screenId === "calls" || screenId === "settings";
    if (tabBar) {
      tabBar.classList.toggle("hidden", isAuthFlow || !isMainTab);
    }

    var activeTabTarget =
      state.sidebarScreen === "calls"
        ? "calls"
        : state.sidebarScreen === "settings"
        ? "settings"
        : "rooms";

    var tabBtns = document.querySelectorAll("[data-main-tab]");
    for (var j = 0; j < tabBtns.length; j++) {
      var btn = tabBtns[j];
      var tabName = btn.getAttribute("data-main-tab");
      btn.classList.toggle(
        "active",
        window.innerWidth >= 1024 ? tabName === activeTabTarget : tabName === screenId
      );
    }

    if (!isAuthFlow) {
      updateChatHeader();
      renderChatMessages();
    }
  }

  /**
   * On Desktop (`>= 1024px`), automatically selects the first available room into the right
   * conversation pane if no room is currently selected so both panes are populated side-by-side.
   */
  function ensureDesktopActiveRoomSelected() {
    if (window.innerWidth < 1024) return;
    if (state.activeRoom || state.rooms.length === 0) return;
    var firstRoom = state.rooms[0];
    if (!firstRoom) return;
    state.activeRoom = firstRoom;
    updateChatHeader();
    renderChatMessages();
    renderRoomsList();
    window.RunMatrixClient.fetchRoomMessages(firstRoom.roomId, 25)
      .then(function (history) {
        if (!Array.isArray(history) || history.length === 0) return;
        var currentList = state.messagesByRoom[firstRoom.roomId] || [];
        var existingIds = new Set(
          currentList.map(function (m) {
            return m.eventId;
          })
        );
        var merged = history
          .filter(function (m) {
            return !existingIds.has(m.eventId);
          })
          .concat(currentList)
          .sort(function (a, b) {
            return (a.timestamp || 0) - (b.timestamp || 0);
          });
        state.messagesByRoom[firstRoom.roomId] = merged;
        if (state.activeRoom && state.activeRoom.roomId === firstRoom.roomId) {
          renderChatMessages();
        }
      })
      .catch(function () {});
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatShortTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  function formatDuration(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function buildAvatarHtml(label, bgColor, sizePx, presence) {
    var clean = String(label || "R").trim().replace(/^@/, "");
    var initial = clean ? clean.charAt(0).toUpperCase() : "R";
    var dotHtml = "";
    if (presence === "online") {
      dotHtml = '<span class="dot on"></span>';
    } else if (presence === "unavailable") {
      dotHtml = '<span class="dot away"></span>';
    }
    var fontSize = Math.round(sizePx * 0.36);
    return (
      '<span class="avatar" style="width:' +
      sizePx +
      "px;height:" +
      sizePx +
      "px;background:" +
      (bgColor || "#8a6d3b") +
      ";font-size:" +
      fontSize +
      'px">' +
      escapeHtml(initial) +
      dotHtml +
      "</span>"
    );
  }

  function copyToClipboard(text, btnEl) {
    function markDone() {
      if (!btnEl) return;
      var orig = btnEl.textContent;
      btnEl.textContent = "تم النسخ ✓";
      btnEl.classList.add("ok");
      setTimeout(function () {
        btnEl.textContent = orig;
        btnEl.classList.remove("ok");
      }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(markDone, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (_) {}
      document.body.removeChild(ta);
      markDone();
    }
  }

  // =========================================================================
  // 1. AUTHENTICATION & IN-APP MULTI-STAGE UIAA REGISTRATION
  // =========================================================================

  function setAuthMode(mode) {
    state.authMode = mode;
    resetUiaaState();
    setAuthError("");

    document.getElementById("tabModeLogin").classList.toggle("on", mode === "login");
    document.getElementById("tabModeRegister").classList.toggle("on", mode === "register");
    document.getElementById("fieldDisplayName").style.display = mode === "register" ? "" : "none";
    document.getElementById("fieldRegEmail").style.display = mode === "register" ? "" : "none";
    document.getElementById("authHeading").textContent =
      mode === "login" ? "مرحبًا بعودتك إلى Run" : "إنشاء حساب Run جديد";
    document.getElementById("btnSubmitAuth").textContent =
      mode === "login" ? "تسجيل الدخول" : "بدء إنشاء الحساب";
  }

  function setAuthError(msg) {
    var box = document.getElementById("authErrorBox");
    if (!box) return;
    if (!msg) {
      box.style.display = "none";
      box.textContent = "";
    } else {
      box.style.display = "block";
      box.textContent = msg;
    }
  }

  function resetUiaaState() {
    state.uiaa = {
      active: false,
      session: "",
      selectedStages: [],
      completed: [],
      nextStage: "",
      params: {},
      clientSecret: "runv2_cs_" + Math.random().toString(36).slice(2) + "_" + Date.now(),
      emailSid: "",
      emailSubmitUrl: "",
      sendAttempt: 1,
      recaptchaWidgetId: null
    };
    var card = document.getElementById("uiaaCard");
    if (card) card.style.display = "none";
  }

  async function onSubmitAuthClick() {
    setAuthError("");
    var username = document.getElementById("inpAuthUser").value.trim();
    var password = document.getElementById("inpAuthPass").value;
    var displayName = document.getElementById("inpAuthDisplayName").value.trim();
    var email = document.getElementById("inpAuthEmail").value.trim();
    var btn = document.getElementById("btnSubmitAuth");

    if (state.authMode === "login") {
      btn.disabled = true;
      btn.textContent = "جاري تسجيل الدخول…";
      try {
        var account = await window.RunMatrixClient.login(username, password);
        await onAuthenticatedSuccess(account, false);
      } catch (err) {
        setAuthError(err.message || "تعذر تسجيل الدخول");
      } finally {
        btn.disabled = false;
        btn.textContent = "تسجيل الدخول";
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = "جاري الاتصال بالسيرفر…";
    try {
      var res = await window.RunMatrixClient.registerStep({
        username: username,
        password: password,
        displayName: displayName,
        auth: null
      });
      if (res.status === "COMPLETED") {
        await onAuthenticatedSuccess(res.account, true);
      } else if (res.status === "UIAA_REQUIRED") {
        await handleUiaaChallengeResponse(res, email);
      }
    } catch (err) {
      setAuthError(err.message || "تعذر إنشاء الحساب");
    } finally {
      btn.disabled = false;
      btn.textContent = "بدء إنشاء الحساب";
    }
  }

  async function handleUiaaChallengeResponse(uiaaResp, emailInput) {
    state.uiaa.active = true;
    state.uiaa.session = uiaaResp.session;
    state.uiaa.selectedStages = uiaaResp.selectedStages || [];
    state.uiaa.completed = uiaaResp.completed || [];
    state.uiaa.nextStage = uiaaResp.nextStage || "";
    state.uiaa.params = uiaaResp.params || {};

    if (uiaaResp.stageError) {
      setAuthError(uiaaResp.stageError);
    }

    var card = document.getElementById("uiaaCard");
    var badgesEl = document.getElementById("uiaaStepsBadges");
    var titleEl = document.getElementById("uiaaStageTitle");
    var descEl = document.getElementById("uiaaStageDesc");
    var recaptchaSec = document.getElementById("uiaaRecaptchaSection");
    var emailSec = document.getElementById("uiaaEmailSection");
    var termsSec = document.getElementById("uiaaTermsSection");

    card.style.display = "block";
    recaptchaSec.style.display = "none";
    emailSec.style.display = "none";
    termsSec.style.display = "none";

    var stageLabels = {
      "m.login.recaptcha": "1. تحقق reCAPTCHA",
      "m.login.email.identity": "2. تأكيد البريد الإلكتروني",
      "m.login.terms": "الموافقة على الشروط",
      "m.login.dummy": "التحقق المباشر"
    };

    badgesEl.innerHTML = state.uiaa.selectedStages
      .map(function (st) {
        var isDone = state.uiaa.completed.indexOf(st) !== -1;
        var isCurrent = st === state.uiaa.nextStage;
        var cls = isDone ? "chip ok" : isCurrent ? "chip" : "chip warn";
        var label = stageLabels[st] || st;
        return '<span class="' + cls + '">' + (isDone ? "✓ " : "") + escapeHtml(label) + "</span>";
      })
      .join("");

    var nextStage = state.uiaa.nextStage;

    if (nextStage === "m.login.recaptcha") {
      titleEl.textContent = "الخطوة 1: التحقق عبر reCAPTCHA";
      descEl.textContent = "أكمل مربع التحقق أدناه للمتابعة مباشرة إلى تأكيد البريد الإلكتروني داخل التطبيق.";
      recaptchaSec.style.display = "block";
      var siteKey =
        (state.uiaa.params["m.login.recaptcha"] &&
          state.uiaa.params["m.login.recaptcha"].public_key) ||
        "";
      await renderInAppRecaptcha(siteKey);
    } else if (nextStage === "m.login.email.identity") {
      titleEl.textContent = "الخطوة 2: تأكيد البريد الإلكتروني";
      emailSec.style.display = "block";

      var email = emailInput || document.getElementById("inpAuthEmail").value.trim();
      if (!email) {
        descEl.textContent = "أدخل بريدك الإلكتروني في الحقل أعلاه ثم اضغط «إعادة الإرسال» لإرسال رابط/رمز التأكيد.";
        return;
      }

      if (!state.uiaa.emailSid) {
        descEl.textContent = "جاري إرسال رسالة التحقق إلى " + email + "…";
        try {
          var tokenInfo = await window.RunMatrixClient.requestRegisterEmailToken(
            email,
            state.uiaa.clientSecret,
            state.uiaa.sendAttempt
          );
          state.uiaa.emailSid = tokenInfo.sid;
          state.uiaa.emailSubmitUrl = tokenInfo.submitUrl;
          descEl.textContent =
            "تم إرسال رسالة التحقق إلى (" +
            email +
            "). افتح الرسالة في بريدك واضغط رابط التأكيد (أو أدخل الرمز إن وجد)، ثم اضغط «تأكيد البريد وإكمال التسجيل».";
        } catch (err) {
          setAuthError(err.message || "تعذر إرسال رمز التحقق إلى البريد الإلكتروني");
        }
      } else {
        descEl.textContent =
          "افتح رسالة التحقق المرسلة إلى بريدك واضغط رابط التأكيد ثم اضغط «تأكيد البريد وإكمال التسجيل».";
      }
    } else if (nextStage === "m.login.terms") {
      titleEl.textContent = "الموافقة على شروط الخدمة";
      descEl.textContent = "اضغط الزر أدناه للموافقة وإكمال إنشاء الحساب.";
      termsSec.style.display = "block";
    } else if (nextStage === "m.login.dummy") {
      await submitCurrentUiaaAuth({
        type: "m.login.dummy",
        session: state.uiaa.session
      });
    }
  }

  function renderInAppRecaptcha(siteKey) {
    return new Promise(function (resolve) {
      var container = document.getElementById("uiaaRecaptchaWidget");
      if (!container) return resolve();
      container.innerHTML = "";

      if (!siteKey) {
        container.innerHTML =
          '<div class="empty-note">لم يرسل السيرفر مفتاح reCAPTCHA عام (public_key).</div>';
        return resolve();
      }

      function mountWidget() {
        if (!window.grecaptcha || typeof window.grecaptcha.render !== "function") {
          setTimeout(mountWidget, 200);
          return;
        }
        try {
          var widgetDiv = document.createElement("div");
          container.appendChild(widgetDiv);
          window.grecaptcha.render(widgetDiv, {
            sitekey: siteKey,
            theme: state.theme === "dark" ? "dark" : "light",
            callback: function (recaptchaToken) {
              submitCurrentUiaaAuth({
                type: "m.login.recaptcha",
                session: state.uiaa.session,
                response: recaptchaToken
              });
            }
          });
        } catch (_) {}
        resolve();
      }

      if (!document.getElementById("googleRecaptchaScript")) {
        var s = document.createElement("script");
        s.id = "googleRecaptchaScript";
        s.src = "https://www.google.com/recaptcha/api.js?render=explicit&hl=ar";
        s.async = true;
        s.defer = true;
        s.onload = mountWidget;
        document.head.appendChild(s);
      } else {
        mountWidget();
      }
    });
  }

  async function submitCurrentUiaaAuth(authObj) {
    setAuthError("");
    var username = document.getElementById("inpAuthUser").value.trim();
    var password = document.getElementById("inpAuthPass").value;
    var displayName = document.getElementById("inpAuthDisplayName").value.trim();
    var email = document.getElementById("inpAuthEmail").value.trim();

    try {
      var res = await window.RunMatrixClient.registerStep({
        username: username,
        password: password,
        displayName: displayName,
        auth: authObj
      });
      if (res.status === "COMPLETED") {
        resetUiaaState();
        await onAuthenticatedSuccess(res.account, true);
      } else if (res.status === "UIAA_REQUIRED") {
        await handleUiaaChallengeResponse(res, email);
      }
    } catch (err) {
      setAuthError(err.message || "تعذر إكمال خطوة التحقق");
    }
  }

  async function onConfirmEmailStageClick() {
    setAuthError("");
    var codeVal = document.getElementById("inpEmailVerifyCode").value.trim();
    if (codeVal && state.uiaa.emailSid) {
      await window.RunMatrixClient.submitRegisterEmailCode(
        state.uiaa.emailSid,
        state.uiaa.clientSecret,
        codeVal,
        state.uiaa.emailSubmitUrl
      );
    }

    if (!state.uiaa.emailSid) {
      var email = document.getElementById("inpAuthEmail").value.trim();
      try {
        var tokenInfo = await window.RunMatrixClient.requestRegisterEmailToken(
          email,
          state.uiaa.clientSecret,
          state.uiaa.sendAttempt
        );
        state.uiaa.emailSid = tokenInfo.sid;
        state.uiaa.emailSubmitUrl = tokenInfo.submitUrl;
      } catch (err) {
        setAuthError(err.message || "يرجى طلب رسالة التحقق أولاً");
        return;
      }
    }

    var creds = {
      sid: state.uiaa.emailSid,
      client_secret: state.uiaa.clientSecret
    };

    await submitCurrentUiaaAuth({
      type: "m.login.email.identity",
      session: state.uiaa.session,
      threepid_creds: creds,
      threepidCreds: creds
    });
  }

  async function onResendEmailStageClick() {
    setAuthError("");
    var email = document.getElementById("inpAuthEmail").value.trim();
    state.uiaa.sendAttempt += 1;
    try {
      var tokenInfo = await window.RunMatrixClient.requestRegisterEmailToken(
        email,
        state.uiaa.clientSecret,
        state.uiaa.sendAttempt
      );
      state.uiaa.emailSid = tokenInfo.sid;
      state.uiaa.emailSubmitUrl = tokenInfo.submitUrl;
      showToast("تمت إعادة إرسال رسالة التحقق إلى " + email, false);
    } catch (err) {
      setAuthError(err.message || "تعذر إعادة إرسال رسالة التحقق");
    }
  }

  async function onAuthenticatedSuccess(account, isNewRegistration) {
    state.account = account;
    state.initialSyncCompleted = false;
    state.syncError = null;
    state.rooms = window.RunMatrixClient.getPersistedRoomsList();
    renderAccountScreen();
    renderRoomsList();
    ensureDesktopActiveRoomSelected();
    checkTurnStatusAfterLogin();
    startSyncLoop();

    if (isNewRegistration) {
      openPinScreen("create");
      return;
    }

    var hasRemoteBackup = await window.RunMatrixClient.checkRemotePinBackupExists();
    if (account.isPinConfigured) {
      showScreen("rooms");
      handleUrlDeepLinkIfAny();
    } else if (hasRemoteBackup) {
      openPinScreen("restore");
    } else {
      openPinScreen("create");
    }
  }

  // =========================================================================
  // 2. 6-DIGIT PIN SCREEN (2-Step Create & 1-Step Restore)
  // =========================================================================

  function openPinScreen(mode) {
    state.pinMode = mode;
    state.pinFirstEntry = "";
    state.pinCurrentValue = "";
    updatePinUi(false, "");
    showScreen("pin");
  }

  function updatePinUi(isSuccess, statusMsg, isError) {
    var titleEl = document.getElementById("pinTitle");
    var subEl = document.getElementById("pinSubtitle");
    var statusEl = document.getElementById("pinStatus");
    var dots = document.querySelectorAll("#pinDots span");

    var isConfirmStep = state.pinMode === "create" && state.pinFirstEntry.length === 6;
    if (state.pinMode === "restore") {
      titleEl.textContent = "استعادة النسخة الاحتياطية برمز PIN";
      subEl.textContent =
        "أدخل رمز PIN المكون من 6 أرقام الذي أنشأته سابقًا لفك تشفير نسخة مفاتيح محادثاتك (Megolm) على هذا المتصفح.";
    } else if (isConfirmStep) {
      titleEl.textContent = "تأكيد رمز PIN";
      subEl.textContent = "أعد إدخال نفس الأرقام الستة لتأكيد رمز PIN وحفظ النسخة المشفرة.";
    } else {
      titleEl.textContent = "أنشئ رمز PIN من 6 أرقام";
      subEl.textContent =
        "هذا الرمز منفصل عن كلمة السر ويشفر نسخة مفاتيح محادثاتك (Megolm) احتياطيًا لاستعادتها على أي جهاز آخر.";
    }

    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle("filled", i < state.pinCurrentValue.length);
      dots[i].classList.toggle("ok", Boolean(isSuccess) && i < state.pinCurrentValue.length);
    }

    statusEl.textContent = statusMsg || "";
    statusEl.classList.toggle("err", Boolean(isError));
  }

  async function onPinDigitPress(digit) {
    if (state.pinCurrentValue.length >= 6) return;
    state.pinCurrentValue += digit;
    updatePinUi(false, "");

    if (state.pinCurrentValue.length === 6) {
      var entered = state.pinCurrentValue;
      if (state.pinMode === "restore") {
        updatePinUi(false, "جاري فك تشفير واستعادة مفاتيح الغرف…", false);
        try {
          var restoredCount = await window.RunMatrixClient.restorePinKeyBackup(entered);
          state.account = window.RunMatrixClient.getCurrentAccountObject();
          renderAccountScreen();
          updatePinUi(true, "تمت الاستعادة بنجاح ✓", false);
          document.getElementById("restoredSummaryText").textContent =
            "رمز PIN فكّ تشفير نسخة المفاتيح الاحتياطية، وتمت استعادة " +
            restoredCount +
            " مفتاح جلسة Megolm لمحادثاتك.";
          setTimeout(function () {
            showScreen("restored");
          }, 500);
        } catch (err) {
          state.pinCurrentValue = "";
          updatePinUi(false, "رمز PIN غير صحيح أو لا توجد نسخة احتياطية مطابقة", true);
        }
      } else {
        if (!state.pinFirstEntry) {
          state.pinFirstEntry = entered;
          state.pinCurrentValue = "";
          updatePinUi(false, "الآن أعد إدخال نفس الأرقام الستة للتأكيد", false);
        } else if (entered === state.pinFirstEntry) {
          updatePinUi(false, "جاري تشفير وحفظ نسخة المفاتيح…", false);
          try {
            await window.RunMatrixClient.uploadPinKeyBackup(entered);
            state.account = window.RunMatrixClient.getCurrentAccountObject();
            renderAccountScreen();
            updatePinUi(true, "تم حفظ رمز PIN بنجاح ✓", false);
            setTimeout(function () {
              showScreen("rooms");
              handleUrlDeepLinkIfAny();
            }, 500);
          } catch (err) {
            state.pinFirstEntry = "";
            state.pinCurrentValue = "";
            updatePinUi(false, err.message || "تعذر رفع النسخة الاحتياطية", true);
          }
        } else {
          state.pinFirstEntry = "";
          state.pinCurrentValue = "";
          updatePinUi(false, "الرمزان غير متطابقين، يرجى إدخال رمز PIN من جديد", true);
        }
      }
    }
  }

  // =========================================================================
  // 3. TWO-STAGE FILTERED /SYNC LOOP, BACKOFF & LOCALSTORAGE CACHE (Fix 1)
  // =========================================================================

  window.RunCryptoEngine.setOnRoomKeyReceived(function (newlyReceivedSessions) {
    var updatedAny = false;
    newlyReceivedSessions.forEach(function (item) {
      var list = state.messagesByRoom[item.roomId];
      if (!Array.isArray(list)) return;
      list.forEach(function (msg) {
        if (msg.decryptionFailed && msg.rawEncryptedContent) {
          var retry = window.RunCryptoEngine.decryptMegolmEvent(
            item.roomId,
            msg.senderUserId,
            msg.rawEncryptedContent
          );
          if (!retry.decryptionFailed) {
            msg.body = retry.body;
            msg.decryptionFailed = false;
            msg.isEncrypted = true;
            updatedAny = true;
          }
        }
      });
    });
    if (updatedAny) {
      renderChatMessages();
      renderRoomsList();
    }
  });

  function updateSyncStatusBanner() {
    var banner = document.getElementById("syncStatusBanner");
    var textEl = document.getElementById("syncStatusText");
    if (!banner || !textEl) return;

    if (state.syncError) {
      banner.style.display = "block";
      textEl.textContent =
        "تعذر المزامنة (" +
        state.syncError +
        ") — إعادة المحاولة خلال " +
        state.syncRetryDelaySec +
        " ث…";
    } else {
      banner.style.display = "none";
      textEl.textContent = "";
    }
  }

  function triggerImmediateSyncRetry() {
    consecutiveSyncFailures = 0;
    state.syncError = null;
    updateSyncStatusBanner();
    renderRoomsList();
    if (typeof syncRetryWakeResolver === "function") {
      var resolve = syncRetryWakeResolver;
      syncRetryWakeResolver = null;
      resolve();
    } else if (!syncLoopActive && window.RunMatrixClient.isLoggedIn()) {
      startSyncLoop();
    }
  }

  function mergeSyncResultIntoState(data, isInitialSyncBatch) {
    state.initialSyncCompleted = true;
    state.isSyncInProgress = false;
    state.syncError = null;
    updateSyncStatusBanner();

    // 1. Merge timeline messages
    var msgRoomIds = Object.keys(data.newMessagesByRoom || {});
    for (var i = 0; i < msgRoomIds.length; i++) {
      var rId = msgRoomIds[i];
      var incomingMsgs = data.newMessagesByRoom[rId] || [];
      if (!state.messagesByRoom[rId]) state.messagesByRoom[rId] = [];
      var existingList = state.messagesByRoom[rId];
      var seenIds = new Set(
        existingList.map(function (m) {
          return m.eventId;
        })
      );
      incomingMsgs.forEach(function (m) {
        if (!seenIds.has(m.eventId)) {
          existingList.push(m);
          if (!isInitialSyncBatch && !m.isOutgoing) {
            triggerBrowserNotification(m.senderDisplayName, m.body);
          }
        }
      });
      existingList.sort(function (a, b) {
        return (a.timestamp || 0) - (b.timestamp || 0);
      });
    }

    // 2. Merge room summaries preserving cached last message & name across incremental sync batches
    var roomMap = {};
    state.rooms.forEach(function (r) {
      roomMap[r.roomId] = r;
    });
    (data.rooms || []).forEach(function (updatedRoom) {
      var prev = roomMap[updatedRoom.roomId];
      if (prev) {
        var mergedRoom = Object.assign({}, prev, updatedRoom);
        if (!updatedRoom.lastMessageTimestamp && prev.lastMessageTimestamp) {
          mergedRoom.lastMessageTimestamp = prev.lastMessageTimestamp;
          mergedRoom.lastMessageSender = prev.lastMessageSender;
          mergedRoom.lastMessageBody = prev.lastMessageBody;
        }
        if (
          (!updatedRoom.name || updatedRoom.name === "غرفة Run") &&
          prev.name &&
          prev.name !== "غرفة Run"
        ) {
          mergedRoom.name = prev.name;
        }
        if (prev.isEncrypted && !updatedRoom.isEncrypted) {
          mergedRoom.isEncrypted = true;
          mergedRoom.encryptionStatusNote = null;
        }
        roomMap[updatedRoom.roomId] = mergedRoom;
      } else {
        roomMap[updatedRoom.roomId] = updatedRoom;
      }
    });

    state.rooms = Object.values(roomMap).sort(function (a, b) {
      return (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0);
    });

    // Persist updated room summaries in localStorage immediately
    window.RunMatrixClient.savePersistedRoomsList(state.rooms);

    if (state.activeRoom && roomMap[state.activeRoom.roomId]) {
      state.activeRoom = roomMap[state.activeRoom.roomId];
      updateChatHeader();
      renderChatMessages();
    } else {
      ensureDesktopActiveRoomSelected();
    }

    if (Array.isArray(data.incomingFriendInvites) && data.incomingFriendInvites.length > 0) {
      state.incomingFriendInvites = data.incomingFriendInvites;
    } else if (isInitialSyncBatch) {
      state.incomingFriendInvites = data.incomingFriendInvites || [];
    }

    if (Array.isArray(data.outgoingFriendInvites) && data.outgoingFriendInvites.length > 0) {
      state.outgoingFriendInvites = data.outgoingFriendInvites;
    } else if (isInitialSyncBatch) {
      state.outgoingFriendInvites = data.outgoingFriendInvites || [];
    }

    if (Array.isArray(data.friends) && data.friends.length > 0) {
      state.friends = data.friends;
    }

    renderRoomsList();
    renderSearchLists();

    // Process WebRTC signaling events
    (data.signalingEvents || []).forEach(function (ev) {
      handleSignalingEvent(ev);
    });
  }

  async function startSyncLoop() {
    if (syncLoopActive) return;
    syncLoopActive = true;
    consecutiveSyncFailures = 0;

    var sinceToken = window.RunMatrixClient.getPersistedSyncToken();
    var completedPass2Timeline = Boolean(sinceToken && state.rooms.length > 0);

    while (syncLoopActive && window.RunMatrixClient.isLoggedIn()) {
      state.isSyncInProgress = true;
      renderRoomsList();
      try {
        // Stage 1: If no rooms or no sinceToken yet, execute the ultra-light first pass (~3 KB)
        // so the rooms list appears immediately even on 12–30 KB/s mobile data!
        if (!sinceToken && state.rooms.length === 0) {
          var firstPassData = await window.RunMatrixClient.syncFirstPassLight();
          if (firstPassData && Array.isArray(firstPassData.rooms)) {
            mergeSyncResultIntoState(firstPassData, true);
            if (firstPassData.nextBatch) {
              sinceToken = firstPassData.nextBatch;
            }
          }
        }

        // Stage 2: Filtered timeline sync (10 messages per room, lazy_load_members: true)
        var syncSinceArg = completedPass2Timeline ? sinceToken : null;
        var syncTimeoutArg = completedPass2Timeline ? 12000 : 0;
        var data = await window.RunMatrixClient.sync(syncSinceArg, syncTimeoutArg);
        var wasInitialTimelinePass = !completedPass2Timeline;
        completedPass2Timeline = true;
        sinceToken = data.nextBatch || sinceToken;
        consecutiveSyncFailures = 0;

        mergeSyncResultIntoState(data, wasInitialTimelinePass);

        // Stage 3: Lazily load member display names for small/DM rooms in the background
        if (wasInitialTimelinePass && state.rooms.length > 0) {
          window.RunMatrixClient.lazyLoadRoomMembersForSmallRooms(state.rooms)
            .then(function (updatedNames) {
              if (updatedNames) {
                renderRoomsList();
                updateChatHeader();
              }
            })
            .catch(function () {});
        }
      } catch (syncErr) {
        consecutiveSyncFailures += 1;
        var backoffMs =
          BACKOFF_DELAYS_MS[
            Math.min(consecutiveSyncFailures - 1, BACKOFF_DELAYS_MS.length - 1)
          ] || 3500;
        state.syncRetryDelaySec = backoffMs / 1000;
        console.warn(
          "[RunSync] Sync failed (attempt " +
            consecutiveSyncFailures +
            ", retry in " +
            state.syncRetryDelaySec +
            "s):",
          syncErr && syncErr.name,
          syncErr && syncErr.message
        );
        state.isSyncInProgress = false;
        state.syncError = (syncErr && syncErr.message) || "انقطاع في الشبكة";
        updateSyncStatusBanner();
        renderRoomsList();

        // Exponential backoff (3.5s -> 7s -> 15s) OR wake immediately when user clicks «إعادة المحاولة»
        await new Promise(function (resolve) {
          var timer = setTimeout(function () {
            syncRetryWakeResolver = null;
            resolve();
          }, backoffMs);
          syncRetryWakeResolver = function () {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      await new Promise(function (r) {
        setTimeout(r, 600);
      });
    }
    syncLoopActive = false;
  }

  function triggerBrowserNotification(senderName, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && state.currentScreen === "chat") return;
    try {
      new Notification(senderName, {
        body: body,
        icon: "./icon-run-v2.svg"
      });
    } catch (_) {}
  }

  // =========================================================================
  // 4. ROOMS LIST, CHAT PANE & ROOM INFO / DEVICE VERIFICATION
  // =========================================================================

  function renderRoomsList() {
    var container = document.getElementById("roomsListContainer");
    var unreadBadge = document.getElementById("unreadTotalBadge");
    if (!container) return;

    var totalUnread = state.rooms.reduce(function (acc, r) {
      return acc + (r.unreadCount || 0);
    }, 0);
    if (unreadBadge) {
      unreadBadge.style.display = totalUnread > 0 ? "flex" : "none";
      unreadBadge.textContent = String(totalUnread);
    }

    // NEVER show «لا توجد غرف» before the first sync has completed!
    if (state.rooms.length === 0) {
      if (!state.initialSyncCompleted) {
        container.innerHTML =
          '<div class="empty-note" style="text-align:center;padding:38px 24px">' +
          '<div style="font-size:15px;font-weight:600;color:var(--accent);margin-bottom:6px">جاري تحميل الغرف…</div>' +
          '<div style="font-size:12.5px;color:var(--app-ink-soft)">يتم الآن مزامنة غرفك ومحادثاتك المشفرة (مزامنة سريعة ومصفاة).</div>' +
          "</div>";
        return;
      }

      container.innerHTML =
        '<div class="empty-note" style="text-align:center;padding:36px 24px">' +
        '<div style="font-size:15px;font-weight:600;color:var(--app-ink);margin-bottom:6px">لا توجد غرف أو محادثات بعد</div>' +
        "استخدم شريط البحث في الأعلى للبحث عن أصدقائك بـ <span dir='ltr'>@username</span> أو الانضمام إلى غرفة عامة، أو اضغط زر (+) لإنشاء غرفة جماعية جديدة." +
        "</div>";
      return;
    }

    var groups = state.rooms.filter(function (r) {
      return !r.isDirect;
    });
    var directs = state.rooms.filter(function (r) {
      return r.isDirect;
    });

    var html = "";

    function buildRoomItemHtml(r) {
      var lockIcon = r.isEncrypted ? "🔒 " : "";
      var isSelected = Boolean(state.activeRoom && state.activeRoom.roomId === r.roomId);
      var rowClass = isSelected ? "room-row active-room" : "room-row";
      var preview = r.lastMessageSender
        ? "<b>" + escapeHtml(r.lastMessageSender) + ":</b> " + escapeHtml(r.lastMessageBody)
        : escapeHtml(r.lastMessageBody);
      var unreadHtml =
        r.unreadCount > 0 ? '<span class="unread-badge">' + r.unreadCount + "</span>" : "";
      return (
        '<button class="' +
        rowClass +
        '" type="button" data-room-id="' +
        escapeHtml(r.roomId) +
        '">' +
        buildAvatarHtml(r.name, r.avatarColor, 48, r.isDirect ? r.peerPresence : null) +
        '<span class="meta">' +
        '<span class="top"><span class="name">' +
        lockIcon +
        escapeHtml(r.name) +
        '</span><span class="time">' +
        formatShortTime(r.lastMessageTimestamp) +
        "</span></span>" +
        '<span class="last">' +
        preview +
        "</span>" +
        "</span>" +
        unreadHtml +
        "</button>"
      );
    }

    if (state.spaceFilter !== "DIRECT" && groups.length > 0) {
      html += '<div class="sec-label">غرف المجموعات</div>';
      groups.forEach(function (g) {
        html += buildRoomItemHtml(g);
      });
    }

    if (state.spaceFilter !== "GROUPS" && directs.length > 0) {
      html += '<div class="sec-label">محادثات خاصة</div>';
      directs.forEach(function (d) {
        html += buildRoomItemHtml(d);
      });
    }

    container.innerHTML = html || '<div class="empty-note">لا توجد غرف ضمن هذا التصنيف.</div>';

    var btns = container.querySelectorAll("[data-room-id]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var rId = this.getAttribute("data-room-id");
        var target = state.rooms.find(function (x) {
          return x.roomId === rId;
        });
        if (target) openRoomChat(target);
      });
    }
  }

  async function openRoomChat(room) {
    state.activeRoom = room;
    renderRoomsList();
    updateChatHeader();
    renderChatMessages();
    showScreen("chat");

    var isEnc = await window.RunMatrixClient.checkRoomEncryptionEnabled(room.roomId);
    room.isEncrypted = isEnc;
    room.encryptionStatusNote = isEnc
      ? null
      : "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة";
    window.RunMatrixClient.savePersistedRoomsList(state.rooms);
    updateChatHeader();

    try {
      var history = await window.RunMatrixClient.fetchRoomMessages(room.roomId, 30);
      var currentList = state.messagesByRoom[room.roomId] || [];
      var existingIds = new Set(
        currentList.map(function (m) {
          return m.eventId;
        })
      );
      var merged = history
        .filter(function (m) {
          return !existingIds.has(m.eventId);
        })
        .concat(currentList)
        .sort(function (a, b) {
          return (a.timestamp || 0) - (b.timestamp || 0);
        });
      state.messagesByRoom[room.roomId] = merged;
      if (state.activeRoom && state.activeRoom.roomId === room.roomId) {
        renderChatMessages();
      }
    } catch (_) {}
  }

  function updateChatHeader() {
    var r = state.activeRoom;
    var nameEl = document.getElementById("chatHeaderName");
    var avatarEl = document.getElementById("chatHeaderAvatar");
    var badge = document.getElementById("chatHeaderLockBadge");
    var statusEl = document.getElementById("chatHeaderStatus");
    var inp = document.getElementById("inpChatMessage");
    if (!nameEl || !avatarEl || !badge || !statusEl) return;

    if (!r) {
      nameEl.textContent = "المحادثة";
      avatarEl.textContent = "R";
      avatarEl.style.background = "#8a6d3b";
      badge.className = "chip ok";
      badge.textContent = "🔒 Olm/Megolm";
      statusEl.textContent = "اختر غرفة أو صديقًا من القائمة الجانبية لبدء المراسلة المشفرة";
      if (inp) {
        inp.placeholder = "اختر غرفة من القائمة الجانبية لكتابة رسالة…";
      }
      return;
    }

    nameEl.textContent = r.name;
    avatarEl.textContent = r.name.trim().replace(/^@/, "").charAt(0).toUpperCase() || "R";
    avatarEl.style.background = r.avatarColor || "#8a6d3b";

    if (r.isEncrypted) {
      badge.className = "chip ok";
      badge.textContent = "🔒 مشفرة E2E";
    } else {
      badge.className = "chip warn";
      badge.textContent = "غير مشفرة";
    }

    var baseStatus = r.isDirect
      ? r.peerPresence === "online"
        ? "متصل الآن"
        : r.roomCode
      : r.memberCount + " عضوًا · الكود " + r.roomCode;
    statusEl.textContent =
      baseStatus + (r.isEncrypted ? " · تشفير Olm/Megolm" : " · غير مشفرة");

    if (inp) {
      inp.placeholder = r.isEncrypted ? "اكتب رسالة مشفرة…" : "اكتب رسالة (غير مشفرة)…";
    }
  }

  function renderChatMessages() {
    var container = document.getElementById("chatMessagesContainer");
    if (!container) return;
    var r = state.activeRoom;

    if (!r) {
      container.innerHTML =
        '<div class="empty-note" style="margin:auto;text-align:center;max-width:380px;padding:32px 24px">' +
        '<div style="font-size:16px;font-weight:600;color:var(--accent);margin-bottom:8px">اختر غرفة لبدء المراسلة</div>' +
        '<div style="font-size:13px;color:var(--app-ink-soft);line-height:1.7">اختر أي غرفة أو محادثة خاصة من الشريط الجانبي لعرض الرسائل المشفرة أو بدء مكالمة صوت وفيديو 1-إلى-1.</div>' +
        "</div>";
      return;
    }

    var bannerHtml = r.isEncrypted
      ? '<div class="enc-banner">🔒 تشفير من الطرف إلى الطرف مفعّل (Olm/Megolm) — متوافق مع Element</div>'
      : '<div class="enc-banner unencrypted">⚠️ ' +
        escapeHtml(r.encryptionStatusNote || "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة") +
        "</div>";

    var msgs = state.messagesByRoom[r.roomId] || [];
    var itemsHtml = msgs
      .map(function (m) {
        var dirClass = m.isOutgoing ? "msg out" : "msg in";
        if (m.decryptionFailed) dirClass += " decrypt-error";
        var senderHtml =
          !r.isDirect && !m.isOutgoing
            ? '<div class="who">' + escapeHtml(m.senderDisplayName) + "</div>"
            : "";
        var lockMark = m.isEncrypted && !m.decryptionFailed ? "🔒 " : "";
        var ticks = m.isOutgoing ? " ✓✓" : "";
        var retryBtn =
          m.decryptionFailed && m.rawEncryptedContent && m.rawEncryptedContent.session_id
            ? '<div><button type="button" class="retry-key-btn" data-req-session="' +
              escapeHtml(m.rawEncryptedContent.session_id) +
              '" data-req-senderkey="' +
              escapeHtml(m.rawEncryptedContent.sender_key || "") +
              '" data-req-sender="' +
              escapeHtml(m.senderUserId) +
              '">طلب مفتاح الجلسة مجددًا</button></div>'
            : "";
        return (
          '<div class="' +
          dirClass +
          '">' +
          senderHtml +
          "<div>" +
          escapeHtml(m.body) +
          "</div>" +
          retryBtn +
          '<div class="t">' +
          lockMark +
          formatShortTime(m.timestamp) +
          ticks +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    container.innerHTML = bannerHtml + itemsHtml;
    container.scrollTop = container.scrollHeight;

    var reqBtns = container.querySelectorAll("[data-req-session]");
    for (var i = 0; i < reqBtns.length; i++) {
      reqBtns[i].addEventListener("click", function () {
        var sessId = this.getAttribute("data-req-session");
        var sKey = this.getAttribute("data-req-senderkey");
        var sUser = this.getAttribute("data-req-sender");
        window.RunMatrixClient.requestMissingRoomKey(r.roomId, sessId, sKey, sUser);
        showToast("تم إرسال طلب مفتاح الجلسة (m.room_key_request) إلى أجهزة المرسل", false);
      });
    }
  }

  async function onSendChatMessage() {
    var r = state.activeRoom;
    var inp = document.getElementById("inpChatMessage");
    if (!r) {
      showToast("يرجى اختيار غرفة أو محادثة أولاً", true);
      return;
    }
    if (!inp) return;
    var text = inp.value.trim();
    if (!text) return;
    inp.value = "";

    try {
      var sentMsg = await window.RunMatrixClient.sendRoomMessage(r.roomId, text);
      if (!state.messagesByRoom[r.roomId]) state.messagesByRoom[r.roomId] = [];
      var list = state.messagesByRoom[r.roomId];
      if (
        !list.some(function (x) {
          return x.eventId === sentMsg.eventId;
        })
      ) {
        list.push(sentMsg);
      }
      r.lastMessageSender = "أنت";
      r.lastMessageBody = text;
      r.lastMessageTimestamp = sentMsg.timestamp;
      window.RunMatrixClient.savePersistedRoomsList(state.rooms);
      renderChatMessages();
      renderRoomsList();
    } catch (err) {
      showToast(err.message || "تعذر إرسال الرسالة", true);
    }
  }

  async function openRoomInfoScreen() {
    var r = state.activeRoom;
    if (!r) {
      showToast("اختر غرفة أولاً لعرض تفاصيلها", false);
      return;
    }

    document.getElementById("riTitle").textContent = r.name;
    document.getElementById("riSubtitle").textContent = r.isDirect
      ? "محادثة خاصة · " + r.roomCode
      : r.memberCount + " عضوًا · غرفة دائمة";

    var encTitle = document.getElementById("riEncryptionTitle");
    var encDesc = document.getElementById("riEncryptionDesc");
    var btnReshare = document.getElementById("btnReshareRoomKeysNow");

    if (r.isEncrypted) {
      encTitle.textContent = "🔒 التشفير من الطرف إلى الطرف مفعّل (Olm / Megolm)";
      encTitle.style.color = "var(--online)";
      encDesc.textContent =
        "تُشارك مفاتيح Megolm تلقائيًا مع جميع أجهزة الأعضاء (الموثقة وغير الموثقة) مع الرد التلقائي على طلبات المفاتيح (m.room_key_request) للتوافق التام مع Element وCinny.";
      btnReshare.style.display = "inline-block";
    } else {
      encTitle.textContent = "⚠️ هذه الغرفة غير مشفرة";
      encTitle.style.color = "var(--danger)";
      encDesc.textContent =
        r.encryptionStatusNote || "الرسائل المرسلة في هذه الغرفة قياسية وغير مشفرة.";
      btnReshare.style.display = "none";
    }

    var inviteLink =
      r.isDirect && r.roomCode.startsWith("@")
        ? window.RUN_CONFIG.buildFriendInviteLink(r.roomCode)
        : window.RUN_CONFIG.buildRoomInviteLink(r.roomCode);

    document.getElementById("riInviteLink").textContent = inviteLink;
    document.getElementById("riRoomCode").textContent = r.roomCode;
    document.getElementById("riMembersList").innerHTML =
      '<div class="empty-note">جاري تحميل قائمة الأعضاء والأجهزة…</div>';
    document.getElementById("riDevicesList").innerHTML = "";

    showScreen("roominfo");

    try {
      var info = await window.RunMatrixClient.fetchRoomMembersAndDevices(r.roomId);
      state.activeRoomMembers = info.members || [];
      state.activeRoomDevices = info.devices || [];
      renderRoomInfoMembersAndDevices();
    } catch (_) {}
  }

  function renderRoomInfoMembersAndDevices() {
    var membersEl = document.getElementById("riMembersList");
    var devicesEl = document.getElementById("riDevicesList");
    var r = state.activeRoom;
    if (!membersEl || !devicesEl || !r) return;

    document.getElementById("riMembersHeader").textContent =
      "الأعضاء (" + state.activeRoomMembers.length + ")";

    membersEl.innerHTML = state.activeRoomMembers
      .map(function (m) {
        return (
          '<div class="result-row">' +
          buildAvatarHtml(m.displayName, m.avatarColor, 42, m.presence) +
          '<span class="meta">' +
          '<span class="dname">' +
          escapeHtml(m.displayName) +
          "</span>" +
          '<span class="handle">' +
          escapeHtml(m.publicHandle) +
          "</span>" +
          "</span>" +
          '<span class="chip">' +
          escapeHtml(m.roleLabel) +
          "</span>" +
          "</div>"
        );
      })
      .join("");

    document.getElementById("riDevicesHeader").textContent =
      "أجهزة التشفير والتحقق (" + state.activeRoomDevices.length + ")";

    if (state.activeRoomDevices.length === 0) {
      devicesEl.innerHTML = '<div class="empty-note">لا توجد أجهزة تشفير مسجلة بعد.</div>';
      return;
    }

    devicesEl.innerHTML = state.activeRoomDevices
      .map(function (dev) {
        var handle = window.RUN_CONFIG.toPublicHandle(dev.userId);
        var btnCls = dev.manuallyVerified ? "pill-btn ok" : "pill-btn ghost";
        var btnText = dev.manuallyVerified ? "موثّق ✓" : "توثيق الجهاز";
        return (
          '<div class="invite-box" style="margin:5px 20px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div style="min-width:0;flex:1">' +
          '<div style="font-size:13px;font-weight:600">' +
          escapeHtml(handle + " · " + dev.deviceId) +
          "</div>" +
          '<div style="font-size:11px;color:var(--app-ink-soft);direction:ltr;text-align:left;margin-top:2px">Ed25519: ' +
          escapeHtml(dev.formattedFingerprint) +
          "</div>" +
          "</div>" +
          '<button type="button" class="' +
          btnCls +
          '" data-verify-uid="' +
          escapeHtml(dev.userId) +
          '" data-verify-did="' +
          escapeHtml(dev.deviceId) +
          '" data-verify-curve="' +
          escapeHtml(dev.curve25519Key) +
          '">' +
          btnText +
          "</button>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    var verifyBtns = devicesEl.querySelectorAll("[data-verify-uid]");
    for (var i = 0; i < verifyBtns.length; i++) {
      verifyBtns[i].addEventListener("click", async function () {
        var uid = this.getAttribute("data-verify-uid");
        var did = this.getAttribute("data-verify-did");
        var curve = this.getAttribute("data-verify-curve");
        var target = state.activeRoomDevices.find(function (d) {
          return d.userId === uid && d.deviceId === did;
        });
        var nextVerified = target ? !target.manuallyVerified : true;
        window.RunCryptoEngine.setDeviceManuallyVerified(uid, did, nextVerified);
        if (target) target.manuallyVerified = nextVerified;
        renderRoomInfoMembersAndDevices();

        if (nextVerified && r.isEncrypted) {
          try {
            await window.RunMatrixClient.shareMegolmKeyWithAllRoomDevices(r.roomId, {
              forceDeviceKeys: [curve]
            });
            showToast("تم توثيق الجهاز " + did + " وإعادة مشاركة مفتاح Megolm معه", false);
          } catch (_) {}
        }
      });
    }
  }

  // =========================================================================
  // 5. SEARCH, FRIENDS, DIRECT CODE JOIN (Fix 3) & CREATE GROUP ROOM
  // =========================================================================

  function setSearchTab(tab) {
    state.searchTab = tab;
    document.getElementById("btnSearchTabFriends").classList.toggle("on", tab === "FRIENDS");
    document.getElementById("btnSearchTabRooms").classList.toggle("on", tab === "ROOMS");
    document.getElementById("searchPaneFriends").style.display = tab === "FRIENDS" ? "" : "none";
    document.getElementById("searchPaneRooms").style.display = tab === "ROOMS" ? "" : "none";
  }

  function updateDirectCodeJoinBox(rawQuery) {
    var box = document.getElementById("directCodeJoinBox");
    var valEl = document.getElementById("directCodeJoinValue");
    if (!box || !valEl) return;

    var trimmed = window.RUN_CONFIG.stripInvisibleAndTrim(rawQuery);
    var isJoinLink = /^run:\/\/join\//i.test(trimmed) || /^#\/join\//i.test(trimmed);
    var isRoomCode = window.RUN_CONFIG.looksLikeRoomCode(trimmed) || trimmed.startsWith("#");

    if (isJoinLink || isRoomCode) {
      var cleanCode = window.RUN_CONFIG.cleanRoomCodeOrIdInput(trimmed);
      box.style.display = "block";
      valEl.textContent = cleanCode.toUpperCase();
    } else {
      box.style.display = "none";
    }
  }

  async function runSearch(query) {
    var clean = window.RUN_CONFIG.stripInvisibleAndTrim(query);
    updateDirectCodeJoinBox(clean);

    if (/^run:\/\/join\//i.test(clean)) {
      var code = window.RUN_CONFIG.cleanRoomCodeOrIdInput(clean);
      if (code) {
        await joinRoomAndOpen(code, code);
        return;
      }
    }

    if (window.RUN_CONFIG.looksLikeRoomCode(clean) && state.searchTab !== "ROOMS") {
      setSearchTab("ROOMS");
    }

    var knownFriendsSet = new Set(
      state.friends.map(function (f) {
        return f.internalUserId;
      })
    );
    var outgoingSet = new Set(
      state.outgoingFriendInvites.map(function (o) {
        return o.internalUserId;
      })
    );
    var joinedRoomsSet = new Set(
      state.rooms.map(function (r) {
        return r.roomId;
      })
    );

    if (clean) {
      var resUsers = await window.RunMatrixClient.searchUsers(clean, knownFriendsSet, outgoingSet);
      var resRooms = await window.RunMatrixClient.searchPublicRooms(clean, joinedRoomsSet);
      state.friendSearchResults = resUsers;
      state.publicRoomResults = resRooms;
    } else {
      state.friendSearchResults = [];
      state.publicRoomResults = await window.RunMatrixClient.searchPublicRooms("", joinedRoomsSet);
    }
    renderSearchLists();
  }

  function renderSearchLists() {
    var friendResEl = document.getElementById("searchFriendsResults");
    var incomingEl = document.getElementById("searchIncomingInvites");
    var outgoingEl = document.getElementById("searchOutgoingInvites");
    var knownFriendsEl = document.getElementById("searchKnownFriends");
    var pubRoomsEl = document.getElementById("searchPublicRoomsResults");
    if (!friendResEl) return;

    if (state.account) {
      document.getElementById("myProfileInviteLink").textContent =
        window.RUN_CONFIG.buildFriendInviteLink(state.account.publicHandle);
    }

    // 1. Friend search results
    if (state.friendSearchResults.length === 0) {
      friendResEl.innerHTML =
        '<div class="empty-note">اكتب اسمًا ظاهرًا أو <span dir="ltr">@username</span> في شريط البحث للعثور على أصدقاء.</div>';
    } else {
      friendResEl.innerHTML = state.friendSearchResults
        .map(function (u) {
          var actionBtn =
            u.relationState === "FRIEND"
              ? '<button type="button" class="pill-btn ghost" data-open-dm="' +
                escapeHtml(u.internalUserId) +
                '" data-dm-name="' +
                escapeHtml(u.displayName) +
                '">مراسلة</button>'
              : u.relationState === "OUTGOING_PENDING"
              ? '<button type="button" class="pill-btn ghost" disabled>تم الإرسال</button>'
              : '<button type="button" class="pill-btn" data-add-friend="' +
                escapeHtml(u.internalUserId) +
                '" data-friend-name="' +
                escapeHtml(u.displayName) +
                '">+ إضافة</button>';

          return (
            '<div class="result-row">' +
            buildAvatarHtml(u.displayName, u.avatarColor, 46, u.presence) +
            '<span class="meta">' +
            '<span class="dname">' +
            escapeHtml(u.displayName) +
            "</span>" +
            '<span class="handle">' +
            escapeHtml(u.publicHandle) +
            "</span>" +
            '<span class="sub">' +
            escapeHtml(u.statusText) +
            "</span>" +
            "</span>" +
            actionBtn +
            "</div>"
          );
        })
        .join("");
    }

    // 2. Incoming Invites
    if (state.incomingFriendInvites.length === 0) {
      incomingEl.innerHTML = '<div class="empty-note">لا توجد طلبات صداقة أو دعوات واردة حاليًا.</div>';
    } else {
      incomingEl.innerHTML = state.incomingFriendInvites
        .map(function (req) {
          return (
            '<div class="result-row">' +
            buildAvatarHtml(req.displayName, req.avatarColor, 44, req.presence) +
            '<span class="meta">' +
            '<span class="dname">' +
            escapeHtml(req.displayName) +
            "</span>" +
            '<span class="handle">' +
            escapeHtml(req.publicHandle) +
            "</span>" +
            "</span>" +
            '<button type="button" class="pill-btn" data-accept-room="' +
            escapeHtml(req.roomId) +
            '">قبول</button>' +
            '<button type="button" class="pill-btn ghost" data-decline-room="' +
            escapeHtml(req.roomId) +
            '">رفض</button>' +
            "</div>"
          );
        })
        .join("");
    }

    // 3. Outgoing Invites
    if (state.outgoingFriendInvites.length === 0) {
      outgoingEl.innerHTML = '<div class="empty-note">لا توجد طلبات صداقة قيد الانتظار.</div>';
    } else {
      outgoingEl.innerHTML = state.outgoingFriendInvites
        .map(function (req) {
          return (
            '<div class="result-row">' +
            buildAvatarHtml(req.displayName, req.avatarColor, 42, req.presence) +
            '<span class="meta">' +
            '<span class="dname">' +
            escapeHtml(req.displayName) +
            "</span>" +
            '<span class="handle">' +
            escapeHtml(req.publicHandle) +
            "</span>" +
            "</span>" +
            '<span class="chip">بانتظار القبول</span>' +
            "</div>"
          );
        })
        .join("");
    }

    // 4. Friends list
    if (state.friends.length === 0) {
      knownFriendsEl.innerHTML = '<div class="empty-note">لا يوجد أصدقاء مضافون بعد.</div>';
    } else {
      knownFriendsEl.innerHTML = state.friends
        .map(function (f) {
          return (
            '<button type="button" class="result-row" data-open-dm="' +
            escapeHtml(f.internalUserId) +
            '" data-dm-name="' +
            escapeHtml(f.displayName) +
            '">' +
            buildAvatarHtml(f.displayName, f.avatarColor, 46, f.presence) +
            '<span class="meta">' +
            '<span class="dname">' +
            escapeHtml(f.displayName) +
            "</span>" +
            '<span class="handle">' +
            escapeHtml(f.publicHandle) +
            "</span>" +
            '<span class="sub">' +
            escapeHtml(f.statusText) +
            "</span>" +
            "</span>" +
            '<span class="chip">محادثة ←</span>' +
            "</button>"
          );
        })
        .join("");
    }

    // 5. Public Rooms results
    if (state.publicRoomResults.length === 0) {
      pubRoomsEl.innerHTML = '<div class="empty-note">لا توجد غرف عامة مطابقة.</div>';
    } else {
      pubRoomsEl.innerHTML = state.publicRoomResults
        .map(function (r) {
          var btnHtml = r.isJoined
            ? '<button type="button" class="pill-btn ghost" data-join-room="' +
              escapeHtml(r.roomId) +
              '" data-join-code="' +
              escapeHtml(r.roomCode) +
              '" data-join-name="' +
              escapeHtml(r.name) +
              '">فتح</button>'
            : '<button type="button" class="pill-btn" data-join-room="' +
              escapeHtml(r.roomId) +
              '" data-join-code="' +
              escapeHtml(r.roomCode) +
              '" data-join-name="' +
              escapeHtml(r.name) +
              '">انضمام</button>';
          return (
            '<div class="result-row">' +
            buildAvatarHtml(r.name, r.avatarColor, 46, null) +
            '<span class="meta">' +
            '<span class="dname">' +
            escapeHtml(r.name) +
            "</span>" +
            '<span class="sub">' +
            r.memberCount +
            ' عضوًا · الكود <span dir="ltr">' +
            escapeHtml(r.roomCode) +
            "</span></span>" +
            "</span>" +
            btnHtml +
            "</div>"
          );
        })
        .join("");
    }

    // Bind events
    var addBtns = document.querySelectorAll("[data-add-friend]");
    for (var a = 0; a < addBtns.length; a++) {
      addBtns[a].addEventListener("click", async function () {
        var uid = this.getAttribute("data-add-friend");
        var dName = this.getAttribute("data-friend-name");
        this.disabled = true;
        this.textContent = "جاري الإرسال…";
        try {
          await window.RunMatrixClient.createOrOpenDirectChat(uid);
          showToast("تم إرسال طلب الصداقة المشفر إلى " + dName, false);
          runSearch(document.getElementById("inpSearchQuery").value);
        } catch (err) {
          showToast(err.message || "تعذر إرسال طلب الصداقة", true);
          this.disabled = false;
          this.textContent = "+ إضافة";
        }
      });
    }

    var dmBtns = document.querySelectorAll("[data-open-dm]");
    for (var d = 0; d < dmBtns.length; d++) {
      dmBtns[d].addEventListener("click", function () {
        var uid = this.getAttribute("data-open-dm");
        var dName = this.getAttribute("data-dm-name");
        openOrStartDirectChat(uid, dName);
      });
    }

    var accBtns = document.querySelectorAll("[data-accept-room]");
    for (var c = 0; c < accBtns.length; c++) {
      accBtns[c].addEventListener("click", function () {
        joinRoomAndOpen(this.getAttribute("data-accept-room"), "");
      });
    }

    var decBtns = document.querySelectorAll("[data-decline-room]");
    for (var k = 0; k < decBtns.length; k++) {
      decBtns[k].addEventListener("click", async function () {
        var rId = this.getAttribute("data-decline-room");
        try {
          await window.RunMatrixClient.leaveOrDeclineRoom(rId);
          state.incomingFriendInvites = state.incomingFriendInvites.filter(function (x) {
            return x.roomId !== rId;
          });
          renderSearchLists();
        } catch (_) {}
      });
    }

    var joinBtns = document.querySelectorAll("[data-join-room]");
    for (var j = 0; j < joinBtns.length; j++) {
      joinBtns[j].addEventListener("click", function () {
        var roomIdAttr = this.getAttribute("data-join-room");
        var roomCodeAttr = this.getAttribute("data-join-code");
        var roomNameAttr = this.getAttribute("data-join-name");
        joinRoomAndOpen(roomIdAttr, roomCodeAttr, roomNameAttr);
      });
    }
  }

  async function openOrStartDirectChat(handleOrUserId, displayName) {
    var internalId = window.RUN_CONFIG.toInternalUserId(handleOrUserId);
    var existing = state.rooms.find(function (r) {
      return (
        r.directPeerUserId === internalId ||
        r.roomCode.toLowerCase() === window.RUN_CONFIG.toPublicHandle(internalId).toLowerCase()
      );
    });
    if (existing) {
      openRoomChat(existing);
      return;
    }

    try {
      var roomId = await window.RunMatrixClient.createOrOpenDirectChat(internalId);
      var isEnc = window.RunMatrixClient.isRoomCurrentlyEncrypted(roomId);
      var summary = {
        roomId: roomId,
        name: displayName || window.RUN_CONFIG.toPublicHandle(internalId).replace(/^@/, ""),
        topic: "",
        roomCode: window.RUN_CONFIG.toPublicHandle(internalId),
        isDirect: true,
        directPeerUserId: internalId,
        memberCount: 2,
        lastMessageSender: null,
        lastMessageBody: isEnc ? "محادثة خاصة مشفرة" : "محادثة خاصة (غير مشفرة)",
        lastMessageTimestamp: Date.now(),
        unreadCount: 0,
        isEncrypted: isEnc,
        encryptionStatusNote: isEnc ? null : "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة",
        avatarColor: window.RUN_CONFIG.avatarColorFor(internalId),
        peerPresence: "online"
      };
      state.rooms.unshift(summary);
      window.RunMatrixClient.savePersistedRoomsList(state.rooms);
      renderRoomsList();
      openRoomChat(summary);
    } catch (err) {
      showToast(err.message || "تعذر فتح المحادثة", true);
    }
  }

  async function joinRoomAndOpen(codeOrRoomId, optionalFallbackCode, optionalKnownName) {
    try {
      var joinedRoomId = await window.RunMatrixClient.joinRoomByCodeOrId(
        codeOrRoomId,
        optionalFallbackCode
      );
      var existing = state.rooms.find(function (r) {
        return r.roomId === joinedRoomId;
      });
      var resolvedCode =
        window.RunMatrixClient.getCachedRoomCode(joinedRoomId) ||
        window.RUN_CONFIG.toPublicRoomCode(optionalFallbackCode || codeOrRoomId);
      var resolvedName =
        optionalKnownName ||
        window.RunMatrixClient.getCachedRoomName(joinedRoomId) ||
        resolvedCode ||
        "غرفة Run";
      var isEnc = window.RunMatrixClient.isRoomCurrentlyEncrypted(joinedRoomId);
      var summary =
        existing || {
          roomId: joinedRoomId,
          name: resolvedName,
          topic: "",
          roomCode: resolvedCode,
          isDirect: false,
          directPeerUserId: null,
          memberCount: 2,
          lastMessageSender: null,
          lastMessageBody: "انضممت إلى الغرفة",
          lastMessageTimestamp: Date.now(),
          unreadCount: 0,
          isEncrypted: isEnc,
          encryptionStatusNote: isEnc ? null : "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة",
          avatarColor: window.RUN_CONFIG.avatarColorFor(joinedRoomId),
          peerPresence: "offline"
        };
      if (!existing) {
        state.rooms.unshift(summary);
        window.RunMatrixClient.savePersistedRoomsList(state.rooms);
        renderRoomsList();
      }
      openRoomChat(summary);
    } catch (err) {
      console.error("[RunJoin] joinRoomAndOpen failed:", err && err.name, err && err.message);
      showToast(err.message || "تعذر الانضمام إلى الغرفة", true);
    }
  }

  function renderCreateRoomMembersPicker() {
    var chipsEl = document.getElementById("createRoomPickedChips");
    var listEl = document.getElementById("createRoomCandidateMembers");
    if (!chipsEl || !listEl) return;

    var pickedHandles = Object.keys(state.pickedCreateMembers);
    chipsEl.innerHTML = pickedHandles
      .map(function (h) {
        var m = state.pickedCreateMembers[h];
        return (
          '<span class="chip">' +
          escapeHtml(m.displayName) +
          ' <button type="button" data-unpick="' +
          escapeHtml(h) +
          '" style="border:none;background:none;color:inherit;padding:0 3px">✕</button></span>'
        );
      })
      .join("");

    var unpickBtns = chipsEl.querySelectorAll("[data-unpick]");
    for (var i = 0; i < unpickBtns.length; i++) {
      unpickBtns[i].addEventListener("click", function () {
        var h = this.getAttribute("data-unpick");
        delete state.pickedCreateMembers[h];
        renderCreateRoomMembersPicker();
      });
    }

    var pool = state.createMemberCandidates.length > 0 ? state.createMemberCandidates : state.friends;
    if (pool.length === 0) {
      listEl.innerHTML =
        '<div class="empty-note" style="padding:8px 0">ابحث بالاسم أو <span dir="ltr">@username</span> لإضافة أعضاء إلى الغرفة.</div>';
      return;
    }

    listEl.innerHTML = pool
      .map(function (u) {
        var picked = Boolean(state.pickedCreateMembers[u.publicHandle]);
        return (
          '<button type="button" class="result-row" style="padding:8px 0" data-toggle-pick="' +
          escapeHtml(u.publicHandle) +
          '">' +
          buildAvatarHtml(u.displayName, u.avatarColor, 40, u.presence) +
          '<span class="meta">' +
          '<span class="dname">' +
          escapeHtml(u.displayName) +
          "</span>" +
          '<span class="handle">' +
          escapeHtml(u.publicHandle) +
          "</span>" +
          "</span>" +
          '<span class="chip ' +
          (picked ? "ok" : "") +
          '">' +
          (picked ? "تم الاختيار ✓" : "+ اختيار") +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    var toggleBtns = listEl.querySelectorAll("[data-toggle-pick]");
    for (var j = 0; j < toggleBtns.length; j++) {
      toggleBtns[j].addEventListener("click", function () {
        var h = this.getAttribute("data-toggle-pick");
        var userObj = pool.find(function (x) {
          return x.publicHandle === h;
        });
        if (!userObj) return;
        if (state.pickedCreateMembers[h]) {
          delete state.pickedCreateMembers[h];
        } else {
          state.pickedCreateMembers[h] = userObj;
        }
        renderCreateRoomMembersPicker();
      });
    }
  }

  async function onConfirmCreateRoom() {
    var name = document.getElementById("inpNewRoomName").value.trim();
    var topic = document.getElementById("inpNewRoomTopic").value.trim();
    var btn = document.getElementById("btnConfirmCreateRoom");
    if (!name) {
      showToast("يرجى إدخال اسم الغرفة", true);
      return;
    }

    btn.disabled = true;
    btn.textContent = "جاري إنشاء الغرفة المشفرة…";
    try {
      var handles = Object.keys(state.pickedCreateMembers);
      var newRoom = await window.RunMatrixClient.createGroupRoom(name, topic, handles);
      document.getElementById("inpNewRoomName").value = "";
      document.getElementById("inpNewRoomTopic").value = "";
      state.pickedCreateMembers = {};
      state.rooms.unshift(newRoom);
      state.activeRoom = newRoom;
      window.RunMatrixClient.savePersistedRoomsList(state.rooms);
      renderRoomsList();
      showToast("تم إنشاء الغرفة بنجاح · الكود " + newRoom.roomCode, false);
      openRoomInfoScreen();
    } catch (err) {
      showToast(err.message || "تعذر إنشاء الغرفة", true);
    } finally {
      btn.disabled = false;
      btn.textContent = "إنشاء الغرفة";
    }
  }

  // =========================================================================
  // 6. WEBRTC 1-TO-1 VIDEO & VOICE CALLS + SEPARATE ERROR HANDLING (Fix 2)
  // =========================================================================

  window.RunWebRtcManager.configureCallbacks({
    onLocalCandidates: function (candidates) {
      var c = state.activeCall;
      if (c.callId && c.roomId) {
        window.RunMatrixClient.sendCallCandidates(c.roomId, c.callId, candidates).catch(
          function () {}
        );
      }
    },
    onConnected: function () {
      state.activeCall.phase = "CONNECTED";
      updateActiveCallUi();
      startCallTimer();
    },
    onEnded: function () {
      endActiveCall(false);
    }
  });

  async function checkTurnStatusAfterLogin() {
    var banner = document.getElementById("turnStatusBanner");
    try {
      var creds = await window.RunMatrixClient.fetchTurnCredentials();
      if (creds.hasValidTurnServers) {
        state.turnStatusMessage =
          "خادم TURN مفعّل للمكالمات (" + creds.uris.length + " عنوان)";
      } else {
        state.turnStatusMessage =
          "تنبيه صادق: السيرفر لا يوفر بيانات TURN عبر /v3/voip/turnServer حاليًا (تعتمد المكالمات على اتصال STUN المباشر)";
      }
    } catch (err) {
      console.warn("[RunCall/TURNCheck]", err && err.name, err && err.message);
      state.turnStatusMessage =
        "تنبيه صادق: السيرفر لم يُرجع بيانات TURN عبر /v3/voip/turnServer (تعتمد المكالمات على اتصال STUN المباشر)";
    }
    if (banner) {
      banner.textContent = state.turnStatusMessage;
    }
  }

  async function startCallInActiveRoom(isVideoRequested) {
    var r = state.activeRoom;
    if (!r) {
      showToast("اختر غرفة أو محادثة أولاً لبدء المكالمة", true);
      return;
    }
    var effectiveVideo = Boolean(isVideoRequested && state.callQuality !== "AUDIO_ONLY");
    var callId = "runweb_call_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);

    state.activeCall = {
      phase: "OUTGOING_RINGING",
      callId: callId,
      roomId: r.roomId,
      peerName: r.name,
      isVideo: effectiveVideo,
      durationSeconds: 0,
      isMicMuted: false,
      isCameraEnabled: effectiveVideo,
      isSpeakerOn: true,
      remoteOfferSdp: null,
      avatarColor: r.avatarColor
    };

    updateActiveCallUi();
    showScreen("call");

    // Step 1: Fetch TURN credentials (non-blocking if TURN fails; warn and continue with P2P)
    var turnCreds = null;
    try {
      turnCreds = await window.RunMatrixClient.fetchTurnCredentials();
    } catch (turnErr) {
      console.warn("[RunCall/TURN] Failed to fetch TURN credentials:", turnErr && turnErr.name, turnErr && turnErr.message);
      if (turnErr && turnErr.isNetworkError) {
        console.error("[RunCall/Network] Cannot start call while offline:", turnErr.name, turnErr.message);
        showToast("تعذر إرسال دعوة المكالمة — تحقق من الاتصال بالإنترنت", true);
        endActiveCall(false);
        return;
      }
      showToast("تنبيه: تعذر جلب بيانات TURN — جاري المتابعة باتصال مباشر P2P", false);
    }

    // Step 2: Acquire local microphone/camera & create WebRTC SDP offer
    var offerSdp = null;
    try {
      offerSdp = await window.RunWebRtcManager.startOutgoingCall({
        turnCredentials: turnCreds,
        qualityMode: state.callQuality,
        requestedVideo: effectiveVideo,
        localVideoEl: document.getElementById("localVideo"),
        remoteVideoEl: document.getElementById("remoteVideo")
      });
    } catch (mediaOrRtcErr) {
      console.error(
        "[RunCall/MediaOrWebRTC] Failed to initialize local media or SDP offer:",
        (mediaOrRtcErr && (mediaOrRtcErr.causeName || mediaOrRtcErr.name)) || "Error",
        mediaOrRtcErr && (mediaOrRtcErr.causeMessage || mediaOrRtcErr.message)
      );
      showToast(
        (mediaOrRtcErr && mediaOrRtcErr.message) ||
          "تعذر تجهيز الوسائط للمكالمة",
        true
      );
      endActiveCall(false);
      return;
    }

    // Step 3: Send `m.call.invite` signaling event to the room
    try {
      await window.RunMatrixClient.sendCallInvite(r.roomId, callId, offerSdp);
    } catch (inviteErr) {
      console.error(
        "[RunCall/SendInvite] Failed to send m.call.invite:",
        inviteErr && inviteErr.name,
        inviteErr && inviteErr.message
      );
      showToast(
        "تعذر إرسال دعوة المكالمة — تحقق من الاتصال (" +
          ((inviteErr && inviteErr.message) || "خطأ في الشبكة") +
          ")",
        true
      );
      endActiveCall(false);
    }
  }

  async function acceptIncomingCall() {
    var c = state.activeCall;
    if (!c.remoteOfferSdp) return;
    var effectiveVideo = Boolean(c.isVideo && state.callQuality !== "AUDIO_ONLY");
    c.phase = "CONNECTING";
    c.isVideo = effectiveVideo;
    c.isCameraEnabled = effectiveVideo;
    updateActiveCallUi();

    var turnCreds = null;
    try {
      turnCreds = await window.RunMatrixClient.fetchTurnCredentials();
    } catch (turnErr) {
      console.warn("[RunCall/TURN] Answer TURN fetch warning:", turnErr && turnErr.name, turnErr && turnErr.message);
    }

    var answerSdp = null;
    try {
      answerSdp = await window.RunWebRtcManager.answerIncomingCall({
        offerSdp: c.remoteOfferSdp,
        turnCredentials: turnCreds,
        qualityMode: state.callQuality,
        requestedVideo: effectiveVideo,
        localVideoEl: document.getElementById("localVideo"),
        remoteVideoEl: document.getElementById("remoteVideo")
      });
    } catch (mediaOrRtcErr) {
      console.error(
        "[RunCall/AnswerMedia] Failed to answer call:",
        (mediaOrRtcErr && (mediaOrRtcErr.causeName || mediaOrRtcErr.name)) || "Error",
        mediaOrRtcErr && (mediaOrRtcErr.causeMessage || mediaOrRtcErr.message)
      );
      showToast(
        (mediaOrRtcErr && mediaOrRtcErr.message) || "تعذر تشغيل الميكروفون/الكاميرا للرد على المكالمة",
        true
      );
      endActiveCall(true);
      return;
    }

    try {
      await window.RunMatrixClient.sendCallAnswer(c.roomId, c.callId, answerSdp);
    } catch (ansErr) {
      console.error(
        "[RunCall/SendAnswer] Failed to send m.call.answer:",
        ansErr && ansErr.name,
        ansErr && ansErr.message
      );
      showToast(
        "تعذر إرسال رد المكالمة — تحقق من الاتصال (" +
          ((ansErr && ansErr.message) || "خطأ في الشبكة") +
          ")",
        true
      );
      endActiveCall(true);
    }
  }

  function handleSignalingEvent(ev) {
    var c = state.activeCall;
    if (ev.type === "m.call.invite") {
      if (c.phase !== "IDLE") return;
      var room = state.rooms.find(function (r) {
        return r.roomId === ev.roomId;
      });
      var peerHandle = window.RUN_CONFIG.toPublicHandle(ev.senderUserId);
      state.activeCall = {
        phase: "INCOMING_RINGING",
        callId: ev.callId,
        roomId: ev.roomId,
        peerName: (room && room.name) || peerHandle.replace(/^@/, ""),
        isVideo: ev.isVideo,
        durationSeconds: 0,
        isMicMuted: false,
        isCameraEnabled: ev.isVideo,
        isSpeakerOn: true,
        remoteOfferSdp: ev.sdp,
        avatarColor: window.RUN_CONFIG.avatarColorFor(ev.senderUserId)
      };
      updateActiveCallUi();
      showScreen("call");
    } else if (ev.type === "m.call.answer") {
      if (c.callId === ev.callId && ev.sdp) {
        window.RunWebRtcManager.onRemoteAnswerReceived(ev.sdp);
      }
    } else if (ev.type === "m.call.candidates") {
      if (c.callId === ev.callId && ev.candidates) {
        window.RunWebRtcManager.onRemoteIceCandidatesReceived(ev.candidates);
      }
    } else if (ev.type === "m.call.hangup") {
      if (c.callId === ev.callId) {
        endActiveCall(false);
      }
    }
  }

  function startCallTimer() {
    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(function () {
      if (state.activeCall.phase !== "CONNECTED") return;
      state.activeCall.durationSeconds += 1;
      updateActiveCallUi();
    }, 1000);
  }

  function endActiveCall(sendRemoteHangup) {
    var c = state.activeCall;
    if (c.phase === "IDLE") return;
    clearInterval(callTimerInterval);

    window.RunWebRtcManager.endCall(
      document.getElementById("localVideo"),
      document.getElementById("remoteVideo")
    );

    if (sendRemoteHangup && c.roomId && c.callId) {
      window.RunMatrixClient.sendCallHangup(c.roomId, c.callId).catch(function () {});
    }

    var logEntry = {
      id: c.callId || "log_" + Date.now(),
      roomId: c.roomId,
      peerName: c.peerName || "مكالمة Run",
      isVideo: c.isVideo,
      direction:
        c.phase === "INCOMING_RINGING" && !sendRemoteHangup
          ? "MISSED"
          : c.remoteOfferSdp
          ? "INCOMING"
          : "OUTGOING",
      durationSeconds: c.durationSeconds || 0,
      timestamp: Date.now(),
      avatarColor: c.avatarColor || "#8a6d3b"
    };
    state.callLogs.unshift(logEntry);
    state.callLogs = state.callLogs.slice(0, 50);
    try {
      localStorage.setItem("run_v2_web_call_logs", JSON.stringify(state.callLogs));
    } catch (_) {}

    state.activeCall = { phase: "IDLE" };
    renderCallsHistory();
    showScreen(state.activeRoom ? "chat" : "rooms");
  }

  function updateActiveCallUi() {
    var c = state.activeCall;
    document.getElementById("activeCallPeerName").textContent = c.peerName || "مكالمة Run";
    var av = document.getElementById("activeCallAvatar");
    av.textContent = (c.peerName || "R").trim().charAt(0).toUpperCase() || "R";
    av.style.background = c.avatarColor || "#8a6d3b";

    var statusText = "";
    if (c.phase === "OUTGOING_RINGING") statusText = "جاري الاتصال…";
    else if (c.phase === "INCOMING_RINGING")
      statusText = c.isVideo ? "مكالمة فيديو واردة…" : "مكالمة صوتية واردة…";
    else if (c.phase === "CONNECTING") statusText = "جاري ربط الاتصال…";
    else if (c.phase === "CONNECTED")
      statusText =
        (c.isVideo ? "مكالمة فيديو · " : "مكالمة صوتية · ") + formatDuration(c.durationSeconds);

    document.getElementById("activeCallStatusText").textContent = statusText;
    document.getElementById("callControlsIncoming").style.display =
      c.phase === "INCOMING_RINGING" ? "flex" : "none";
    document.getElementById("callControlsActive").style.display =
      c.phase === "INCOMING_RINGING" ? "none" : "flex";
    document.getElementById("localVideo").style.display =
      c.isVideo && c.isCameraEnabled ? "block" : "none";

    document.getElementById("btnToggleMic").classList.toggle("off", Boolean(c.isMicMuted));
    document.getElementById("btnToggleCam").classList.toggle("off", !c.isCameraEnabled);
    document.getElementById("btnToggleSpk").classList.toggle("off", !c.isSpeakerOn);
  }

  function renderCallsHistory() {
    var container = document.getElementById("callsHistoryList");
    var sub = document.getElementById("callsSubtitle");
    if (sub) {
      var qLabel =
        state.callQuality === "DATA_SAVER"
          ? "توفير البيانات 240p"
          : state.callQuality === "AUDIO_ONLY"
          ? "صوت فقط"
          : "480p قياسي (افتراضي)";
      sub.textContent = "مكالمات صوت وفيديو 1-إلى-1 حقيقية · الجودة الحالية: " + qLabel;
    }
    if (!container) return;

    if (state.callLogs.length === 0) {
      container.innerHTML =
        '<div class="empty-note">لا توجد مكالمات مسجلة بعد — افتح أي محادثة واضغط زر المكالمة الصوتية أو الفيديو للاتصال.</div>';
      return;
    }

    container.innerHTML = state.callLogs
      .map(function (log) {
        var dirLabel =
          log.direction === "INCOMING"
            ? "واردة"
            : log.direction === "MISSED"
            ? "فائتة"
            : "صادرة";
        var typeLabel = log.isVideo ? "فيديو" : "صوتية";
        var durLabel = log.durationSeconds > 0 ? " · " + formatDuration(log.durationSeconds) : "";
        return (
          '<button type="button" class="result-row" data-call-again-room="' +
          escapeHtml(log.roomId) +
          '" data-call-video="' +
          (log.isVideo ? "1" : "0") +
          '">' +
          buildAvatarHtml(log.peerName, log.avatarColor, 46, null) +
          '<span class="meta">' +
          '<span class="dname">' +
          escapeHtml(log.peerName) +
          "</span>" +
          '<span class="sub" style="' +
          (log.direction === "MISSED" ? "color:var(--danger)" : "") +
          '">' +
          typeLabel +
          " " +
          dirLabel +
          durLabel +
          "</span>" +
          "</span>" +
          '<span style="font-size:11px;color:var(--app-ink-soft)">' +
          formatShortTime(log.timestamp) +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    var btns = container.querySelectorAll("[data-call-again-room]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var rId = this.getAttribute("data-call-again-room");
        var isVid = this.getAttribute("data-call-video") === "1";
        var room = state.rooms.find(function (r) {
          return r.roomId === rId;
        });
        if (room) {
          state.activeRoom = room;
          startCallInActiveRoom(isVid);
        }
      });
    }
  }

  // =========================================================================
  // 7. ACCOUNT SCREEN & DEEP LINKS
  // =========================================================================

  function renderAccountScreen() {
    var acc = state.account;
    if (!acc) return;
    document.getElementById("accountDisplayName").textContent = acc.displayName;
    document.getElementById("accountPublicHandle").textContent = acc.publicHandle;
    var av = document.getElementById("accountAvatar");
    av.textContent = acc.displayName.trim().charAt(0).toUpperCase() || "R";
    document.getElementById("accountDeviceIdLabel").textContent =
      "بصمة مفتاح التشفير لهذا الجهاز (Ed25519) · المعرف: " + acc.deviceId;
    document.getElementById("accountDeviceFingerprint").textContent =
      acc.deviceEd25519Fingerprint || "جاري التحميل…";
    document.getElementById("accountPinStatusDesc").textContent = acc.isPinConfigured
      ? "مفعّل · اضغط لتحديث رمز PIN والنسخة المشفرة لمفاتيح الغرف"
      : "غير مفعّل بعد · أنشئ رمز PIN لحفظ نسخة مفاتيح التشفير المشفرة";
  }

  function renderQualityButtons() {
    var q = state.callQuality;
    var b480 = document.getElementById("btnQuality480p");
    var b240 = document.getElementById("btnQuality240p");
    var bAud = document.getElementById("btnQualityAudio");
    if (b480 && b240 && bAud) {
      b480.classList.toggle("ghost", q !== "DEFAULT_480P");
      b240.classList.toggle("ghost", q !== "DATA_SAVER");
      bAud.classList.toggle("ghost", q !== "AUDIO_ONLY");
    }
    renderCallsHistory();
  }

  function handleUrlDeepLinkIfAny() {
    var hash = window.location.hash || "";
    var searchParams = new URLSearchParams(window.location.search || "");
    var joinCode = searchParams.get("join") || "";
    var friendHandle = searchParams.get("friend") || "";

    if (hash.startsWith("#/join/")) {
      joinCode = decodeURIComponent(hash.slice(7));
    } else if (hash.startsWith("#/friend/")) {
      friendHandle = decodeURIComponent(hash.slice(9));
    }

    if (joinCode) {
      joinRoomAndOpen(joinCode, joinCode);
    } else if (friendHandle) {
      openOrStartDirectChat(friendHandle, friendHandle.replace(/^@/, ""));
    }
  }

  // =========================================================================
  // EVENT LISTENERS WIRING
  // =========================================================================

  function bindAllEvents() {
    document.getElementById("btnCloseToast").addEventListener("click", function () {
      document.getElementById("statusToast").classList.add("hidden");
    });

    // Sync Retry Button (Fix 1.3)
    document
      .getElementById("btnRetrySyncNow")
      .addEventListener("click", triggerImmediateSyncRetry);

    // Responsive resize handler (Fix 2: keep desktop two-pane conversation populated)
    window.addEventListener("resize", function () {
      ensureDesktopActiveRoomSelected();
      var isAuthFlow =
        state.currentScreen === "login" ||
        state.currentScreen === "pin" ||
        state.currentScreen === "restored";
      if (!isAuthFlow) {
        updateChatHeader();
        renderChatMessages();
      }
    });

    // Auth & UIAA Registration
    document.getElementById("tabModeLogin").addEventListener("click", function () {
      setAuthMode("login");
    });
    document.getElementById("tabModeRegister").addEventListener("click", function () {
      setAuthMode("register");
    });
    document.getElementById("inpAuthUser").addEventListener("input", function () {
      var clean = window.RUN_CONFIG.toLocalpart(this.value);
      document.getElementById("handlePreview").textContent = "@" + (clean || "username");
    });
    document.getElementById("btnSubmitAuth").addEventListener("click", onSubmitAuthClick);
    document.getElementById("inpAuthPass").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && state.authMode === "login") onSubmitAuthClick();
    });
    document
      .getElementById("btnConfirmEmailStage")
      .addEventListener("click", onConfirmEmailStageClick);
    document
      .getElementById("btnResendEmailStage")
      .addEventListener("click", onResendEmailStageClick);
    document.getElementById("btnAcceptTermsStage").addEventListener("click", function () {
      submitCurrentUiaaAuth({
        type: "m.login.terms",
        session: state.uiaa.session
      });
    });

    // PIN Keypad
    document.getElementById("pinPad").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-d]");
      if (b) onPinDigitPress(b.getAttribute("data-d"));
    });
    document.getElementById("btnPinBackspace").addEventListener("click", function () {
      if (state.pinCurrentValue.length > 0) {
        state.pinCurrentValue = state.pinCurrentValue.slice(0, -1);
        updatePinUi(false, "");
      }
    });
    document.getElementById("btnPinSkip").addEventListener("click", function () {
      showScreen("rooms");
      handleUrlDeepLinkIfAny();
    });
    document.getElementById("btnOpenRoomsAfterRestore").addEventListener("click", function () {
      showScreen("rooms");
      handleUrlDeepLinkIfAny();
    });

    // Bottom Navigation Tabs
    var mainTabs = document.querySelectorAll("[data-main-tab]");
    for (var i = 0; i < mainTabs.length; i++) {
      mainTabs[i].addEventListener("click", function () {
        var target = this.getAttribute("data-main-tab");
        showScreen(target);
      });
    }

    // Rooms Screen
    document.getElementById("btnOpenCreateRoom").addEventListener("click", function () {
      renderCreateRoomMembersPicker();
      showScreen("create");
    });
    document.getElementById("btnSpaceNewRoom").addEventListener("click", function () {
      renderCreateRoomMembersPicker();
      showScreen("create");
    });
    document.getElementById("btnOpenSearchFromRooms").addEventListener("click", function () {
      showScreen("search");
      runSearch(document.getElementById("inpSearchQuery").value);
    });

    var filterOrbs = document.querySelectorAll(".space[data-filter]");
    for (var f = 0; f < filterOrbs.length; f++) {
      filterOrbs[f].addEventListener("click", function () {
        for (var k = 0; k < filterOrbs.length; k++) {
          filterOrbs[k].classList.remove("sel");
        }
        this.classList.add("sel");
        state.spaceFilter = this.getAttribute("data-filter");
        renderRoomsList();
      });
    }

    // Chat Screen
    document.getElementById("btnChatBack").addEventListener("click", function () {
      showScreen("rooms");
    });
    document
      .getElementById("btnOpenRoomInfoFromHeader")
      .addEventListener("click", openRoomInfoScreen);
    document.getElementById("btnOpenRoomInfo").addEventListener("click", openRoomInfoScreen);
    document.getElementById("btnSendMessage").addEventListener("click", onSendChatMessage);
    document.getElementById("inpChatMessage").addEventListener("keydown", function (e) {
      if (e.key === "Enter") onSendChatMessage();
    });
    document.getElementById("btnStartVoiceCall").addEventListener("click", function () {
      startCallInActiveRoom(false);
    });
    document.getElementById("btnStartVideoCall").addEventListener("click", function () {
      startCallInActiveRoom(true);
    });

    // Room Info Screen
    document.getElementById("btnRoomInfoBack").addEventListener("click", function () {
      showScreen("chat");
    });
    document.getElementById("btnCopyRoomLink").addEventListener("click", function () {
      copyToClipboard(document.getElementById("riInviteLink").textContent, this);
    });
    document.getElementById("btnCopyRoomCode").addEventListener("click", function () {
      copyToClipboard(document.getElementById("riRoomCode").textContent, this);
    });
    document.getElementById("btnShareRoomInvite").addEventListener("click", function () {
      var link = document.getElementById("riInviteLink").textContent;
      var code = document.getElementById("riRoomCode").textContent;
      var roomName = (state.activeRoom && state.activeRoom.name) || "Run";
      var shareText =
        'انضم إلى غرفة "' + roomName + '" في تطبيق Run:\nالرابط: ' + link + "\nالكود: " + code;
      if (navigator.share) {
        navigator.share({ title: "دعوة Run", text: shareText }).catch(function () {});
      } else {
        copyToClipboard(shareText, this);
        showToast("تم نسخ نص الدعوة لمشاركته", false);
      }
    });
    document
      .getElementById("btnReshareRoomKeysNow")
      .addEventListener("click", async function () {
        if (!state.activeRoom) return;
        this.disabled = true;
        try {
          window.RunCryptoEngine.clearSharedSessionCacheForRoom(state.activeRoom.roomId);
          await window.RunMatrixClient.shareMegolmKeyWithAllRoomDevices(state.activeRoom.roomId, {});
          showToast("تمت إعادة مشاركة مفتاح Megolm مع جميع أجهزة الغرفة بنجاح", false);
        } catch (err) {
          showToast(err.message || "تعذر مشاركة المفتاح", true);
        } finally {
          this.disabled = false;
        }
      });

    // Search Screen & Direct Code Join (Fix 3)
    document.getElementById("btnSearchBack").addEventListener("click", function () {
      showScreen("rooms");
    });
    document.getElementById("btnSearchTabFriends").addEventListener("click", function () {
      setSearchTab("FRIENDS");
    });
    document.getElementById("btnSearchTabRooms").addEventListener("click", function () {
      setSearchTab("ROOMS");
    });
    document.getElementById("inpSearchQuery").addEventListener("input", function () {
      var q = this.value;
      updateDirectCodeJoinBox(q);
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function () {
        runSearch(q);
      }, 240);
    });
    document.getElementById("inpSearchQuery").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var val = window.RUN_CONFIG.stripInvisibleAndTrim(this.value);
        if (
          /^run:\/\/join\//i.test(val) ||
          window.RUN_CONFIG.looksLikeRoomCode(val) ||
          val.startsWith("#")
        ) {
          var code = window.RUN_CONFIG.cleanRoomCodeOrIdInput(val);
          if (code) {
            joinRoomAndOpen(code, code);
          }
        }
      }
    });
    document.getElementById("btnDirectCodeJoin").addEventListener("click", async function () {
      var code = window.RUN_CONFIG.cleanRoomCodeOrIdInput(
        document.getElementById("inpSearchQuery").value
      );
      if (!code) return;
      this.disabled = true;
      var origText = this.textContent;
      this.textContent = "جاري الانضمام…";
      try {
        await joinRoomAndOpen(code, code);
      } finally {
        this.disabled = false;
        this.textContent = origText;
      }
    });
    document.getElementById("btnCopyMyFriendLink").addEventListener("click", function () {
      copyToClipboard(document.getElementById("myProfileInviteLink").textContent, this);
    });

    // Create Group Room Screen
    document.getElementById("btnCreateRoomBack").addEventListener("click", function () {
      showScreen("rooms");
    });
    document.getElementById("inpCreateMemberSearch").addEventListener("input", function () {
      var q = this.value.trim();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async function () {
        if (!q) {
          state.createMemberCandidates = [];
          renderCreateRoomMembersPicker();
          return;
        }
        var res = await window.RunMatrixClient.searchUsers(q, new Set(), new Set());
        state.createMemberCandidates = res;
        renderCreateRoomMembersPicker();
      }, 280);
    });
    document.getElementById("btnConfirmCreateRoom").addEventListener("click", onConfirmCreateRoom);

    // Active Call Controls
    document.getElementById("btnAcceptCall").addEventListener("click", acceptIncomingCall);
    document.getElementById("btnDeclineCall").addEventListener("click", function () {
      endActiveCall(true);
    });
    document.getElementById("btnToggleMic").addEventListener("click", function () {
      state.activeCall.isMicMuted = !state.activeCall.isMicMuted;
      window.RunWebRtcManager.setMicMuted(state.activeCall.isMicMuted);
      updateActiveCallUi();
    });
    document.getElementById("btnToggleCam").addEventListener("click", function () {
      state.activeCall.isCameraEnabled = !state.activeCall.isCameraEnabled;
      window.RunWebRtcManager.setCameraEnabled(state.activeCall.isCameraEnabled);
      updateActiveCallUi();
    });
    document.getElementById("btnToggleSpk").addEventListener("click", function () {
      state.activeCall.isSpeakerOn = !state.activeCall.isSpeakerOn;
      window.RunWebRtcManager.setSpeakerEnabled(
        state.activeCall.isSpeakerOn,
        document.getElementById("remoteVideo")
      );
      updateActiveCallUi();
    });
    document.getElementById("btnEndActiveCall").addEventListener("click", function () {
      endActiveCall(true);
    });

    // Account / Settings Screen
    document.getElementById("btnAccountOpenPinCreate").addEventListener("click", function () {
      openPinScreen("create");
    });
    document.getElementById("btnAccountOpenPinRestore").addEventListener("click", function () {
      openPinScreen("restore");
    });
    document.getElementById("btnQuality480p").addEventListener("click", function () {
      state.callQuality = "DEFAULT_480P";
      try {
        localStorage.setItem("run_v2_web_call_quality", state.callQuality);
      } catch (_) {}
      renderQualityButtons();
    });
    document.getElementById("btnQuality240p").addEventListener("click", function () {
      state.callQuality = "DATA_SAVER";
      try {
        localStorage.setItem("run_v2_web_call_quality", state.callQuality);
      } catch (_) {}
      renderQualityButtons();
    });
    document.getElementById("btnQualityAudio").addEventListener("click", function () {
      state.callQuality = "AUDIO_ONLY";
      try {
        localStorage.setItem("run_v2_web_call_quality", state.callQuality);
      } catch (_) {}
      renderQualityButtons();
    });
    document.getElementById("btnThemeDark").addEventListener("click", function () {
      applyTheme("dark");
    });
    document.getElementById("btnThemeLight").addEventListener("click", function () {
      applyTheme("light");
    });
    document.getElementById("btnEnableBrowserNotifs").addEventListener("click", function () {
      if (!("Notification" in window)) {
        showToast("المتصفح الحالي لا يدعم إشعارات الويب", true);
        return;
      }
      Notification.requestPermission().then(function (perm) {
        document.getElementById("notifsStatusDesc").textContent =
          perm === "granted"
            ? "مفعّلة ✓ — ستصلك إشعارات بالرسائل الجديدة"
            : "تم رفض صلاحية الإشعارات من المتصفح";
      });
    });
    document.getElementById("btnLogout").addEventListener("click", async function () {
      syncLoopActive = false;
      endActiveCall(false);
      await window.RunMatrixClient.logout();
      state.account = null;
      state.rooms = [];
      state.activeRoom = null;
      state.initialSyncCompleted = false;
      state.syncError = null;
      state.messagesByRoom = {};
      updateSyncStatusBanner();
      showScreen("login");
    });
  }

  // =========================================================================
  // BOOTSTRAP ON PAGE LOAD (Fix 1: Restore cached rooms immediately!)
  // =========================================================================

  window.addEventListener("DOMContentLoaded", async function () {
    loadPreferences();
    bindAllEvents();

    // If a session already exists in localStorage, immediately restore cached rooms
    // BEFORE waiting for WASM or network `/sync` so the user never sees a blank/empty list!
    if (window.RunMatrixClient.isLoggedIn()) {
      state.initialSyncCompleted = false;
      state.rooms = window.RunMatrixClient.getPersistedRoomsList();
      ensureDesktopActiveRoomSelected();
      showScreen("rooms");
      renderRoomsList();
    } else {
      renderRoomsList();
    }
    renderCallsHistory();

    try {
      await window.RunCryptoEngine.initCryptoLibraries();
      var restoredAccount = await window.RunMatrixClient.restoreExistingSessionIfAny();
      if (restoredAccount) {
        state.account = restoredAccount;
        if (state.rooms.length === 0) {
          state.rooms = window.RunMatrixClient.getPersistedRoomsList();
        }
        ensureDesktopActiveRoomSelected();
        renderAccountScreen();
        showScreen("rooms");
        renderRoomsList();
        checkTurnStatusAfterLogin();
        startSyncLoop();
        handleUrlDeepLinkIfAny();
      }
    } catch (initErr) {
      console.error("[RunBootstrap] Init error:", initErr && initErr.name, initErr && initErr.message);
    }
  });
})();
