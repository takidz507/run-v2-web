/**
 * Run v2 Web (v2.3.2) — Real Matrix Client-Server v3 API Layer.
 *
 * Connects to `window.RUN_CONFIG.HOMESERVER_BASE_URL` (`https://matrix.unredacted.org`)
 * and integrates with `window.RunCryptoEngine` for full Olm/Megolm E2EE interoperability
 * with Element and Cinny.
 *
 * Fixes in v2.3.2:
 * - Filtered `/sync` with `lazy_load_members: true`, `presence: { types: [] }`, and `timeline.limit: 10`
 *   so accounts joined to huge public rooms (`Unredacted Space` ~9066 members, `Unredacted Announcements` ~6631 members)
 *   never download 15,000+ member/presence events on initial sync (~3–15 KB instead of ~10 MB).
 * - Split initial sync into two passes:
 *   1. Ultra-light first pass (`syncFirstPassLight`, `timeline.limit: 1`, `lazy_load_members: true`, plus
 *      `/joined_rooms` minimal state fallback) so room summaries appear in seconds even on 12–30 KB/s connections.
 *   2. Filtered timeline pass (`timeline.limit: 10`, `lazy_load_members: true`) + progressive lazy member loading.
 * - Client-side `AbortController` timeout on `apiRequest` so stalled mobile connections abort cleanly.
 * - Persists `sinceToken` alongside room summaries & metadata in `localStorage` so page reloads resume
 *   incremental sync directly while displaying cached rooms immediately.
 */
window.RunMatrixClient = (function () {
  var SESSION_STORAGE_KEY = "run_v2_web_session_v2";
  var ROOMS_CACHE_PREFIX = "run_v2_web_rooms_cache_";
  var META_CACHE_PREFIX = "run_v2_web_room_meta_";
  var SYNC_TOKEN_PREFIX = "run_v2_web_sync_token_";

  /**
   * Pass 1 filter: Ultra-light initial pass to retrieve joined rooms and minimal room state
   * (`m.room.name`, `m.room.canonical_alias`, `m.room.encryption`, `m.room.topic`) + `summary`
   * (`m.heroes`, `m.joined_member_count`) with `timeline.limit: 1` and `lazy_load_members: true`.
   * Excludes `m.room.member` state dumps and `presence` events completely (~3 KB total).
   */
  var LIGHT_FIRST_PASS_FILTER = JSON.stringify({
    presence: { types: [] },
    account_data: { types: ["m.direct"] },
    room: {
      include_leave: false,
      state: {
        lazy_load_members: true,
        types: [
          "m.room.name",
          "m.room.canonical_alias",
          "m.room.aliases",
          "m.room.encryption",
          "m.room.topic"
        ]
      },
      timeline: {
        limit: 1,
        lazy_load_members: true
      },
      ephemeral: { types: [] },
      account_data: { types: [] }
    }
  });

  /**
   * Pass 2 & incremental `/sync` filter: Limits timeline to 10 events per room, enables
   * `lazy_load_members: true` on both state and timeline (so huge public rooms with 9,000+ members
   * only include senders of the 10 timeline events), and omits bulk server presence events.
   */
  var STANDARD_SYNC_FILTER = JSON.stringify({
    presence: { types: [] },
    account_data: { types: ["m.direct"] },
    room: {
      include_leave: false,
      state: {
        lazy_load_members: true,
        types: [
          "m.room.name",
          "m.room.canonical_alias",
          "m.room.aliases",
          "m.room.encryption",
          "m.room.topic",
          "m.room.member"
        ]
      },
      timeline: {
        limit: 10,
        lazy_load_members: true
      },
      ephemeral: { types: ["m.receipt"] },
      account_data: { types: [] }
    }
  });

  var roomNameCache = {};
  var roomTopicCache = {};
  var roomAliasCache = {};
  var roomEncryptedCache = {};
  var roomEncryptionNoteCache = {};
  var roomMemberCountCache = {};
  var roomMembersSetCache = {};
  var roomMembersLazyLoaded = {};
  var directPeerCache = {};
  var userDisplayNameCache = {};
  var userPresenceCache = {};
  var requestedMissingSessions = {};

  function getStoredSession() {
    try {
      var raw = localStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveStoredSession(sessionObj) {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionObj));
    } catch (_) {}
  }

  function clearStoredSession() {
    var s = getStoredSession();
    if (s && s.userId) {
      try {
        localStorage.removeItem(ROOMS_CACHE_PREFIX + s.userId);
        localStorage.removeItem(META_CACHE_PREFIX + s.userId);
        localStorage.removeItem(SYNC_TOKEN_PREFIX + s.userId);
      } catch (_) {}
    }
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (_) {}
  }

  function isLoggedIn() {
    var s = getStoredSession();
    return Boolean(s && s.accessToken && s.userId && s.deviceId);
  }

  // =========================================================================
  // PERSISTENT ROOM SUMMARIES, METADATA & SYNC TOKEN CACHE (Fixes Bug 1)
  // =========================================================================

  function getPersistedSyncToken() {
    var s = getStoredSession();
    if (!s || !s.userId) return null;
    try {
      return localStorage.getItem(SYNC_TOKEN_PREFIX + s.userId) || null;
    } catch (_) {
      return null;
    }
  }

  function savePersistedSyncToken(token) {
    var s = getStoredSession();
    if (!s || !s.userId || !token) return;
    try {
      localStorage.setItem(SYNC_TOKEN_PREFIX + s.userId, String(token));
    } catch (_) {}
  }

  function loadPersistedRoomMetadata(userId) {
    if (!userId) return;
    try {
      var raw = localStorage.getItem(META_CACHE_PREFIX + userId);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      roomNameCache = parsed.roomNameCache || {};
      roomTopicCache = parsed.roomTopicCache || {};
      roomAliasCache = parsed.roomAliasCache || {};
      roomEncryptedCache = parsed.roomEncryptedCache || {};
      roomMemberCountCache = parsed.roomMemberCountCache || {};
      directPeerCache = parsed.directPeerCache || {};
      userDisplayNameCache = parsed.userDisplayNameCache || {};
    } catch (_) {}
  }

  function savePersistedRoomMetadata(userId) {
    if (!userId) return;
    try {
      var data = {
        roomNameCache: roomNameCache,
        roomTopicCache: roomTopicCache,
        roomAliasCache: roomAliasCache,
        roomEncryptedCache: roomEncryptedCache,
        roomMemberCountCache: roomMemberCountCache,
        directPeerCache: directPeerCache,
        userDisplayNameCache: userDisplayNameCache
      };
      localStorage.setItem(META_CACHE_PREFIX + userId, JSON.stringify(data));
    } catch (_) {}
  }

  function getPersistedRoomsList() {
    var s = getStoredSession();
    if (!s || !s.userId) return [];
    try {
      var raw = localStorage.getItem(ROOMS_CACHE_PREFIX + s.userId);
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function savePersistedRoomsList(roomsList) {
    var s = getStoredSession();
    if (!s || !s.userId || !Array.isArray(roomsList)) return;
    try {
      var compact = roomsList.map(function (r) {
        return {
          roomId: r.roomId,
          name: r.name,
          topic: r.topic || "",
          roomCode: r.roomCode || "",
          isDirect: Boolean(r.isDirect),
          directPeerUserId: r.directPeerUserId || null,
          memberCount: r.memberCount || 1,
          lastMessageSender: r.lastMessageSender || null,
          lastMessageBody: r.lastMessageBody || "",
          lastMessageTimestamp: r.lastMessageTimestamp || 0,
          unreadCount: r.unreadCount || 0,
          isEncrypted: Boolean(r.isEncrypted),
          encryptionStatusNote: r.encryptionStatusNote || null,
          avatarColor: r.avatarColor || window.RUN_CONFIG.avatarColorFor(r.roomId),
          peerPresence: r.peerPresence || "offline"
        };
      });
      localStorage.setItem(ROOMS_CACHE_PREFIX + s.userId, JSON.stringify(compact));
    } catch (_) {}
  }

  /**
   * Honest, cause-specific Arabic error mapper.
   */
  function mapErrorToArabic(rawText, httpCode, endpointPath) {
    var parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (_) {}

    var errCode = (parsed && parsed.errcode) || "";
    var errMsg = (parsed && parsed.error) || "";
    var path = String(endpointPath || "");

    var isRegDisabled =
      /Registration has been disabled/i.test(errMsg) ||
      (path.indexOf("/register") !== -1 &&
        path.indexOf("/email/") === -1 &&
        (errCode === "M_FORBIDDEN" || httpCode === 403) &&
        (/disabled/i.test(errMsg) || !errMsg));

    if (isRegDisabled) {
      return "التسجيل مغلق على هذا السيرفر";
    }
    if (errCode === "M_USER_DEACTIVATED" || /deactivated/i.test(errMsg)) {
      return "هذا الحساب معطل ولا يمكن الدخول به";
    }
    if ((errCode === "M_FORBIDDEN" || httpCode === 403) && path.indexOf("/login") !== -1) {
      return "اسم المستخدم أو كلمة المرور غير صحيحة";
    }
    if (errCode === "M_USER_IN_USE") {
      return "اسم المستخدم هذا محجوز بالفعل، اختر اسمًا آخر";
    }
    if (errCode === "M_INVALID_USERNAME") {
      return "اسم المستخدم يحتوي على رموز غير مسموحة (استخدم حروفًا إنجليزية صغيرة وأرقامًا)";
    }
    if (errCode === "M_EXCLUSIVE") {
      return "اسم المستخدم هذا محجوز للنظام ولا يمكن تسجيله";
    }
    if (errCode === "M_WEAK_PASSWORD") {
      return "كلمة المرور ضعيفة جدًا، يرجى اختيار كلمة مرور أقوى";
    }
    if (errCode === "M_THREEPID_IN_USE") {
      return "هذا البريد الإلكتروني مرتبط بحساب آخر بالفعل";
    }
    if (errCode === "M_THREEPID_NOT_FOUND" || errCode === "M_THREEPID_AUTH_FAILED") {
      return "لم يكتمل تأكيد البريد الإلكتروني بعد — افتح الرسالة في بريدك واضغط رابط/رمز التأكيد ثم أعد المحاولة";
    }
    if (errCode === "M_INVALID_EMAIL") {
      return "عنوان البريد الإلكتروني غير صالح";
    }
    if (errCode === "M_CAPTCHA_NEEDED" || errCode === "M_CAPTCHA_INVALID") {
      return "يرجى إكمال تحقق reCAPTCHA بشكل صحيح";
    }
    if (
      (errCode === "M_UNAUTHORIZED" || httpCode === 401) &&
      path.indexOf("/register") !== -1
    ) {
      if (errMsg) {
        return "بانتظار إكمال خطوة التحقق: " + errMsg;
      }
      return "يرجى إكمال خطوات التحقق المطلوبة لإتمام إنشاء الحساب";
    }
    if (errCode === "M_UNKNOWN_TOKEN" || errCode === "M_MISSING_TOKEN" || httpCode === 401) {
      return "انتهت صلاحية الجلسة أو رمز الدخول غير صالح، يرجى تسجيل الدخول مجددًا";
    }
    if (errCode === "M_ROOM_IN_USE") {
      return "كود الغرفة مستخدم بالفعل، يرجى المحاولة مرة أخرى";
    }
    if (errCode === "M_NOT_FOUND" || httpCode === 404) {
      return "لم يتم العثور على الحساب أو الغرفة المطلوبة";
    }
    if (errCode === "M_LIMIT_EXCEEDED" || httpCode === 429) {
      return "محاولات كثيرة متتالية، يرجى الانتظار قليلاً ثم المحاولة";
    }
    if (errCode === "M_FORBIDDEN" || httpCode === 403) {
      return errMsg ? "غير مسموح بهذه العملية: " + errMsg : "غير مسموح بتنفيذ هذه العملية (403)";
    }
    if (httpCode >= 500 && httpCode <= 599) {
      return "خطأ في الخادم (" + httpCode + ")، يرجى المحاولة بعد لحظات";
    }
    if (errMsg) {
      return "تعذر إتمام العملية (" + httpCode + "): " + errMsg;
    }
    return "تعذر إتمام العملية (رمز الحالة " + httpCode + ")";
  }

  /**
   * Executes an HTTP request against the homeserver with client-side AbortController timeout
   * so slow/stalled mobile connections abort cleanly rather than hanging or failing silently.
   */
  async function apiRequest(method, pathAndQuery, bodyObj, authenticated, options) {
    var opts = options || {};
    var useAuth = authenticated !== false;
    var timeoutMs =
      opts.timeoutMs || (String(pathAndQuery).indexOf("/sync") !== -1 ? 42000 : 25000);

    var headers = {
      Accept: "application/json"
    };
    if (bodyObj !== undefined && bodyObj !== null) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    if (useAuth) {
      var session = getStoredSession();
      if (!session || !session.accessToken) {
        throw new Error("غير مسجل الدخول");
      }
      headers["Authorization"] = "Bearer " + session.accessToken;
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timeoutId = null;
    if (controller && timeoutMs > 0) {
      timeoutId = setTimeout(function () {
        try {
          controller.abort();
        } catch (_) {}
      }, timeoutMs);
    }

    var resp;
    try {
      resp = await fetch(window.RUN_CONFIG.HOMESERVER_BASE_URL + pathAndQuery, {
        method: method,
        headers: headers,
        body: bodyObj !== undefined && bodyObj !== null ? JSON.stringify(bodyObj) : undefined,
        signal: controller ? controller.signal : undefined
      });
    } catch (netErr) {
      if (timeoutId) clearTimeout(timeoutId);
      var isAbort = netErr && netErr.name === "AbortError";
      var wrappedNet = new Error(
        isAbort
          ? "انتهت مهلة الاتصال بالسيرفر على الشبكة البطيئة"
          : "تعذر الاتصال بالسيرفر — تحقق من اتصال الإنترنت (" +
              ((netErr && netErr.message) || "NetworkError") +
              ")"
      );
      wrappedNet.isNetworkError = true;
      wrappedNet.causeName = (netErr && netErr.name) || "TypeError";
      throw wrappedNet;
    }

    var rawText;
    try {
      rawText = await resp.text();
    } catch (readErr) {
      if (timeoutId) clearTimeout(timeoutId);
      var wrappedRead = new Error(
        "انقطع تنزيل البيانات على الشبكة البطيئة (" +
          ((readErr && readErr.message) || "StreamError") +
          ")"
      );
      wrappedRead.isNetworkError = true;
      wrappedRead.causeName = (readErr && readErr.name) || "TypeError";
      throw wrappedRead;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      var err = new Error(mapErrorToArabic(rawText, resp.status, pathAndQuery));
      err.httpStatus = resp.status;
      err.rawBody = rawText;
      try {
        err.jsonBody = JSON.parse(rawText);
      } catch (_) {}
      throw err;
    }
    return rawText ? JSON.parse(rawText) : {};
  }

  // =========================================================================
  // 1. AUTHENTICATION & IN-APP MULTI-STAGE UIAA REGISTRATION
  // =========================================================================

  async function login(usernameInput, passwordPlain) {
    var localpart = window.RUN_CONFIG.toLocalpart(usernameInput);
    if (!localpart) throw new Error("يرجى إدخال اسم المستخدم");
    if (!passwordPlain) throw new Error("يرجى إدخال كلمة المرور");

    var payload = {
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: localpart
      },
      password: passwordPlain,
      initial_device_display_name: "Run v2 Web"
    };

    var resp = await apiRequest("POST", "/_matrix/client/v3/login", payload, false);
    return finalizeAuthenticatedSession(resp, localpart);
  }

  async function registerStep(options) {
    var localpart = window.RUN_CONFIG.toLocalpart(options.username);
    var passwordPlain = options.password || "";
    var displayName = (options.displayName || "").trim();
    var authStagePayload = options.auth || null;

    if (localpart.length < 3) {
      throw new Error("اسم المستخدم يجب أن يتكون من 3 أحرف أو أرقام على الأقل");
    }
    if (passwordPlain.length < 6) {
      throw new Error("كلمة المرور يجب أن تتكون من 6 أحرف على الأقل");
    }

    var body = {
      username: localpart,
      password: passwordPlain,
      initial_device_display_name: "Run v2 Web"
    };
    if (authStagePayload) {
      body.auth = authStagePayload;
    }

    var registerPath = "/_matrix/client/v3/register";
    var resp = await fetch(window.RUN_CONFIG.HOMESERVER_BASE_URL + registerPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });

    var rawText = await resp.text();
    var json = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (_) {}

    if (resp.ok && json.access_token) {
      var account = await finalizeAuthenticatedSession(json, displayName || localpart);
      if (displayName) {
        try {
          await updateDisplayName(displayName);
          account.displayName = displayName;
        } catch (_) {}
      }
      return {
        status: "COMPLETED",
        account: account
      };
    }

    if (resp.status === 401 && Array.isArray(json.flows)) {
      var completed = Array.isArray(json.completed) ? json.completed : [];
      var chosenFlow = selectBestUiaaFlow(json.flows);
      var remainingStages = chosenFlow.filter(function (st) {
        return completed.indexOf(st) === -1;
      });

      if (remainingStages.length === 1 && remainingStages[0] === "m.login.dummy" && !authStagePayload) {
        return registerStep({
          username: localpart,
          password: passwordPlain,
          displayName: displayName,
          auth: {
            type: "m.login.dummy",
            session: json.session
          }
        });
      }

      var stageError = "";
      if (json.errcode && json.error) {
        stageError = mapErrorToArabic(rawText, resp.status, registerPath);
      }

      return {
        status: "UIAA_REQUIRED",
        session: json.session || "",
        flows: json.flows,
        selectedStages: chosenFlow,
        completed: completed,
        nextStage: remainingStages[0] || "",
        params: json.params || {},
        stageError: stageError
      };
    }

    throw new Error(mapErrorToArabic(rawText, resp.status, registerPath));
  }

  function selectBestUiaaFlow(flows) {
    if (!Array.isArray(flows) || flows.length === 0) return [];
    for (var i = 0; i < flows.length; i++) {
      var stages = flows[i].stages || [];
      if (
        stages.indexOf("m.login.recaptcha") !== -1 &&
        stages.indexOf("m.login.email.identity") !== -1
      ) {
        return stages;
      }
    }
    return flows[0].stages || [];
  }

  async function requestRegisterEmailToken(email, clientSecret, sendAttempt) {
    var cleanEmail = String(email || "").trim();
    if (!cleanEmail || cleanEmail.indexOf("@") === -1) {
      throw new Error("يرجى إدخال بريد إلكتروني صحيح لإرسال رمز/رابط التأكيد");
    }
    var path = "/_matrix/client/v3/register/email/requestToken";
    var body = {
      client_secret: clientSecret,
      email: cleanEmail,
      send_attempt: sendAttempt || 1
    };
    var resp = await apiRequest("POST", path, body, false);
    return {
      sid: resp.sid || "",
      submitUrl: resp.submit_url || ""
    };
  }

  async function submitRegisterEmailCode(sid, clientSecret, tokenCode, submitUrl) {
    var cleanToken = String(tokenCode || "").trim();
    if (!cleanToken) return false;
    var body = {
      sid: sid,
      client_secret: clientSecret,
      token: cleanToken
    };
    var targetPath = "/_matrix/client/v3/register/email/submitToken";
    try {
      if (submitUrl && submitUrl.startsWith("https://")) {
        var r = await fetch(submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        return r.ok;
      }
      await apiRequest("POST", targetPath, body, false);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function finalizeAuthenticatedSession(authResp, fallbackDisplayName) {
    var accessToken = authResp.access_token;
    var userId = authResp.user_id;
    var deviceId = authResp.device_id || "RUNWEB_" + Math.random().toString(36).slice(2, 10).toUpperCase();
    var localpart = window.RUN_CONFIG.toLocalpart(userId);

    saveStoredSession({
      accessToken: accessToken,
      userId: userId,
      deviceId: deviceId,
      displayName: fallbackDisplayName || localpart
    });

    loadPersistedRoomMetadata(userId);
    await window.RunCryptoEngine.initAccount(userId, deviceId);
    try {
      await ensureOlmKeysUploaded(0, true);
    } catch (_) {}

    var profileName = await fetchDisplayName(userId);
    var finalDisplay = profileName || fallbackDisplayName || localpart;
    saveStoredSession({
      accessToken: accessToken,
      userId: userId,
      deviceId: deviceId,
      displayName: finalDisplay
    });

    setPresenceOnline(userId).catch(function () {});

    return getCurrentAccountObject();
  }

  async function restoreExistingSessionIfAny() {
    var s = getStoredSession();
    if (!s || !s.accessToken || !s.userId || !s.deviceId) return null;
    loadPersistedRoomMetadata(s.userId);
    await window.RunCryptoEngine.initAccount(s.userId, s.deviceId);
    ensureOlmKeysUploaded(0, false).catch(function () {});
    return getCurrentAccountObject();
  }

  function getCurrentAccountObject() {
    var s = getStoredSession();
    if (!s) return null;
    var idKeys = window.RunCryptoEngine.getIdentityKeys();
    return {
      internalUserId: s.userId,
      publicHandle: window.RUN_CONFIG.toPublicHandle(s.userId),
      displayName: s.displayName || window.RUN_CONFIG.toLocalpart(s.userId),
      deviceId: s.deviceId,
      isPinConfigured: window.RunCryptoEngine.isPinConfigured(s.userId),
      deviceEd25519Fingerprint: window.RunCryptoEngine.getFormattedFingerprint(),
      deviceCurve25519Key: idKeys.curve25519 || ""
    };
  }

  async function logout() {
    try {
      await apiRequest("POST", "/_matrix/client/v3/logout", {}, true);
    } catch (_) {}
    clearStoredSession();
    roomNameCache = {};
    roomTopicCache = {};
    roomAliasCache = {};
    roomEncryptedCache = {};
    roomEncryptionNoteCache = {};
    roomMemberCountCache = {};
    roomMembersSetCache = {};
    roomMembersLazyLoaded = {};
    directPeerCache = {};
  }

  async function updateDisplayName(newDisplayName) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var encodedUser = encodeURIComponent(s.userId);
    await apiRequest("PUT", "/_matrix/client/v3/profile/" + encodedUser + "/displayname", {
      displayname: newDisplayName.trim()
    });
    s.displayName = newDisplayName.trim();
    saveStoredSession(s);
  }

  // =========================================================================
  // 2. OLM / MEGOLM KEY UPLOAD, FULL DEVICE SHARING & m.room_key_request
  // =========================================================================

  async function ensureOlmKeysUploaded(serverOtkCount, forceDeviceKeys) {
    var payload = window.RunCryptoEngine.buildKeysUploadPayload(serverOtkCount, forceDeviceKeys);
    if (!payload) return;
    var hadDev = Boolean(payload.device_keys);
    var hadOtk = Boolean(payload.one_time_keys);
    await apiRequest("POST", "/_matrix/client/v3/keys/upload", payload);
    window.RunCryptoEngine.markKeysUploaded(hadDev, hadOtk);
  }

  async function queryDevicesForUsers(userIds) {
    var unique = Array.from(new Set((userIds || []).filter(Boolean)));
    if (unique.length === 0) return [];
    var deviceKeysMap = {};
    unique.forEach(function (u) {
      deviceKeysMap[u] = [];
    });
    var resp = await apiRequest("POST", "/_matrix/client/v3/keys/query", {
      device_keys: deviceKeysMap,
      timeout: 10000
    });
    return window.RunCryptoEngine.processKeysQueryResponse(resp);
  }

  async function ensureOlmSessionsWithDevices(devices) {
    var missingOlmDevices = (devices || []).filter(function (dev) {
      return !window.RunCryptoEngine.hasOlmSessionForCurveKey(dev.curve25519Key);
    });
    if (missingOlmDevices.length === 0) return;

    var oneTimeKeysReq = {};
    var lookupMap = {};
    missingOlmDevices.forEach(function (dev) {
      if (!oneTimeKeysReq[dev.userId]) oneTimeKeysReq[dev.userId] = {};
      oneTimeKeysReq[dev.userId][dev.deviceId] = "signed_curve25519";
      lookupMap[dev.userId + "|" + dev.deviceId] = dev;
    });

    try {
      var claimResp = await apiRequest("POST", "/_matrix/client/v3/keys/claim", {
        one_time_keys: oneTimeKeysReq,
        timeout: 10000
      });
      window.RunCryptoEngine.processClaimedOneTimeKeys(claimResp, lookupMap);
    } catch (err) {
      console.warn("claiming one-time keys failed:", err);
    }
  }

  async function shareMegolmKeyWithAllRoomDevices(roomId, options) {
    var s = getStoredSession();
    if (!s) return;
    var opts = options || {};

    var sessionData = window.RunCryptoEngine.getOrCreateOutboundRoomSessionData(
      roomId,
      Boolean(opts.forceRotate)
    );
    try {
      sessionData.outboundSession.free();
    } catch (_) {}

    var memberIds = await getOrFetchRoomMemberUserIds(roomId);
    if (memberIds.length === 0) return;

    try {
      await queryDevicesForUsers(memberIds);
    } catch (_) {}

    var allMemberDevices = window.RunCryptoEngine.getKnownDevicesForUsers(memberIds);
    var targetDevices = window.RunCryptoEngine.filterDevicesMissingSession(
      roomId,
      sessionData.sessionId,
      allMemberDevices,
      opts.forceUserIds || [],
      opts.forceDeviceKeys || []
    );

    if (targetDevices.length === 0) return;

    await ensureOlmSessionsWithDevices(targetDevices);

    var messagesMap = {};
    var sentDevices = [];

    for (var i = 0; i < targetDevices.length; i++) {
      var dev = targetDevices[i];
      var olmPayload = window.RunCryptoEngine.buildOlmRoomKeyEvent(dev, sessionData);
      if (!olmPayload) continue;
      if (!messagesMap[dev.userId]) messagesMap[dev.userId] = {};
      messagesMap[dev.userId][dev.deviceId] = olmPayload;
      sentDevices.push(dev);
    }

    if (sentDevices.length > 0) {
      var txnId = "rk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      var encodedType = encodeURIComponent(window.RUN_CONFIG.ROOM_EVENT_ENCRYPTED);
      await apiRequest(
        "PUT",
        "/_matrix/client/v3/sendToDevice/" + encodedType + "/" + txnId,
        { messages: messagesMap }
      );
      window.RunCryptoEngine.markDevicesReceivedSession(roomId, sessionData.sessionId, sentDevices);
    }
  }

  async function answerIncomingRoomKeyRequests(requests) {
    if (!Array.isArray(requests) || requests.length === 0) return;
    var s = getStoredSession();
    if (!s) return;

    for (var i = 0; i < requests.length; i++) {
      var req = requests[i];
      if (!req || !req.requesterUserId || !req.requestingDeviceId || !req.sessionId) continue;

      var roomId = req.roomId || "";
      if (roomId && req.requesterUserId !== s.userId) {
        var memberIds = await getOrFetchRoomMemberUserIds(roomId);
        if (memberIds.indexOf(req.requesterUserId) === -1) continue;
      }

      try {
        await queryDevicesForUsers([req.requesterUserId]);
      } catch (_) {}

      var userDevices = window.RunCryptoEngine.getKnownDevicesForUsers([req.requesterUserId]);
      var targetDevice = userDevices.find(function (d) {
        return d.deviceId === req.requestingDeviceId;
      });
      if (!targetDevice) continue;

      await ensureOlmSessionsWithDevices([targetDevice]);

      var forwardedPayload = window.RunCryptoEngine.buildOlmForwardedRoomKeyEvent(
        targetDevice,
        roomId,
        req.sessionId
      );
      if (!forwardedPayload) continue;

      var messagesMap = {};
      messagesMap[targetDevice.userId] = {};
      messagesMap[targetDevice.userId][targetDevice.deviceId] = forwardedPayload;

      var txnId = "fwd_rk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      var encodedType = encodeURIComponent(window.RUN_CONFIG.ROOM_EVENT_ENCRYPTED);
      try {
        await apiRequest(
          "PUT",
          "/_matrix/client/v3/sendToDevice/" + encodedType + "/" + txnId,
          { messages: messagesMap }
        );
      } catch (_) {}
    }
  }

  async function requestMissingRoomKey(roomId, sessionId, senderKey, senderUserId) {
    if (!roomId || !sessionId) return;
    var cacheKey = roomId + "|" + sessionId;
    if (requestedMissingSessions[cacheKey]) return;
    requestedMissingSessions[cacheKey] = true;

    var s = getStoredSession();
    if (!s) return;

    var reqContent = {
      action: "request",
      requesting_device_id: s.deviceId,
      request_id: "req_" + Date.now() + "_" + sessionId.slice(0, 8),
      body: {
        algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM,
        room_id: roomId,
        sender_key: senderKey || "",
        session_id: sessionId
      }
    };

    var messagesMap = {};
    messagesMap[s.userId] = { "*": reqContent };
    if (senderUserId && senderUserId !== s.userId) {
      messagesMap[senderUserId] = { "*": reqContent };
    }

    var txnId = "rkr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    try {
      await apiRequest(
        "PUT",
        "/_matrix/client/v3/sendToDevice/m.room_key_request/" + txnId,
        { messages: messagesMap }
      );
    } catch (_) {}
  }

  // =========================================================================
  // 3. 6-DIGIT PIN KEY BACKUP (Upload & Restore via Account Data)
  // =========================================================================

  async function uploadPinKeyBackup(pin) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var payload = await window.RunCryptoEngine.createEncryptedPinBackupPayload(pin, s.userId);
    var encodedUser = encodeURIComponent(s.userId);
    var encodedType = encodeURIComponent(window.RUN_CONFIG.ACCOUNT_DATA_KEY_BACKUP_EVENT);
    await apiRequest(
      "PUT",
      "/_matrix/client/v3/user/" + encodedUser + "/account_data/" + encodedType,
      payload
    );
  }

  async function restorePinKeyBackup(pin) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var encodedUser = encodeURIComponent(s.userId);
    var encodedType = encodeURIComponent(window.RUN_CONFIG.ACCOUNT_DATA_KEY_BACKUP_EVENT);
    var payload = await apiRequest(
      "GET",
      "/_matrix/client/v3/user/" + encodedUser + "/account_data/" + encodedType
    );
    return window.RunCryptoEngine.restoreFromEncryptedPinBackupPayload(pin, s.userId, payload);
  }

  async function checkRemotePinBackupExists() {
    var s = getStoredSession();
    if (!s) return false;
    try {
      var encodedUser = encodeURIComponent(s.userId);
      var encodedType = encodeURIComponent(window.RUN_CONFIG.ACCOUNT_DATA_KEY_BACKUP_EVENT);
      var payload = await apiRequest(
        "GET",
        "/_matrix/client/v3/user/" + encodedUser + "/account_data/" + encodedType
      );
      return Boolean(payload && payload.ciphertext);
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 4. TWO-PASS FILTERED /SYNC & PROGRESSIVE LAZY MEMBER LOADING (Fixes Bug 1)
  // =========================================================================

  /**
   * Ultra-light fallback via `GET /_matrix/client/v3/joined_rooms` (~200 bytes) + minimal state
   * so that even on a severely throttled link (12–30 KB/s), the user's joined rooms list can be
   * constructed quickly if a full sync response is delayed.
   */
  async function fetchJoinedRoomsMinimalFallback() {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var myUserId = s.userId;

    var resp = await apiRequest("GET", "/_matrix/client/v3/joined_rooms", null, true, {
      timeoutMs: 20000
    });
    var joinedIds = Array.isArray(resp.joined_rooms) ? resp.joined_rooms : [];
    var summaries = [];

    for (var i = 0; i < joinedIds.length; i++) {
      var rId = joinedIds[i];
      if (!roomNameCache[rId]) {
        try {
          var nameObj = await apiRequest(
            "GET",
            "/_matrix/client/v3/rooms/" + encodeURIComponent(rId) + "/state/m.room.name",
            null,
            true,
            { timeoutMs: 8000 }
          );
          if (nameObj && nameObj.name) {
            roomNameCache[rId] = nameObj.name;
          }
        } catch (_) {}
      }
      if (!roomAliasCache[rId]) {
        try {
          var aliasObj = await apiRequest(
            "GET",
            "/_matrix/client/v3/rooms/" + encodeURIComponent(rId) + "/state/m.room.canonical_alias",
            null,
            true,
            { timeoutMs: 8000 }
          );
          if (aliasObj && aliasObj.alias) {
            roomAliasCache[rId] = aliasObj.alias;
          }
        } catch (_) {}
      }
      var isEnc = await checkRoomEncryptionEnabled(rId);
      var directPeer = directPeerCache[rId] || null;
      var isDirect = Boolean(directPeer);
      var name =
        roomNameCache[rId] ||
        (directPeer
          ? userDisplayNameCache[directPeer] ||
            window.RUN_CONFIG.toPublicHandle(directPeer).replace(/^@/, "")
          : "") ||
        window.RUN_CONFIG.toPublicRoomCode(roomAliasCache[rId]) ||
        "غرفة Run";
      var code = isDirect
        ? window.RUN_CONFIG.toPublicHandle(directPeer)
        : window.RUN_CONFIG.toPublicRoomCode(roomAliasCache[rId] || rId);

      summaries.push({
        roomId: rId,
        name: name,
        topic: roomTopicCache[rId] || "",
        roomCode: code,
        isDirect: isDirect,
        directPeerUserId: directPeer,
        memberCount: roomMemberCountCache[rId] || 1,
        lastMessageSender: null,
        lastMessageBody: isDirect ? "محادثة خاصة" : "غرفة Run",
        lastMessageTimestamp: 0,
        unreadCount: 0,
        isEncrypted: isEnc,
        encryptionStatusNote: isEnc ? null : "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة",
        avatarColor: window.RUN_CONFIG.avatarColorFor(directPeer || rId),
        peerPresence: "offline"
      });
    }

    savePersistedRoomMetadata(myUserId);
    return summaries;
  }

  /**
   * Pass 1: Fast, ultra-light initial `/sync` (`LIGHT_FIRST_PASS_FILTER`: `timeline.limit: 1`,
   * `lazy_load_members: true`, `presence.types: []`, no member state dumps) so room summaries
   * download in ~3 KB and appear immediately on slow mobile data (12–30 KB/s).
   * Falls back to `fetchJoinedRoomsMinimalFallback()` if needed.
   */
  async function syncFirstPassLight() {
    try {
      return await sync(null, 0, { lightFirstPass: true, timeoutMs: 30000 });
    } catch (firstPassErr) {
      console.warn(
        "[RunSync] Light first-pass /sync failed, attempting /joined_rooms minimal bootstrap:",
        firstPassErr && firstPassErr.message
      );
      var fallbackRooms = await fetchJoinedRoomsMinimalFallback();
      return {
        nextBatch: null,
        rooms: fallbackRooms,
        incomingFriendInvites: [],
        outgoingFriendInvites: [],
        friends: [],
        newMessagesByRoom: {},
        signalingEvents: []
      };
    }
  }

  /**
   * Main `/sync` method — ALWAYS applies a Matrix `filter` (`LIGHT_FIRST_PASS_FILTER` or
   * `STANDARD_SYNC_FILTER` with `lazy_load_members: true` and `timeline.limit: 10`) so huge
   * public rooms (9,000+ members) never stall or fail mobile downloads.
   */
  async function sync(sinceToken, timeoutMs, options) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var myUserId = s.userId;
    var opts = options || {};

    var filterJson = opts.lightFirstPass ? LIGHT_FIRST_PASS_FILTER : STANDARD_SYNC_FILTER;
    var waitTimeout = sinceToken ? timeoutMs || 12000 : 0;
    var query =
      "/_matrix/client/v3/sync?timeout=" +
      waitTimeout +
      "&filter=" +
      encodeURIComponent(filterJson);

    if (sinceToken) {
      query += "&since=" + encodeURIComponent(sinceToken);
    }

    var reqTimeout = opts.timeoutMs || (sinceToken ? waitTimeout + 25000 : 38000);
    var root = await apiRequest("GET", query, null, true, { timeoutMs: reqTimeout });
    var nextBatch = root.next_batch || sinceToken || "";
    if (nextBatch) {
      savePersistedSyncToken(nextBatch);
    }

    // 1. Process incoming to_device events FIRST
    var toDeviceEvents = (root.to_device && root.to_device.events) || [];
    var incomingKeyRequests = window.RunCryptoEngine.processIncomingToDeviceEvents(toDeviceEvents);
    if (incomingKeyRequests.length > 0) {
      answerIncomingRoomKeyRequests(incomingKeyRequests).catch(function () {});
    }

    // 2. Replenish one-time keys if needed
    var otkCounts = root.device_one_time_keys_count || {};
    var signedCurveCount = otkCounts.signed_curve25519 || 0;
    ensureOlmKeysUploaded(signedCurveCount, false).catch(function () {});

    // 3. Process device_lists.changed
    var changedUsers = (root.device_lists && root.device_lists.changed) || [];
    if (changedUsers.length > 0) {
      queryDevicesForUsers(changedUsers)
        .then(function () {
          Object.keys(roomEncryptedCache).forEach(function (rId) {
            if (roomEncryptedCache[rId]) {
              var membersSet = roomMembersSetCache[rId];
              var hasChangedMember = changedUsers.some(function (u) {
                return membersSet && membersSet.has(u);
              });
              if (hasChangedMember) {
                shareMegolmKeyWithAllRoomDevices(rId, { forceUserIds: changedUsers }).catch(
                  function () {}
                );
              }
            }
          });
        })
        .catch(function () {});
    }

    // 4. Parse Account Data (m.direct map)
    var accountDataEvents = (root.account_data && root.account_data.events) || [];
    for (var aIdx = 0; aIdx < accountDataEvents.length; aIdx++) {
      var aEv = accountDataEvents[aIdx];
      if (aEv && aEv.type === "m.direct" && aEv.content) {
        var peerIds = Object.keys(aEv.content);
        for (var pIdx = 0; pIdx < peerIds.length; pIdx++) {
          var peerId = peerIds[pIdx];
          var rArr = aEv.content[peerId];
          if (Array.isArray(rArr)) {
            rArr.forEach(function (rId) {
              if (rId) directPeerCache[rId] = peerId;
            });
          }
        }
      }
    }

    // 5. Parse Presence events (if any)
    var presenceEvents = (root.presence && root.presence.events) || [];
    for (var prIdx = 0; prIdx < presenceEvents.length; prIdx++) {
      var prEv = presenceEvents[prIdx];
      if (prEv && prEv.sender && prEv.content) {
        userPresenceCache[prEv.sender] = prEv.content.presence || "offline";
      }
    }

    var roomsObj = root.rooms || {};
    var joinObj = roomsObj.join || {};
    var inviteObj = roomsObj.invite || {};

    var roomSummaries = [];
    var newMessagesByRoom = {};
    var signalingEvents = [];
    var outgoingFriendInvites = [];
    var friendsMap = {};

    var joinedRoomIds = Object.keys(joinObj);
    for (var rIdx = 0; rIdx < joinedRoomIds.length; rIdx++) {
      var roomId = joinedRoomIds[rIdx];
      var roomData = joinObj[roomId] || {};
      var stateEvents = (roomData.state && roomData.state.events) || [];
      var timelineEvents = (roomData.timeline && roomData.timeline.events) || [];
      var summaryObj = roomData.summary || {};
      var unreadObj = roomData.unread_notifications || {};

      var joinedCount = summaryObj["m.joined_member_count"] || 0;
      var invitedCount = summaryObj["m.invited_member_count"] || 0;
      if (joinedCount + invitedCount > 0) {
        roomMemberCountCache[roomId] = joinedCount + invitedCount;
      }

      if (!roomMembersSetCache[roomId]) {
        roomMembersSetCache[roomId] = new Set([myUserId]);
      }
      var memberSet = roomMembersSetCache[roomId];
      var invitedOtherUser = null;
      var joinedOtherUser = null;
      var newlyJoinedMembersInBatch = [];

      function processStateEvent(ev) {
        if (!ev || !ev.content) return;
        var type = ev.type;
        var content = ev.content;
        if (type === "m.room.name" && content.name) {
          roomNameCache[roomId] = content.name;
        } else if (type === "m.room.topic" && content.topic) {
          roomTopicCache[roomId] = content.topic;
        } else if (type === "m.room.canonical_alias") {
          var alias = content.alias || (Array.isArray(content.alt_aliases) && content.alt_aliases[0]) || "";
          if (alias) roomAliasCache[roomId] = alias;
        } else if (type === "m.room.aliases" && Array.isArray(content.aliases) && content.aliases[0]) {
          if (!roomAliasCache[roomId]) {
            roomAliasCache[roomId] = content.aliases[0];
          }
        } else if (type === "m.room.encryption") {
          if (content.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM) {
            roomEncryptedCache[roomId] = true;
            delete roomEncryptionNoteCache[roomId];
          } else {
            roomEncryptedCache[roomId] = false;
            roomEncryptionNoteCache[roomId] =
              "خوارزمية التشفير في هذه الغرفة غير مدعومة (" + (content.algorithm || "") + ")";
          }
        } else if (type === "m.room.member") {
          var stateKey = ev.state_key || "";
          var membership = content.membership || "";
          if (stateKey && content.displayname) {
            userDisplayNameCache[stateKey] = content.displayname;
          }
          if (stateKey) {
            if (membership === "join" || membership === "invite") {
              var wasKnown = memberSet.has(stateKey);
              memberSet.add(stateKey);
              if (!wasKnown && stateKey !== myUserId) {
                newlyJoinedMembersInBatch.push(stateKey);
              }
            } else if (membership === "leave" || membership === "ban") {
              memberSet.delete(stateKey);
            }
          }
          if (stateKey && stateKey !== myUserId) {
            if (membership === "join") {
              joinedOtherUser = stateKey;
            } else if (membership === "invite") {
              invitedOtherUser = stateKey;
            }
            if (content.is_direct) {
              directPeerCache[roomId] = stateKey;
            }
          }
        }
      }

      for (var sIdx = 0; sIdx < stateEvents.length; sIdx++) {
        processStateEvent(stateEvents[sIdx]);
      }

      var roomMessages = [];
      var lastSenderName = null;
      var lastMessageText = "";
      var lastMessageTs = 0;

      for (var tIdx = 0; tIdx < timelineEvents.length; tIdx++) {
        var ev = timelineEvents[tIdx];
        if (!ev) continue;
        if (ev.state_key !== undefined) {
          processStateEvent(ev);
          if (
            ev.type === "m.room.member" &&
            ev.content &&
            (ev.content.membership === "join" || ev.content.membership === "invite") &&
            ev.state_key &&
            ev.state_key !== myUserId &&
            roomEncryptedCache[roomId]
          ) {
            shareMegolmKeyWithAllRoomDevices(roomId, {
              forceUserIds: [ev.state_key]
            }).catch(function () {});
          }
        }

        var evType = ev.type;
        var sender = ev.sender || "";
        var eventId = ev.event_id || "ev_" + Date.now() + "_" + tIdx;
        var ts = ev.origin_server_ts || Date.now();
        var content = ev.content || {};
        var senderDisplay =
          userDisplayNameCache[sender] ||
          window.RUN_CONFIG.toPublicHandle(sender).replace(/^@/, "");

        if (evType === "m.room.message") {
          var body = content.body || "";
          if (body) {
            roomMessages.push({
              eventId: eventId,
              roomId: roomId,
              senderUserId: sender,
              senderHandle: window.RUN_CONFIG.toPublicHandle(sender),
              senderDisplayName: senderDisplay,
              body: body,
              timestamp: ts,
              isOutgoing: sender === myUserId,
              isEncrypted: false,
              decryptionFailed: false
            });
            lastSenderName = sender === myUserId ? "أنت" : senderDisplay;
            lastMessageText = body;
            lastMessageTs = ts;
          }
        } else if (evType === window.RUN_CONFIG.ROOM_EVENT_ENCRYPTED) {
          if (content.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM) {
            roomEncryptedCache[roomId] = true;
          }
          var dec = window.RunCryptoEngine.decryptMegolmEvent(roomId, sender, content);
          if (dec.decryptionFailed && dec.missingSessionId) {
            requestMissingRoomKey(roomId, dec.missingSessionId, dec.senderKey, sender).catch(
              function () {}
            );
          }
          roomMessages.push({
            eventId: eventId,
            roomId: roomId,
            senderUserId: sender,
            senderHandle: window.RUN_CONFIG.toPublicHandle(sender),
            senderDisplayName: senderDisplay,
            body: dec.body,
            timestamp: ts,
            isOutgoing: sender === myUserId,
            isEncrypted: !dec.decryptionFailed,
            decryptionFailed: dec.decryptionFailed,
            rawEncryptedContent: content
          });
          lastSenderName = sender === myUserId ? "أنت" : senderDisplay;
          lastMessageText = dec.body;
          lastMessageTs = ts;
        } else if (
          evType === "m.call.invite" ||
          evType === "m.call.answer" ||
          evType === "m.call.candidates" ||
          evType === "m.call.hangup"
        ) {
          var ageMs = Date.now() - ts;
          if (sender !== myUserId && ageMs < 60000) {
            var sdpObj = content.offer || content.answer || null;
            var sdp = sdpObj ? sdpObj.sdp : null;
            signalingEvents.push({
              type: evType,
              roomId: roomId,
              senderUserId: sender,
              callId: content.call_id || "",
              sdp: sdp,
              candidates: Array.isArray(content.candidates) ? content.candidates : [],
              isVideo: sdp ? sdp.indexOf("m=video") !== -1 : true
            });
          }
        }
      }

      if (newlyJoinedMembersInBatch.length > 0 && roomEncryptedCache[roomId]) {
        shareMegolmKeyWithAllRoomDevices(roomId, {
          forceUserIds: newlyJoinedMembersInBatch
        }).catch(function () {});
      }

      if (roomMessages.length > 0) {
        newMessagesByRoom[roomId] = roomMessages;
      }

      var heroes = summaryObj["m.heroes"] || [];
      var heroUserId = heroes.length > 0 ? heroes[0] : null;
      if (heroUserId) {
        memberSet.add(heroUserId);
      }
      var totalMembers = Math.max(1, roomMemberCountCache[roomId] || memberSet.size);

      var directPeer =
        directPeerCache[roomId] ||
        (totalMembers <= 2 && !roomNameCache[roomId]
          ? heroUserId || joinedOtherUser || invitedOtherUser
          : null);

      if (directPeer) {
        directPeerCache[roomId] = directPeer;
      }

      var isDirectRoom = Boolean(directPeer);
      var resolvedName =
        roomNameCache[roomId] ||
        (directPeer
          ? userDisplayNameCache[directPeer] ||
            window.RUN_CONFIG.toPublicHandle(directPeer).replace(/^@/, "")
          : "") ||
        window.RUN_CONFIG.toPublicRoomCode(roomAliasCache[roomId]) ||
        "غرفة Run";

      var roomCode = isDirectRoom
        ? window.RUN_CONFIG.toPublicHandle(directPeer)
        : window.RUN_CONFIG.toPublicRoomCode(roomAliasCache[roomId] || roomId);

      var peerPresence = directPeer ? userPresenceCache[directPeer] || "offline" : "offline";

      if (isDirectRoom && directPeer) {
        var peerDisplay =
          userDisplayNameCache[directPeer] ||
          window.RUN_CONFIG.toPublicHandle(directPeer).replace(/^@/, "");
        if (invitedOtherUser === directPeer && !joinedOtherUser && invitedCount > 0) {
          outgoingFriendInvites.push({
            roomId: roomId,
            internalUserId: directPeer,
            publicHandle: window.RUN_CONFIG.toPublicHandle(directPeer),
            displayName: peerDisplay,
            isIncoming: false,
            presence: peerPresence,
            statusText: "بانتظار القبول",
            avatarColor: window.RUN_CONFIG.avatarColorFor(directPeer)
          });
        } else {
          friendsMap[directPeer] = {
            internalUserId: directPeer,
            publicHandle: window.RUN_CONFIG.toPublicHandle(directPeer),
            displayName: peerDisplay,
            presence: peerPresence,
            statusText: peerPresence === "online" ? "متصل الآن" : "حساب Run",
            avatarColor: window.RUN_CONFIG.avatarColorFor(directPeer),
            relationState: "FRIEND"
          };
        }
      }

      var isRoomEnc = Boolean(roomEncryptedCache[roomId]);
      roomSummaries.push({
        roomId: roomId,
        name: resolvedName,
        topic: roomTopicCache[roomId] || "",
        roomCode: roomCode,
        isDirect: isDirectRoom,
        directPeerUserId: directPeer,
        memberCount: totalMembers,
        lastMessageSender: lastSenderName,
        lastMessageBody:
          lastMessageText || (isDirectRoom ? "محادثة خاصة" : totalMembers + " عضوًا"),
        lastMessageTimestamp: lastMessageTs,
        unreadCount: unreadObj.notification_count || 0,
        isEncrypted: isRoomEnc,
        encryptionStatusNote: isRoomEnc
          ? null
          : roomEncryptionNoteCache[roomId] || "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة",
        avatarColor: window.RUN_CONFIG.avatarColorFor(directPeer || roomId),
        peerPresence: peerPresence
      });
    }

    // Save updated room metadata caches in localStorage
    savePersistedRoomMetadata(myUserId);

    // 6. Parse Incoming Invites
    var incomingInvites = [];
    var inviteRoomIds = Object.keys(inviteObj);
    for (var iIdx = 0; iIdx < inviteRoomIds.length; iIdx++) {
      var invRoomId = inviteRoomIds[iIdx];
      var invEvents =
        (inviteObj[invRoomId] &&
          inviteObj[invRoomId].invite_state &&
          inviteObj[invRoomId].invite_state.events) ||
        [];
      var inviterUserId = "";
      var inviterDisplay = "";
      var invRoomName = "";
      for (var eIdx = 0; eIdx < invEvents.length; eIdx++) {
        var iEv = invEvents[eIdx];
        if (!iEv || !iEv.content) continue;
        if (iEv.type === "m.room.name") {
          invRoomName = iEv.content.name || "";
        } else if (iEv.type === "m.room.member" && iEv.sender && iEv.sender !== myUserId) {
          inviterUserId = iEv.sender;
          inviterDisplay = iEv.content.displayname || "";
        }
      }
      if (inviterUserId) {
        var h = window.RUN_CONFIG.toPublicHandle(inviterUserId);
        incomingInvites.push({
          roomId: invRoomId,
          internalUserId: inviterUserId,
          publicHandle: h,
          displayName: invRoomName || inviterDisplay || h.replace(/^@/, ""),
          isIncoming: true,
          presence: userPresenceCache[inviterUserId] || "offline",
          statusText: "دعوة واردة",
          avatarColor: window.RUN_CONFIG.avatarColorFor(inviterUserId)
        });
      }
    }

    roomSummaries.sort(function (a, b) {
      return (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0);
    });

    return {
      nextBatch: nextBatch,
      rooms: roomSummaries,
      incomingFriendInvites: incomingInvites,
      outgoingFriendInvites: outgoingFriendInvites,
      friends: Object.values(friendsMap),
      newMessagesByRoom: newMessagesByRoom,
      signalingEvents: signalingEvents
    };
  }

  /**
   * Progressively & lazily loads member display names for small/DM rooms (`memberCount <= 40`)
   * in the background AFTER initial sync completes, skipping huge public rooms (`Unredacted Space`).
   */
  async function lazyLoadRoomMembersForSmallRooms(roomsList) {
    var s = getStoredSession();
    if (!s || !s.userId || !Array.isArray(roomsList)) return false;
    var myUserId = s.userId;
    var updatedAny = false;

    for (var i = 0; i < roomsList.length; i++) {
      var r = roomsList[i];
      if (!r || !r.roomId) continue;
      if (roomMembersLazyLoaded[r.roomId]) continue;

      // Never auto-download full member lists for massive public rooms (> 40 members)
      if ((r.memberCount || 0) > 40) {
        roomMembersLazyLoaded[r.roomId] = true;
        continue;
      }

      // If it's a 1-to-1 DM room and we only need the peer's display name, fetch just their profile!
      if (r.isDirect && r.directPeerUserId && !userDisplayNameCache[r.directPeerUserId]) {
        var dName = await fetchDisplayName(r.directPeerUserId);
        if (dName) {
          userDisplayNameCache[r.directPeerUserId] = dName;
          if (!roomNameCache[r.roomId]) {
            r.name = dName;
            updatedAny = true;
          }
        }
        roomMembersLazyLoaded[r.roomId] = true;
        continue;
      }

      // For small group rooms (<= 40 members), lazily fetch joined members once
      try {
        await getOrFetchRoomMemberUserIds(r.roomId);
        roomMembersLazyLoaded[r.roomId] = true;
      } catch (_) {}
    }

    if (updatedAny) {
      savePersistedRoomMetadata(myUserId);
      savePersistedRoomsList(roomsList);
    }
    return updatedAny;
  }

  // =========================================================================
  // 5. ROOMS, MESSAGES, CREATION & MULTI-STRATEGY JOIN BY CODE (Fixes Bug 3)
  // =========================================================================

  async function checkRoomEncryptionEnabled(roomId) {
    if (roomEncryptedCache[roomId] !== undefined) {
      return roomEncryptedCache[roomId];
    }
    try {
      var encoded = encodeURIComponent(roomId);
      var stateObj = await apiRequest(
        "GET",
        "/_matrix/client/v3/rooms/" + encoded + "/state/m.room.encryption",
        null,
        true,
        { timeoutMs: 10000 }
      );
      var enabled = Boolean(stateObj && stateObj.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM);
      roomEncryptedCache[roomId] = enabled;
      if (!enabled) {
        roomEncryptionNoteCache[roomId] = "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة";
      }
      return enabled;
    } catch (_) {
      roomEncryptedCache[roomId] = false;
      roomEncryptionNoteCache[roomId] = "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة";
      return false;
    }
  }

  async function fetchRoomMessages(roomId, limit) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var myUserId = s.userId;
    var encoded = encodeURIComponent(roomId);
    var msgFilter = JSON.stringify({ lazy_load_members: true });
    var resp = await apiRequest(
      "GET",
      "/_matrix/client/v3/rooms/" +
        encoded +
        "/messages?dir=b&limit=" +
        (limit || 25) +
        "&filter=" +
        encodeURIComponent(msgFilter)
    );
    var chunk = resp.chunk || [];
    var list = [];

    for (var i = chunk.length - 1; i >= 0; i--) {
      var ev = chunk[i];
      if (!ev) continue;
      var type = ev.type;
      var sender = ev.sender || "";
      var eventId = ev.event_id || "hist_" + i;
      var ts = ev.origin_server_ts || Date.now();
      var content = ev.content || {};
      var senderDisplay =
        userDisplayNameCache[sender] ||
        window.RUN_CONFIG.toPublicHandle(sender).replace(/^@/, "");

      if (type === "m.room.message" && content.body) {
        list.push({
          eventId: eventId,
          roomId: roomId,
          senderUserId: sender,
          senderHandle: window.RUN_CONFIG.toPublicHandle(sender),
          senderDisplayName: senderDisplay,
          body: content.body,
          timestamp: ts,
          isOutgoing: sender === myUserId,
          isEncrypted: false,
          decryptionFailed: false
        });
      } else if (type === window.RUN_CONFIG.ROOM_EVENT_ENCRYPTED) {
        if (content.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM) {
          roomEncryptedCache[roomId] = true;
        }
        var dec = window.RunCryptoEngine.decryptMegolmEvent(roomId, sender, content);
        if (dec.decryptionFailed && dec.missingSessionId) {
          requestMissingRoomKey(roomId, dec.missingSessionId, dec.senderKey, sender).catch(
            function () {}
          );
        }
        list.push({
          eventId: eventId,
          roomId: roomId,
          senderUserId: sender,
          senderHandle: window.RUN_CONFIG.toPublicHandle(sender),
          senderDisplayName: senderDisplay,
          body: dec.body,
          timestamp: ts,
          isOutgoing: sender === myUserId,
          isEncrypted: !dec.decryptionFailed,
          decryptionFailed: dec.decryptionFailed,
          rawEncryptedContent: content
        });
      }
    }
    return list;
  }

  async function sendRoomMessage(roomId, text) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var cleanText = String(text || "").trim();
    if (!cleanText) throw new Error("الرسالة فارغة");

    var isEnc = await checkRoomEncryptionEnabled(roomId);
    var encodedRoom = encodeURIComponent(roomId);
    var txnId = "runweb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

    if (isEnc) {
      await ensureOlmKeysUploaded(0, false).catch(function () {});
      await shareMegolmKeyWithAllRoomDevices(roomId, {});
      var encContent = window.RunCryptoEngine.encryptMegolmMessage(roomId, cleanText);
      var encType = encodeURIComponent(window.RUN_CONFIG.ROOM_EVENT_ENCRYPTED);
      var respEnc = await apiRequest(
        "PUT",
        "/_matrix/client/v3/rooms/" + encodedRoom + "/send/" + encType + "/" + txnId,
        encContent
      );
      return {
        eventId: respEnc.event_id || txnId,
        roomId: roomId,
        senderUserId: s.userId,
        senderHandle: window.RUN_CONFIG.toPublicHandle(s.userId),
        senderDisplayName: s.displayName || window.RUN_CONFIG.toLocalpart(s.userId),
        body: cleanText,
        timestamp: Date.now(),
        isOutgoing: true,
        isEncrypted: true,
        decryptionFailed: false
      };
    } else {
      var msgPayload = {
        msgtype: "m.text",
        body: cleanText
      };
      var respPlain = await apiRequest(
        "PUT",
        "/_matrix/client/v3/rooms/" + encodedRoom + "/send/m.room.message/" + txnId,
        msgPayload
      );
      return {
        eventId: respPlain.event_id || txnId,
        roomId: roomId,
        senderUserId: s.userId,
        senderHandle: window.RUN_CONFIG.toPublicHandle(s.userId),
        senderDisplayName: s.displayName || window.RUN_CONFIG.toLocalpart(s.userId),
        body: cleanText,
        timestamp: Date.now(),
        isOutgoing: true,
        isEncrypted: false,
        decryptionFailed: false
      };
    }
  }

  async function createGroupRoom(name, topic, invitedHandlesOrIds) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("يرجى إدخال اسم الغرفة");

    var codeNum = Math.floor(1000 + Math.random() * 9000);
    var asciiPrefix = cleanName
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 4);
    if (!asciiPrefix) asciiPrefix = "RUN";
    var permanentCode = asciiPrefix + "-" + codeNum;
    var aliasLocal = permanentCode.toLowerCase();
    var fullCanonicalAlias = "#" + aliasLocal + ":" + window.RUN_CONFIG.SERVER_DOMAIN;

    var inviteUserIds = Array.from(
      new Set(
        (invitedHandlesOrIds || [])
          .map(function (h) {
            return window.RUN_CONFIG.toInternalUserId(h);
          })
          .filter(Boolean)
      )
    );

    var initialState = [
      {
        type: "m.room.encryption",
        state_key: "",
        content: {
          algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM
        }
      }
    ];

    var payload = {
      name: cleanName,
      room_alias_name: aliasLocal,
      visibility: "public",
      preset: "public_chat",
      initial_state: initialState
    };
    if (topic && topic.trim()) {
      payload.topic = topic.trim();
    }
    if (inviteUserIds.length > 0) {
      payload.invite = inviteUserIds;
    }

    var resp = await apiRequest("POST", "/_matrix/client/v3/createRoom", payload);
    var roomId = resp.room_id;

    // Also register uppercase alias in room directory so both #code and #CODE resolve directly
    try {
      var upperAlias = "#" + permanentCode.toUpperCase() + ":" + window.RUN_CONFIG.SERVER_DOMAIN;
      await apiRequest(
        "PUT",
        "/_matrix/client/v3/directory/room/" + encodeURIComponent(upperAlias),
        { room_id: roomId }
      );
    } catch (_) {}

    roomNameCache[roomId] = cleanName;
    roomTopicCache[roomId] = (topic || "").trim();
    roomAliasCache[roomId] = fullCanonicalAlias;
    roomMembersSetCache[roomId] = new Set([s.userId].concat(inviteUserIds));
    savePersistedRoomMetadata(s.userId);

    var isEnc = await checkRoomEncryptionEnabled(roomId);
    if (isEnc) {
      shareMegolmKeyWithAllRoomDevices(roomId, { forceUserIds: inviteUserIds }).catch(
        function () {}
      );
    }

    return {
      roomId: roomId,
      name: cleanName,
      topic: (topic || "").trim(),
      roomCode: permanentCode,
      isDirect: false,
      directPeerUserId: null,
      memberCount: inviteUserIds.length + 1,
      lastMessageSender: "أنت",
      lastMessageBody: isEnc
        ? "تم إنشاء الغرفة المشفرة · الكود " + permanentCode
        : "تم إنشاء الغرفة (غير مشفرة) · الكود " + permanentCode,
      lastMessageTimestamp: Date.now(),
      unreadCount: 0,
      isEncrypted: isEnc,
      encryptionStatusNote: isEnc ? null : "غير مشفرة — الرسائل في هذه الغرفة غير مشفرة",
      avatarColor: window.RUN_CONFIG.avatarColorFor(roomId),
      peerPresence: "online"
    };
  }

  async function createOrOpenDirectChat(targetHandleOrUserId) {
    var s = getStoredSession();
    if (!s) throw new Error("غير مسجل الدخول");
    var targetUserId = window.RUN_CONFIG.toInternalUserId(targetHandleOrUserId);

    var existingRoomIds = Object.keys(directPeerCache);
    for (var i = 0; i < existingRoomIds.length; i++) {
      var rId = existingRoomIds[i];
      if (directPeerCache[rId] === targetUserId) {
        return rId;
      }
    }

    var payload = {
      is_direct: true,
      preset: "trusted_private_chat",
      invite: [targetUserId],
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: {
            algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM
          }
        }
      ]
    };

    var resp = await apiRequest("POST", "/_matrix/client/v3/createRoom", payload);
    var roomId = resp.room_id;
    directPeerCache[roomId] = targetUserId;
    roomMembersSetCache[roomId] = new Set([s.userId, targetUserId]);
    savePersistedRoomMetadata(s.userId);

    var isEnc = await checkRoomEncryptionEnabled(roomId);
    if (isEnc) {
      shareMegolmKeyWithAllRoomDevices(roomId, { forceUserIds: [targetUserId] }).catch(
        function () {}
      );
    }
    return roomId;
  }

  /**
   * Resolves a room code (e.g. `AGEN-9641`), room alias (`#agen-9641:unredacted.org`),
   * or `run://join/AGEN-9641` link into a canonical `!roomId:unredacted.org`
   * using multi-case directory lookup + `/publicRooms` fallback.
   */
  async function resolveRoomCodeOrAliasToRoomId(codeOrRoomIdOrLink) {
    var cleaned = window.RUN_CONFIG.cleanRoomCodeOrIdInput(codeOrRoomIdOrLink);
    if (!cleaned) return null;

    if (cleaned.startsWith("!") && cleaned.indexOf(":") !== -1) {
      return {
        roomId: cleaned,
        roomCode: window.RUN_CONFIG.toPublicRoomCode(roomAliasCache[cleaned] || cleaned)
      };
    }

    var candidateAliases = window.RUN_CONFIG.getCandidateRoomAliases(cleaned);

    // 1. Try directory alias resolution across candidate cases (lowercase, uppercase, exact)
    for (var i = 0; i < candidateAliases.length; i++) {
      var alias = candidateAliases[i];
      try {
        var dirResp = await apiRequest(
          "GET",
          "/_matrix/client/v3/directory/room/" + encodeURIComponent(alias)
        );
        if (dirResp && dirResp.room_id) {
          roomAliasCache[dirResp.room_id] = alias;
          return {
            roomId: dirResp.room_id,
            alias: alias,
            roomCode: window.RUN_CONFIG.toPublicRoomCode(alias)
          };
        }
      } catch (_) {}
    }

    // 2. Fallback: search `/publicRooms` directory (matches canonical_alias, aliases, name, or roomId prefix)
    var upperTarget = cleaned.toUpperCase();
    var lowerTarget = cleaned.toLowerCase();
    try {
      var pubResp = await apiRequest("POST", "/_matrix/client/v3/publicRooms", {
        limit: 100
      });
      var chunk = (pubResp && pubResp.chunk) || [];
      for (var j = 0; j < chunk.length; j++) {
        var item = chunk[j];
        if (!item || !item.room_id) continue;
        var canonical = item.canonical_alias || "";
        var itemCode = window.RUN_CONFIG.toPublicRoomCode(canonical || item.room_id);
        var aliasesList = Array.isArray(item.aliases) ? item.aliases : [];
        var aliasMatched = aliasesList.some(function (a) {
          return window.RUN_CONFIG.toPublicRoomCode(a) === upperTarget;
        });
        var namePrefix = String(item.name || "")
          .replace(/[^A-Za-z0-9]/g, "")
          .toUpperCase()
          .slice(0, 4);

        if (
          itemCode === upperTarget ||
          aliasMatched ||
          String(canonical).toLowerCase().indexOf(lowerTarget) !== -1 ||
          String(item.name || "").toUpperCase() === upperTarget ||
          (upperTarget.startsWith(namePrefix + "-") &&
            String(item.topic || "").toUpperCase().indexOf(upperTarget) !== -1)
        ) {
          if (canonical) roomAliasCache[item.room_id] = canonical;
          if (item.name) roomNameCache[item.room_id] = item.name;
          if (item.topic) roomTopicCache[item.room_id] = item.topic;
          if (item.num_joined_members) roomMemberCountCache[item.room_id] = item.num_joined_members;
          return {
            roomId: item.room_id,
            alias: canonical || candidateAliases[0] || "",
            roomCode: upperTarget,
            name: item.name || upperTarget,
            memberCount: item.num_joined_members || 1
          };
        }
      }
    } catch (_) {}

    return null;
  }

  /**
   * Joins a room by code (`AGEN-9641`), `run://join/AGEN-9641`, alias, or `roomId`.
   */
  async function joinRoomByCodeOrId(codeOrRoomIdOrLink, optionalFallbackCode) {
    var primaryInput = window.RUN_CONFIG.cleanRoomCodeOrIdInput(codeOrRoomIdOrLink);
    var fallbackCode = window.RUN_CONFIG.cleanRoomCodeOrIdInput(optionalFallbackCode || "");
    if (!primaryInput && !fallbackCode) {
      throw new Error("يرجى إدخال كود الغرفة أو رابط الدعوة");
    }

    var lastError = null;

    async function tryJoinSingleTarget(targetStr) {
      var encoded = encodeURIComponent(targetStr);
      if (targetStr.startsWith("!")) {
        try {
          var r1 = await apiRequest("POST", "/_matrix/client/v3/rooms/" + encoded + "/join", {});
          return r1.room_id || targetStr;
        } catch (e1) {
          lastError = e1;
        }
      }
      var r2 = await apiRequest("POST", "/_matrix/client/v3/join/" + encoded, {});
      return r2.room_id || targetStr;
    }

    var joinedRoomId = null;

    if (primaryInput.startsWith("!") && primaryInput.indexOf(":") !== -1) {
      try {
        joinedRoomId = await tryJoinSingleTarget(primaryInput);
      } catch (err1) {
        lastError = err1;
      }
    }

    if (!joinedRoomId) {
      var codeToResolve =
        primaryInput.startsWith("!") && fallbackCode ? fallbackCode : primaryInput;
      var resolved = await resolveRoomCodeOrAliasToRoomId(codeToResolve);
      if (resolved && resolved.roomId) {
        try {
          joinedRoomId = await tryJoinSingleTarget(resolved.roomId);
        } catch (err2) {
          lastError = err2;
          if (resolved.alias) {
            try {
              joinedRoomId = await tryJoinSingleTarget(resolved.alias);
            } catch (err3) {
              lastError = err3;
            }
          }
        }
      }
    }

    if (!joinedRoomId) {
      var codeCandidate =
        primaryInput.startsWith("!") && fallbackCode ? fallbackCode : primaryInput;
      var aliases = window.RUN_CONFIG.getCandidateRoomAliases(codeCandidate);
      for (var i = 0; i < aliases.length; i++) {
        try {
          joinedRoomId = await tryJoinSingleTarget(aliases[i]);
          if (joinedRoomId) {
            roomAliasCache[joinedRoomId] = aliases[i];
            break;
          }
        } catch (errAlias) {
          lastError = errAlias;
        }
      }
    }

    if (!joinedRoomId) {
      throw lastError || new Error("لم يتم العثور على الحساب أو الغرفة المطلوبة");
    }

    var s = getStoredSession();
    if (s && s.userId) {
      savePersistedRoomMetadata(s.userId);
    }

    var isEnc = await checkRoomEncryptionEnabled(joinedRoomId);
    if (isEnc) {
      shareMegolmKeyWithAllRoomDevices(joinedRoomId, {}).catch(function () {});
    }
    return joinedRoomId;
  }

  async function leaveOrDeclineRoom(roomId) {
    var encoded = encodeURIComponent(roomId);
    await apiRequest("POST", "/_matrix/client/v3/rooms/" + encoded + "/leave", {});
  }

  async function getOrFetchRoomMemberUserIds(roomId) {
    var s = getStoredSession();
    var myUserId = (s && s.userId) || "";
    var cached = roomMembersSetCache[roomId];

    // If room is known to be a massive public room (> 100 members), do not block on downloading all members
    if ((roomMemberCountCache[roomId] || 0) > 100 && cached && cached.size > 0) {
      return Array.from(cached);
    }

    try {
      var encoded = encodeURIComponent(roomId);
      var resp = await apiRequest(
        "GET",
        "/_matrix/client/v3/rooms/" + encoded + "/members?membership=join",
        null,
        true,
        { timeoutMs: 18000 }
      );
      var chunk = resp.chunk || [];
      var set = new Set(myUserId ? [myUserId] : []);
      for (var i = 0; i < chunk.length; i++) {
        var ev = chunk[i];
        var uid = ev && ev.state_key;
        var content = (ev && ev.content) || {};
        var mem = content.membership;
        if (uid && content.displayname) {
          userDisplayNameCache[uid] = content.displayname;
        }
        if (uid && (mem === "join" || mem === "invite")) {
          set.add(uid);
        }
      }
      roomMembersSetCache[roomId] = set;
      return Array.from(set);
    } catch (_) {
      return cached ? Array.from(cached) : myUserId ? [myUserId] : [];
    }
  }

  async function fetchRoomMembersAndDevices(roomId) {
    var s = getStoredSession();
    var myUserId = (s && s.userId) || "";
    var encoded = encodeURIComponent(roomId);
    var resp = await apiRequest(
      "GET",
      "/_matrix/client/v3/rooms/" + encoded + "/members?membership=join",
      null,
      true,
      { timeoutMs: 20000 }
    );
    var chunk = resp.chunk || [];
    var members = [];
    var memberIds = [];

    // Cap rendered/queried members to 80 so huge public rooms (e.g. 9066 members) stay fast
    var maxItems = Math.min(chunk.length, 80);
    for (var i = 0; i < maxItems; i++) {
      var ev = chunk[i];
      var uid = ev && ev.state_key;
      var content = (ev && ev.content) || {};
      var mem = content.membership;
      if (!uid || (mem !== "join" && mem !== "invite")) continue;
      memberIds.push(uid);
      var handle = window.RUN_CONFIG.toPublicHandle(uid);
      var dName = content.displayname || handle.replace(/^@/, "");
      if (content.displayname) {
        userDisplayNameCache[uid] = content.displayname;
      }
      var role = uid === myUserId ? "أنت · عضو" : mem === "invite" ? "مدعو" : "عضو";
      members.push({
        userId: uid,
        publicHandle: handle,
        displayName: dName,
        roleLabel: role,
        membership: mem,
        presence: userPresenceCache[uid] || "offline",
        avatarColor: window.RUN_CONFIG.avatarColorFor(uid)
      });
    }

    try {
      await queryDevicesForUsers(memberIds.slice(0, 40));
    } catch (_) {}
    var devices = window.RunCryptoEngine.getKnownDevicesForUsers(memberIds.slice(0, 40));

    return {
      members: members,
      devices: devices
    };
  }

  // =========================================================================
  // 6. SEARCH (Friends by @username & Display Name, Public Rooms by Name & Code)
  // =========================================================================

  async function searchUsers(query, knownFriendIdsSet, outgoingPendingIdsSet) {
    var s = getStoredSession();
    var myUserId = (s && s.userId) || "";
    var cleanQuery = window.RUN_CONFIG.stripInvisibleAndTrim(query).replace(
      /^run:\/\/friend\//i,
      ""
    );
    if (!cleanQuery) return [];

    var resultsMap = {};

    try {
      var dirResp = await apiRequest("POST", "/_matrix/client/v3/user_directory/search", {
        search_term: cleanQuery.replace(/^@/, ""),
        limit: 25
      });
      var arr = dirResp.results || [];
      for (var i = 0; i < arr.length; i++) {
        var u = arr[i];
        var uid = u && u.user_id;
        if (!uid || uid === myUserId) continue;
        var handle = window.RUN_CONFIG.toPublicHandle(uid);
        var dName = u.display_name || handle.replace(/^@/, "");
        var presence = await fetchUserPresence(uid);
        var rel = knownFriendIdsSet.has(uid)
          ? "FRIEND"
          : outgoingPendingIdsSet.has(uid)
          ? "OUTGOING_PENDING"
          : "NONE";
        resultsMap[uid] = {
          internalUserId: uid,
          publicHandle: handle,
          displayName: dName,
          presence: presence,
          statusText: presence === "online" ? "متصل الآن" : "حساب Run",
          avatarColor: window.RUN_CONFIG.avatarColorFor(uid),
          relationState: rel
        };
      }
    } catch (_) {}

    var candidateId = window.RUN_CONFIG.toInternalUserId(cleanQuery);
    if (candidateId && candidateId !== myUserId && !resultsMap[candidateId]) {
      var profName = await fetchDisplayName(candidateId);
      if (profName !== null) {
        var cHandle = window.RUN_CONFIG.toPublicHandle(candidateId);
        var cPres = await fetchUserPresence(candidateId);
        var cRel = knownFriendIdsSet.has(candidateId)
          ? "FRIEND"
          : outgoingPendingIdsSet.has(candidateId)
          ? "OUTGOING_PENDING"
          : "NONE";
        resultsMap[candidateId] = {
          internalUserId: candidateId,
          publicHandle: cHandle,
          displayName: profName || cHandle.replace(/^@/, ""),
          presence: cPres,
          statusText: cPres === "online" ? "متصل الآن" : "حساب Run",
          avatarColor: window.RUN_CONFIG.avatarColorFor(candidateId),
          relationState: cRel
        };
      }
    }

    return Object.values(resultsMap);
  }

  async function searchPublicRooms(query, joinedRoomIdsSet) {
    var cleanQuery = window.RUN_CONFIG.cleanRoomCodeOrIdInput(query);
    var results = [];
    var seenIds = new Set();

    if (cleanQuery && cleanQuery.indexOf(" ") === -1) {
      var resolved = await resolveRoomCodeOrAliasToRoomId(cleanQuery);
      if (resolved && resolved.roomId) {
        var rId = resolved.roomId;
        seenIds.add(rId);
        results.push({
          roomId: rId,
          name: resolved.name || roomNameCache[rId] || cleanQuery.toUpperCase(),
          topic: roomTopicCache[rId] || "",
          roomCode: resolved.roomCode || window.RUN_CONFIG.toPublicRoomCode(cleanQuery),
          memberCount: resolved.memberCount || roomMemberCountCache[rId] || 1,
          isJoined: joinedRoomIdsSet.has(rId),
          avatarColor: window.RUN_CONFIG.avatarColorFor(rId)
        });
      }
    }

    try {
      var resp = await apiRequest("POST", "/_matrix/client/v3/publicRooms", {
        limit: 50
      });
      var chunk = resp.chunk || [];
      var qLower = cleanQuery.toLowerCase();
      for (var i = 0; i < chunk.length; i++) {
        var obj = chunk[i];
        var roomId = obj && obj.room_id;
        if (!roomId) continue;
        var canonical = obj.canonical_alias || "";
        if (canonical) roomAliasCache[roomId] = canonical;
        if (obj.name) roomNameCache[roomId] = obj.name;
        if (obj.topic) roomTopicCache[roomId] = obj.topic;
        if (obj.num_joined_members) roomMemberCountCache[roomId] = obj.num_joined_members;

        var code = window.RUN_CONFIG.toPublicRoomCode(
          canonical || roomAliasCache[roomId] || roomId
        );

        if (seenIds.has(roomId)) {
          var existingIdx = results.findIndex(function (x) {
            return x.roomId === roomId;
          });
          if (existingIdx !== -1) {
            if (obj.name) results[existingIdx].name = obj.name;
            if (obj.topic) results[existingIdx].topic = obj.topic;
            if (obj.num_joined_members) results[existingIdx].memberCount = obj.num_joined_members;
            if (canonical) results[existingIdx].roomCode = code;
          }
          continue;
        }

        if (cleanQuery) {
          var hay = (
            (obj.name || "") +
            " " +
            (obj.topic || "") +
            " " +
            canonical +
            " " +
            code
          ).toLowerCase();
          if (hay.indexOf(qLower) === -1) continue;
        }

        seenIds.add(roomId);
        results.push({
          roomId: roomId,
          name: obj.name || code,
          topic: obj.topic || "",
          roomCode: code,
          memberCount: obj.num_joined_members || 1,
          isJoined: joinedRoomIdsSet.has(roomId),
          avatarColor: window.RUN_CONFIG.avatarColorFor(roomId)
        });
      }
    } catch (_) {}

    return results;
  }

  // =========================================================================
  // 7. WEBRTC SIGNALING & TURN SERVER CHECK
  // =========================================================================

  async function fetchTurnCredentials() {
    var resp = await apiRequest("GET", "/_matrix/client/v3/voip/turnServer");
    var uris = Array.isArray(resp.uris) ? resp.uris.filter(Boolean) : [];
    return {
      uris: uris,
      username: resp.username || "",
      password: resp.password || "",
      ttlSeconds: resp.ttl || 86400,
      hasValidTurnServers: Boolean(uris.length > 0 && resp.username && resp.password)
    };
  }

  async function sendCallInvite(roomId, callId, offerSdp) {
    var encodedRoom = encodeURIComponent(roomId);
    var txnId = "call_inv_" + Date.now();
    await apiRequest("PUT", "/_matrix/client/v3/rooms/" + encodedRoom + "/send/m.call.invite/" + txnId, {
      call_id: callId,
      version: 0,
      lifetime: 60000,
      offer: {
        type: "offer",
        sdp: offerSdp
      }
    });
  }

  async function sendCallAnswer(roomId, callId, answerSdp) {
    var encodedRoom = encodeURIComponent(roomId);
    var txnId = "call_ans_" + Date.now();
    await apiRequest("PUT", "/_matrix/client/v3/rooms/" + encodedRoom + "/send/m.call.answer/" + txnId, {
      call_id: callId,
      version: 0,
      answer: {
        type: "answer",
        sdp: answerSdp
      }
    });
  }

  async function sendCallCandidates(roomId, callId, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;
    var encodedRoom = encodeURIComponent(roomId);
    var txnId = "call_cand_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    await apiRequest(
      "PUT",
      "/_matrix/client/v3/rooms/" + encodedRoom + "/send/m.call.candidates/" + txnId,
      {
        call_id: callId,
        version: 0,
        candidates: candidates
      }
    );
  }

  async function sendCallHangup(roomId, callId) {
    var encodedRoom = encodeURIComponent(roomId);
    var txnId = "call_hup_" + Date.now();
    await apiRequest("PUT", "/_matrix/client/v3/rooms/" + encodedRoom + "/send/m.call.hangup/" + txnId, {
      call_id: callId,
      version: 0,
      reason: "user_hangup"
    });
  }

  // =========================================================================
  // INTERNAL PROFILE & PRESENCE HELPERS
  // =========================================================================

  async function fetchDisplayName(userId) {
    try {
      var encoded = encodeURIComponent(userId);
      var obj = await apiRequest(
        "GET",
        "/_matrix/client/v3/profile/" + encoded + "/displayname",
        null,
        true,
        { timeoutMs: 8000 }
      );
      return obj.displayname || window.RUN_CONFIG.toPublicHandle(userId).replace(/^@/, "");
    } catch (_) {
      return null;
    }
  }

  async function fetchUserPresence(userId) {
    try {
      var encoded = encodeURIComponent(userId);
      var obj = await apiRequest(
        "GET",
        "/_matrix/client/v3/presence/" + encoded + "/status",
        null,
        true,
        { timeoutMs: 6000 }
      );
      var p = obj.presence || "offline";
      userPresenceCache[userId] = p;
      return p;
    } catch (_) {
      return userPresenceCache[userId] || "offline";
    }
  }

  async function setPresenceOnline(userId) {
    var encoded = encodeURIComponent(userId);
    await apiRequest("PUT", "/_matrix/client/v3/presence/" + encoded + "/status", {
      presence: "online",
      status_msg: "متصل"
    });
  }

  function isRoomCurrentlyEncrypted(roomId) {
    return Boolean(roomEncryptedCache[roomId]);
  }

  function getCachedRoomName(roomId) {
    return roomNameCache[roomId] || "";
  }

  function getCachedRoomCode(roomId) {
    return window.RUN_CONFIG.toPublicRoomCode(roomAliasCache[roomId] || "");
  }

  return {
    isLoggedIn: isLoggedIn,
    getCurrentAccountObject: getCurrentAccountObject,
    restoreExistingSessionIfAny: restoreExistingSessionIfAny,
    getPersistedRoomsList: getPersistedRoomsList,
    savePersistedRoomsList: savePersistedRoomsList,
    getPersistedSyncToken: getPersistedSyncToken,
    savePersistedSyncToken: savePersistedSyncToken,
    getCachedRoomName: getCachedRoomName,
    getCachedRoomCode: getCachedRoomCode,
    login: login,
    registerStep: registerStep,
    requestRegisterEmailToken: requestRegisterEmailToken,
    submitRegisterEmailCode: submitRegisterEmailCode,
    logout: logout,
    updateDisplayName: updateDisplayName,
    uploadPinKeyBackup: uploadPinKeyBackup,
    restorePinKeyBackup: restorePinKeyBackup,
    checkRemotePinBackupExists: checkRemotePinBackupExists,
    syncFirstPassLight: syncFirstPassLight,
    sync: sync,
    lazyLoadRoomMembersForSmallRooms: lazyLoadRoomMembersForSmallRooms,
    checkRoomEncryptionEnabled: checkRoomEncryptionEnabled,
    isRoomCurrentlyEncrypted: isRoomCurrentlyEncrypted,
    fetchRoomMessages: fetchRoomMessages,
    sendRoomMessage: sendRoomMessage,
    shareMegolmKeyWithAllRoomDevices: shareMegolmKeyWithAllRoomDevices,
    requestMissingRoomKey: requestMissingRoomKey,
    createGroupRoom: createGroupRoom,
    createOrOpenDirectChat: createOrOpenDirectChat,
    joinRoomByCodeOrId: joinRoomByCodeOrId,
    leaveOrDeclineRoom: leaveOrDeclineRoom,
    fetchRoomMembersAndDevices: fetchRoomMembersAndDevices,
    searchUsers: searchUsers,
    searchPublicRooms: searchPublicRooms,
    fetchTurnCredentials: fetchTurnCredentials,
    sendCallInvite: sendCallInvite,
    sendCallAnswer: sendCallAnswer,
    sendCallCandidates: sendCallCandidates,
    sendCallHangup: sendCallHangup
  };
})();
