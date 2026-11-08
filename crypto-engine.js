/**
 * Run v2 Web — Official Matrix Olm/Megolm E2EE & 6-Digit PIN Key Backup Engine.
 *
 * Uses official Matrix WebAssembly cryptography:
 * - `@matrix-org/olm` (official Matrix libolm WebAssembly bindings)
 * - `@matrix-org/matrix-sdk-crypto-wasm` (official Matrix Rust Crypto WASM bindings when available)
 *
 * Specifically fixes the Android 2.1.0 Element/Cinny interoperability issues:
 * 1. RFC-8785 Matrix Canonical JSON without escaping `/` (`\/`), so base64 Curve25519/Ed25519
 *    keys containing `/` verify and sign accurately across Element, Cinny, and Run.
 * 2. Shares Megolm room keys (`m.room_key` via `m.olm.v1.curve25519-aes-sha2`) with ALL
 *    devices of ALL room members (`join` and `invite`), including unverified devices.
 * 3. Automatically answers incoming `m.room_key_request` (`action: "request"`) events
 *    by sending `m.forwarded_room_key` / `m.room_key` over Olm to the requesting device.
 * 4. Sends outgoing `m.room_key_request` when a received message's Megolm session is missing.
 * 5. Re-shares the room's Megolm key whenever a new member joins or a device is verified.
 * 6. Connects the 6-digit PIN backup (PBKDF2-HMAC-SHA256 120,000 iterations + AES-256-GCM)
 *    directly to standard exported Megolm sessions (`export_session` / `import_session`).
 */
window.RunCryptoEngine = (function () {
  var PICKLE_KEY = "run_v2_web_local_olm_pickle_v2";
  var STORAGE_PREFIX = "run_v2_crypto_";

  var olmReady = false;
  var rustCryptoMod = null;
  var olmAccount = null;
  var activeUserId = "";
  var activeDeviceId = "";
  var onRoomKeyReceivedCallback = null;

  function safeStorageGet(key, fallback) {
    try {
      var val = localStorage.getItem(STORAGE_PREFIX + key);
      return val !== null ? val : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch (_) {}
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch (_) {}
  }

  /**
   * Loads official Matrix `@matrix-org/olm` WebAssembly and optional
   * `@matrix-org/matrix-sdk-crypto-wasm` module.
   */
  async function initCryptoLibraries() {
    if (olmReady && window.Olm) return true;

    // 1. Try initializing official @matrix-org/olm (loaded via script tag or dynamic loader)
    if (window.Olm && typeof window.Olm.init === "function") {
      try {
        await window.Olm.init({
          locateFile: function () {
            return "https://cdn.jsdelivr.net/npm/@matrix-org/olm@3.2.15/olm.wasm";
          }
        });
        olmReady = true;
      } catch (err) {
        console.warn("Olm WASM primary CDN init failed, trying fallback:", err);
        try {
          await window.Olm.init({
            locateFile: function () {
              return "https://unpkg.com/@matrix-org/olm@3.2.15/olm.wasm";
            }
          });
          olmReady = true;
        } catch (err2) {
          console.error("Olm WASM fallback failed:", err2);
        }
      }
    }

    // 2. Also load @matrix-org/matrix-sdk-crypto-wasm if supported by browser ESM
    if (!rustCryptoMod) {
      try {
        rustCryptoMod = await import(
          "https://cdn.jsdelivr.net/npm/@matrix-org/matrix-sdk-crypto-wasm@14.2.1/+esm"
        );
        if (rustCryptoMod && typeof rustCryptoMod.initAsync === "function") {
          await rustCryptoMod.initAsync();
        }
      } catch (_) {
        // Browser uses @matrix-org/olm primary engine
      }
    }

    return olmReady;
  }

  /**
   * Matrix Canonical JSON serializer (RFC 8785 / Matrix Spec Appendix).
   * CRITICAL: Never escapes `/` as `\/`, preserving exact base64 key strings for Ed25519 verification.
   */
  function toCanonicalJson(value) {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "boolean" || typeof value === "number") {
      return JSON.stringify(value);
    }
    if (typeof value === "string") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      var items = [];
      for (var i = 0; i < value.length; i++) {
        items.push(toCanonicalJson(value[i]));
      }
      return "[" + items.join(",") + "]";
    }
    if (typeof value === "object") {
      var keys = Object.keys(value).sort();
      var pairs = [];
      for (var kIdx = 0; kIdx < keys.length; kIdx++) {
        var k = keys[kIdx];
        if (value[k] === undefined) continue;
        pairs.push(JSON.stringify(k) + ":" + toCanonicalJson(value[k]));
      }
      return "{" + pairs.join(",") + "}";
    }
    return JSON.stringify(value);
  }

  /**
   * Initializes or restores the local Olm.Account for (userId, deviceId).
   */
  async function initAccount(userId, deviceId) {
    await initCryptoLibraries();
    if (!olmReady || !window.Olm) {
      throw new Error("تعذر تحميل محرك التشفير القياسي (Olm WebAssembly)");
    }

    activeUserId = userId;
    activeDeviceId = deviceId;

    if (olmAccount) {
      try {
        olmAccount.free();
      } catch (_) {}
      olmAccount = null;
    }

    var acct = new window.Olm.Account();
    var storageKey = "account_" + userId + "_" + deviceId;
    var pickled = safeStorageGet(storageKey, "");
    if (pickled) {
      try {
        acct.unpickle(PICKLE_KEY, pickled);
        olmAccount = acct;
        return acct;
      } catch (_) {
        try {
          acct.free();
        } catch (e2) {}
        acct = new window.Olm.Account();
      }
    }

    acct.create();
    olmAccount = acct;
    persistAccount();
    return acct;
  }

  function persistAccount() {
    if (!olmAccount || !activeUserId || !activeDeviceId) return;
    var storageKey = "account_" + activeUserId + "_" + activeDeviceId;
    try {
      var pickled = olmAccount.pickle(PICKLE_KEY);
      safeStorageSet(storageKey, pickled);
    } catch (_) {}
  }

  function getIdentityKeys() {
    if (!olmAccount) return { curve25519: "", ed25519: "" };
    try {
      return JSON.parse(olmAccount.identity_keys());
    } catch (_) {
      return { curve25519: "", ed25519: "" };
    }
  }

  function getFormattedFingerprint() {
    var ed = getIdentityKeys().ed25519 || "";
    return ed.replace(/(.{4})/g, "$1 ").trim();
  }

  /**
   * Signs a JSON object using the device's Ed25519 key in Matrix Canonical JSON format.
   */
  function signMatrixJson(targetObj, userId, deviceId) {
    var copy = JSON.parse(JSON.stringify(targetObj));
    var unsignedBackup = copy.unsigned;
    delete copy.signatures;
    delete copy.unsigned;

    var canonical = toCanonicalJson(copy);
    var signature = olmAccount.sign(canonical);

    var signatures = targetObj.signatures ? JSON.parse(JSON.stringify(targetObj.signatures)) : {};
    if (!signatures[userId]) signatures[userId] = {};
    signatures[userId]["ed25519:" + deviceId] = signature;

    copy.signatures = signatures;
    if (unsignedBackup !== undefined) {
      copy.unsigned = unsignedBackup;
    }
    return copy;
  }

  /**
   * Verifies an Ed25519 signature on a Matrix JSON object using Olm.Utility.
   */
  function verifyMatrixJsonSignature(signedObj, signerUserId, signerDeviceId, ed25519Key) {
    if (!ed25519Key || !signedObj || !signedObj.signatures) return false;
    var userSigs = signedObj.signatures[signerUserId];
    if (!userSigs) return false;
    var sig = userSigs["ed25519:" + signerDeviceId];
    if (!sig) return false;

    var copy = JSON.parse(JSON.stringify(signedObj));
    delete copy.signatures;
    delete copy.unsigned;
    var canonical = toCanonicalJson(copy);

    var util = new window.Olm.Utility();
    try {
      util.ed25519_verify(ed25519Key, canonical, sig);
      return true;
    } catch (_) {
      return false;
    } finally {
      try {
        util.free();
      } catch (_) {}
    }
  }

  /**
   * Builds the `/_matrix/client/v3/keys/upload` payload (`device_keys` + `one_time_keys`).
   */
  function buildKeysUploadPayload(currentServerOtkCount, forceDeviceKeys) {
    if (!olmAccount || !activeUserId || !activeDeviceId) return null;
    var uploadedFlagKey = "devkeys_uploaded_" + activeUserId + "_" + activeDeviceId;
    var alreadyUploaded = safeStorageGet(uploadedFlagKey, "") === "1";
    var includeDeviceKeys = Boolean(forceDeviceKeys || !alreadyUploaded);

    var maxKeys = 50;
    try {
      maxKeys = olmAccount.max_number_of_one_time_keys() || 50;
    } catch (_) {}
    var targetPool = Math.max(15, Math.floor(maxKeys / 2));
    var needed = Math.max(0, targetPool - (currentServerOtkCount || 0));

    if (!includeDeviceKeys && needed <= 0) {
      return null;
    }

    var payload = {};
    var idKeys = getIdentityKeys();

    if (includeDeviceKeys) {
      var rawDevKeys = {
        user_id: activeUserId,
        device_id: activeDeviceId,
        algorithms: [
          window.RUN_CONFIG.OLM_ALGORITHM,
          window.RUN_CONFIG.MEGOLM_ALGORITHM
        ],
        keys: {}
      };
      rawDevKeys.keys["curve25519:" + activeDeviceId] = idKeys.curve25519;
      rawDevKeys.keys["ed25519:" + activeDeviceId] = idKeys.ed25519;
      payload.device_keys = signMatrixJson(rawDevKeys, activeUserId, activeDeviceId);
    }

    if (needed > 0) {
      olmAccount.generate_one_time_keys(needed);
      persistAccount();
    }

    var otkParsed = {};
    try {
      otkParsed = JSON.parse(olmAccount.one_time_keys());
    } catch (_) {}
    var curveOtks = otkParsed.curve25519 || {};
    var otkKeyIds = Object.keys(curveOtks);
    if (otkKeyIds.length > 0) {
      var oneTimeKeysObj = {};
      for (var i = 0; i < otkKeyIds.length; i++) {
        var keyId = otkKeyIds[i];
        var pubKey = curveOtks[keyId];
        var signedOtk = signMatrixJson({ key: pubKey }, activeUserId, activeDeviceId);
        oneTimeKeysObj["signed_curve25519:" + keyId] = signedOtk;
      }
      payload.one_time_keys = oneTimeKeysObj;
    }

    if (!payload.device_keys && !payload.one_time_keys) return null;
    return payload;
  }

  function markKeysUploaded(hadDeviceKeys, hadOneTimeKeys) {
    if (!olmAccount) return;
    if (hadDeviceKeys) {
      safeStorageSet("devkeys_uploaded_" + activeUserId + "_" + activeDeviceId, "1");
    }
    if (hadOneTimeKeys) {
      try {
        olmAccount.mark_keys_as_published();
        persistAccount();
      } catch (_) {}
    }
  }

  // =========================================================================
  // DEVICE DIRECTORY STORAGE (Includes ALL devices: verified & unverified)
  // =========================================================================

  function getKnownDevicesRoot() {
    try {
      return JSON.parse(safeStorageGet("known_devices_" + activeUserId, "{}"));
    } catch (_) {
      return {};
    }
  }

  function saveKnownDevicesRoot(root) {
    safeStorageSet("known_devices_" + activeUserId, JSON.stringify(root));
  }

  /**
   * Processes `/_matrix/client/v3/keys/query` response and stores ALL member devices
   * (both verified and unverified) so Megolm keys are shared with every device in the room.
   */
  function processKeysQueryResponse(resp) {
    var deviceKeysRoot = (resp && resp.device_keys) || {};
    var storedRoot = getKnownDevicesRoot();
    var resultList = [];

    var userIds = Object.keys(deviceKeysRoot);
    for (var uIdx = 0; uIdx < userIds.length; uIdx++) {
      var uid = userIds[uIdx];
      var userDevs = deviceKeysRoot[uid] || {};
      if (!storedRoot[uid]) storedRoot[uid] = {};

      var devIds = Object.keys(userDevs);
      for (var dIdx = 0; dIdx < devIds.length; dIdx++) {
        var did = devIds[dIdx];
        var devObj = userDevs[did];
        if (!devObj || devObj.user_id !== uid || devObj.device_id !== did) continue;
        var keys = devObj.keys || {};
        var curveKey = keys["curve25519:" + did];
        var edKey = keys["ed25519:" + did];
        if (!curveKey || !edKey) continue;

        var sigVerified = verifyMatrixJsonSignature(devObj, uid, did, edKey);
        var prev = storedRoot[uid][did];
        var manuallyVerified = Boolean(prev && prev.manuallyVerified);

        // Protect against Ed25519 key replacement for same deviceId
        if (prev && prev.ed25519Key && prev.ed25519Key !== edKey) {
          continue;
        }

        var displayName =
          (devObj.unsigned && devObj.unsigned.device_display_name) || did;

        var record = {
          userId: uid,
          deviceId: did,
          curve25519Key: curveKey,
          ed25519Key: edKey,
          displayName: displayName,
          signatureVerified: sigVerified,
          manuallyVerified: manuallyVerified,
          formattedFingerprint: edKey.replace(/(.{4})/g, "$1 ").trim()
        };
        storedRoot[uid][did] = record;
        resultList.push(record);
      }
    }

    saveKnownDevicesRoot(storedRoot);
    return resultList;
  }

  function getKnownDevicesForUsers(userIds) {
    var storedRoot = getKnownDevicesRoot();
    var list = [];
    for (var i = 0; i < userIds.length; i++) {
      var uid = userIds[i];
      var userDevs = storedRoot[uid] || {};
      var devIds = Object.keys(userDevs);
      for (var j = 0; j < devIds.length; j++) {
        list.push(userDevs[devIds[j]]);
      }
    }
    return list;
  }

  function setDeviceManuallyVerified(userId, deviceId, verified) {
    var storedRoot = getKnownDevicesRoot();
    if (!storedRoot[userId] || !storedRoot[userId][deviceId]) return null;
    storedRoot[userId][deviceId].manuallyVerified = Boolean(verified);
    saveKnownDevicesRoot(storedRoot);
    return storedRoot[userId][deviceId];
  }

  // =========================================================================
  // OLM 1-TO-1 SESSIONS (Pickled in LocalStorage)
  // =========================================================================

  function getOlmSessionsVault() {
    try {
      return JSON.parse(safeStorageGet("olm_sessions_" + activeUserId, "{}"));
    } catch (_) {
      return {};
    }
  }

  function saveOlmSessionsVault(vault) {
    safeStorageSet("olm_sessions_" + activeUserId, JSON.stringify(vault));
  }

  function hasOlmSessionForCurveKey(curveKey) {
    var vault = getOlmSessionsVault();
    var arr = vault[curveKey];
    return Array.isArray(arr) && arr.length > 0;
  }

  function saveOlmSession(curveKey, session) {
    var vault = getOlmSessionsVault();
    var existing = Array.isArray(vault[curveKey]) ? vault[curveKey] : [];
    var pickled = session.pickle(PICKLE_KEY);
    var sessionId = session.session_id();
    var filtered = existing.filter(function (item) {
      return item.id !== sessionId;
    });
    filtered.unshift({ id: sessionId, pickle: pickled });
    vault[curveKey] = filtered.slice(0, 4);
    saveOlmSessionsVault(vault);
  }

  /**
   * Processes `/_matrix/client/v3/keys/claim` response and creates outbound Olm sessions
   * for all claimed `signed_curve25519` keys.
   */
  function processClaimedOneTimeKeys(claimResp, deviceMapByUserAndId) {
    var otkRoot = (claimResp && claimResp.one_time_keys) || {};
    var userIds = Object.keys(otkRoot);
    for (var i = 0; i < userIds.length; i++) {
      var uid = userIds[i];
      var devsObj = otkRoot[uid] || {};
      var devIds = Object.keys(devsObj);
      for (var j = 0; j < devIds.length; j++) {
        var did = devIds[j];
        var devRecord = deviceMapByUserAndId[uid + "|" + did];
        if (!devRecord) continue;
        var keyContainer = devsObj[did] || {};
        var keyNames = Object.keys(keyContainer);
        for (var k = 0; k < keyNames.length; k++) {
          var keyFullName = keyNames[k];
          var keyVal = keyContainer[keyFullName];
          var oneTimeKeyStr =
            typeof keyVal === "string" ? keyVal : keyVal && keyVal.key;
          if (!oneTimeKeyStr) continue;

          // Create outbound 1-to-1 Olm session with this device
          var session = new window.Olm.Session();
          try {
            session.create_outbound(olmAccount, devRecord.curve25519Key, oneTimeKeyStr);
            saveOlmSession(devRecord.curve25519Key, session);
          } catch (_) {
            try {
              session.free();
            } catch (e2) {}
          }
        }
      }
    }
  }

  /**
   * Encrypts any arbitrary to-device payload (such as `m.room_key` or `m.forwarded_room_key`)
   * using Olm (`m.olm.v1.curve25519-aes-sha2`) for a specific recipient device.
   */
  function encryptOlmToDeviceEvent(recipientDevice, eventType, eventContent) {
    var vault = getOlmSessionsVault();
    var arr = vault[recipientDevice.curve25519Key];
    if (!Array.isArray(arr) || arr.length === 0) return null;

    var session = new window.Olm.Session();
    try {
      session.unpickle(PICKLE_KEY, arr[0].pickle);
      var myKeys = getIdentityKeys();
      var olmPlaintext = {
        sender: activeUserId,
        sender_device: activeDeviceId,
        keys: {
          ed25519: myKeys.ed25519
        },
        recipient: recipientDevice.userId,
        recipient_keys: {
          ed25519: recipientDevice.ed25519Key
        },
        type: eventType,
        content: eventContent
      };

      var encrypted = session.encrypt(JSON.stringify(olmPlaintext));
      saveOlmSession(recipientDevice.curve25519Key, session);

      var ciphertextMap = {};
      ciphertextMap[recipientDevice.curve25519Key] = {
        type: encrypted.type,
        body: encrypted.body
      };

      return {
        algorithm: window.RUN_CONFIG.OLM_ALGORITHM,
        sender_key: myKeys.curve25519,
        ciphertext: ciphertextMap
      };
    } catch (_) {
      return null;
    } finally {
      try {
        session.free();
      } catch (_) {}
    }
  }

  // =========================================================================
  // MEGOLM OUTBOUND & INBOUND SESSIONS + KEY SHARING & KEY REQUEST RESPONDER
  // =========================================================================

  function getOutboundMegolmVault() {
    try {
      return JSON.parse(safeStorageGet("megolm_out_" + activeUserId, "{}"));
    } catch (_) {
      return {};
    }
  }

  function saveOutboundMegolmVault(vault) {
    safeStorageSet("megolm_out_" + activeUserId, JSON.stringify(vault));
  }

  function getInboundMegolmVault() {
    try {
      return JSON.parse(safeStorageGet("megolm_in_" + activeUserId, "{}"));
    } catch (_) {
      return {};
    }
  }

  function saveInboundMegolmVault(vault) {
    safeStorageSet("megolm_in_" + activeUserId, JSON.stringify(vault));
  }

  function getSharedTargetsVault() {
    try {
      return JSON.parse(safeStorageGet("megolm_shared_" + activeUserId, "{}"));
    } catch (_) {
      return {};
    }
  }

  function saveSharedTargetsVault(vault) {
    safeStorageSet("megolm_shared_" + activeUserId, JSON.stringify(vault));
  }

  function storeInboundGroupSession(roomId, sessionId, senderKey, inboundSession, senderClaimedEd25519) {
    var vault = getInboundMegolmVault();
    var firstKnown = inboundSession.first_known_index();
    var exportedKey = inboundSession.export_session(firstKnown);
    var pickled = inboundSession.pickle(PICKLE_KEY);
    var myKeys = getIdentityKeys();

    vault[roomId + "|" + sessionId] = {
      roomId: roomId,
      sessionId: sessionId,
      senderKey: senderKey || myKeys.curve25519,
      senderClaimedEd25519: senderClaimedEd25519 || myKeys.ed25519,
      firstKnownIndex: firstKnown,
      exportedSessionKey: exportedKey,
      pickle: pickled
    };
    saveInboundMegolmVault(vault);
  }

  function getOrCreateOutboundRoomSessionData(roomId, forceRotate) {
    var outVault = getOutboundMegolmVault();
    var existing = outVault[roomId];

    if (existing && !forceRotate) {
      var restored = new window.Olm.OutboundGroupSession();
      try {
        restored.unpickle(PICKLE_KEY, existing.pickle);
        if (restored.message_index() < 200) {
          var sid = restored.session_id();
          var skey = restored.session_key();
          var idx = restored.message_index();
          return {
            roomId: roomId,
            sessionId: sid,
            sessionKey: skey,
            chainIndex: idx,
            outboundSession: restored
          };
        }
      } catch (_) {}
      try {
        restored.free();
      } catch (_) {}
    }

    var fresh = new window.Olm.OutboundGroupSession();
    fresh.create();
    var sessionId = fresh.session_id();
    var sessionKey = fresh.session_key();
    var chainIndex = fresh.message_index();

    outVault[roomId] = {
      sessionId: sessionId,
      pickle: fresh.pickle(PICKLE_KEY),
      createdAt: Date.now()
    };
    saveOutboundMegolmVault(outVault);

    // Also register an InboundGroupSession for our own outbound session so we can
    // decrypt our own history and export/forward keys when requested!
    var selfInbound = new window.Olm.InboundGroupSession();
    try {
      selfInbound.create(sessionKey);
      storeInboundGroupSession(
        roomId,
        sessionId,
        getIdentityKeys().curve25519,
        selfInbound,
        getIdentityKeys().ed25519
      );
    } finally {
      try {
        selfInbound.free();
      } catch (_) {}
    }

    return {
      roomId: roomId,
      sessionId: sessionId,
      sessionKey: sessionKey,
      chainIndex: chainIndex,
      outboundSession: fresh
    };
  }

  function filterDevicesMissingSession(roomId, sessionId, devices, forceUserIds, forceDeviceKeys) {
    var sharedVault = getSharedTargetsVault();
    var key = roomId + "|" + sessionId;
    var sharedMap = sharedVault[key] || {};
    var forceUsersSet = new Set(forceUserIds || []);
    var forceDevKeySet = new Set(forceDeviceKeys || []);

    return devices.filter(function (dev) {
      if (dev.userId === activeUserId && dev.deviceId === activeDeviceId) {
        return false;
      }
      if (forceUsersSet.has(dev.userId) || forceDevKeySet.has(dev.curve25519Key)) {
        return true;
      }
      return !sharedMap[dev.userId + "|" + dev.deviceId];
    });
  }

  function markDevicesReceivedSession(roomId, sessionId, devices) {
    var sharedVault = getSharedTargetsVault();
    var key = roomId + "|" + sessionId;
    if (!sharedVault[key]) sharedVault[key] = {};
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      sharedVault[key][d.userId + "|" + d.deviceId] = true;
    }
    saveSharedTargetsVault(sharedVault);
  }

  function clearSharedSessionCacheForRoom(roomId) {
    var sharedVault = getSharedTargetsVault();
    Object.keys(sharedVault).forEach(function (k) {
      if (k.startsWith(roomId + "|")) {
        delete sharedVault[k];
      }
    });
    saveSharedTargetsVault(sharedVault);
  }

  /**
   * Builds Olm-encrypted `m.room_key` to-device payload for a target device.
   */
  function buildOlmRoomKeyEvent(recipientDevice, sessionData) {
    var content = {
      algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM,
      room_id: sessionData.roomId,
      session_id: sessionData.sessionId,
      session_key: sessionData.sessionKey,
      chain_index: sessionData.chainIndex
    };
    return encryptOlmToDeviceEvent(recipientDevice, "m.room_key", content);
  }

  /**
   * Builds Olm-encrypted `m.forwarded_room_key` to-device payload when answering
   * an incoming `m.room_key_request` from Element, Cinny, or Run.
   */
  function buildOlmForwardedRoomKeyEvent(recipientDevice, roomId, sessionId) {
    var inVault = getInboundMegolmVault();
    var entry = inVault[roomId + "|" + sessionId];
    if (!entry) {
      // Fallback: search by sessionId across all rooms
      var allKeys = Object.keys(inVault);
      for (var i = 0; i < allKeys.length; i++) {
        if (allKeys[i].endsWith("|" + sessionId)) {
          entry = inVault[allKeys[i]];
          break;
        }
      }
    }
    if (!entry || !entry.exportedSessionKey) return null;

    var forwardedContent = {
      algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM,
      room_id: entry.roomId || roomId,
      session_id: sessionId,
      session_key: entry.exportedSessionKey,
      sender_key: entry.senderKey || getIdentityKeys().curve25519,
      sender_claimed_ed25519_key: entry.senderClaimedEd25519 || getIdentityKeys().ed25519,
      forwarding_curve25519_key_chain: []
    };
    return encryptOlmToDeviceEvent(recipientDevice, "m.forwarded_room_key", forwardedContent);
  }

  /**
   * Encrypts a plaintext chat message into a standard Matrix `m.room.encrypted`
   * (`m.megolm.v1.aes-sha2`) event content object interoperable with Element and Cinny.
   */
  function encryptMegolmMessage(roomId, plaintext) {
    var sessionData = getOrCreateOutboundRoomSessionData(roomId, false);
    var outbound = sessionData.outboundSession;
    try {
      var innerEvent = {
        type: "m.room.message",
        room_id: roomId,
        content: {
          msgtype: "m.text",
          body: plaintext
        }
      };
      var ciphertext = outbound.encrypt(JSON.stringify(innerEvent));

      // Save updated outbound ratchet state
      var outVault = getOutboundMegolmVault();
      outVault[roomId] = {
        sessionId: sessionData.sessionId,
        pickle: outbound.pickle(PICKLE_KEY),
        createdAt: Date.now()
      };
      saveOutboundMegolmVault(outVault);

      return {
        algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM,
        sender_key: getIdentityKeys().curve25519,
        ciphertext: ciphertext,
        session_id: sessionData.sessionId,
        device_id: activeDeviceId
      };
    } finally {
      try {
        outbound.free();
      } catch (_) {}
    }
  }

  /**
   * Decrypts a standard Matrix `m.room.encrypted` (`m.megolm.v1.aes-sha2`) timeline event.
   */
  function decryptMegolmEvent(roomId, senderUserId, content) {
    var alg = content && content.algorithm;
    var sessionId = content && content.session_id;
    var senderKey = content && content.sender_key;
    var ciphertext = content && content.ciphertext;

    if (alg !== window.RUN_CONFIG.MEGOLM_ALGORITHM || !sessionId || !ciphertext) {
      return {
        body: "🔒 رسالة مشفرة بصيغة غير مدعومة",
        decryptionFailed: true,
        missingSessionId: sessionId || "",
        senderKey: senderKey || ""
      };
    }

    var inVault = getInboundMegolmVault();
    var entry = inVault[roomId + "|" + sessionId];
    if (!entry) {
      var keys = Object.keys(inVault);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].endsWith("|" + sessionId)) {
          entry = inVault[keys[i]];
          break;
        }
      }
    }

    if (!entry) {
      return {
        body: "🔒 رسالة مشفرة (Megolm) — جاري طلب مفتاح الجلسة من المرسل…",
        decryptionFailed: true,
        missingSessionId: sessionId,
        senderKey: senderKey || ""
      };
    }

    var inbound = new window.Olm.InboundGroupSession();
    try {
      if (entry.pickle) {
        inbound.unpickle(PICKLE_KEY, entry.pickle);
      } else if (entry.exportedSessionKey) {
        inbound.import_session(entry.exportedSessionKey);
      } else {
        return {
          body: "🔒 مفتاح الجلسة غير مكتمل",
          decryptionFailed: true,
          missingSessionId: sessionId,
          senderKey: senderKey || ""
        };
      }

      var decResult = inbound.decrypt(ciphertext);
      var parsed = JSON.parse(decResult.plaintext);
      var body = (parsed && parsed.content && parsed.content.body) || "";

      return {
        body: body || "(رسالة مشفرة فارغة)",
        decryptionFailed: false,
        missingSessionId: "",
        senderKey: senderKey || ""
      };
    } catch (_) {
      return {
        body: "🔒 تعذر فك تشفير الرسالة — اضغط لطلب مفتاح الجلسة",
        decryptionFailed: true,
        missingSessionId: sessionId,
        senderKey: senderKey || ""
      };
    } finally {
      try {
        inbound.free();
      } catch (_) {}
    }
  }

  /**
   * Decrypts incoming Olm to-device messages (`m.room.encrypted`) and extracts:
   * - `m.room_key` (new Megolm session shared by Element/Cinny/Run)
   * - `m.forwarded_room_key` (forwarded Megolm session in response to `m.room_key_request`)
   * - `m.room_key_request` (key request sent over Olm)
   * Returns a list of incoming key requests that need to be answered.
   */
  function processIncomingToDeviceEvents(toDeviceEvents) {
    if (!Array.isArray(toDeviceEvents) || toDeviceEvents.length === 0 || !olmAccount) {
      return [];
    }

    var myKeys = getIdentityKeys();
    var myCurveKey = myKeys.curve25519;
    var pendingKeyRequestsToAnswer = [];
    var newlyReceivedSessions = [];

    function handleDecryptedToDeviceEvent(senderUserId, senderCurveKey, innerEvent) {
      if (!innerEvent || typeof innerEvent !== "object") return;
      var innerType = innerEvent.type;
      var innerContent = innerEvent.content || {};

      if (
        innerType === "m.room_key" &&
        innerContent.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM
      ) {
        var rId = innerContent.room_id;
        var sId = innerContent.session_id;
        var sKey = innerContent.session_key;
        var claimedEd = (innerEvent.keys && innerEvent.keys.ed25519) || "";
        if (rId && sId && sKey) {
          var inbound = new window.Olm.InboundGroupSession();
          try {
            inbound.create(sKey);
            storeInboundGroupSession(rId, sId, senderCurveKey, inbound, claimedEd);
            newlyReceivedSessions.push({ roomId: rId, sessionId: sId });
          } catch (_) {
          } finally {
            try {
              inbound.free();
            } catch (_) {}
          }
        }
      } else if (
        innerType === "m.forwarded_room_key" &&
        innerContent.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM
      ) {
        var fRoomId = innerContent.room_id;
        var fSessId = innerContent.session_id;
        var fExportedKey = innerContent.session_key;
        var fSenderKey = innerContent.sender_key || senderCurveKey;
        var fClaimedEd = innerContent.sender_claimed_ed25519_key || "";
        if (fRoomId && fSessId && fExportedKey) {
          var imported = new window.Olm.InboundGroupSession();
          try {
            imported.import_session(fExportedKey);
            storeInboundGroupSession(fRoomId, fSessId, fSenderKey, imported, fClaimedEd);
            newlyReceivedSessions.push({ roomId: fRoomId, sessionId: fSessId });
          } catch (_) {
          } finally {
            try {
              imported.free();
            } catch (_) {}
          }
        }
      } else if (innerType === "m.room_key_request") {
        if (
          innerContent.action === "request" &&
          innerContent.body &&
          innerContent.body.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM
        ) {
          pendingKeyRequestsToAnswer.push({
            requesterUserId: senderUserId,
            requestingDeviceId: innerContent.requesting_device_id,
            roomId: innerContent.body.room_id,
            sessionId: innerContent.body.session_id,
            senderKey: innerContent.body.sender_key
          });
        }
      }
    }

    for (var i = 0; i < toDeviceEvents.length; i++) {
      var ev = toDeviceEvents[i];
      if (!ev) continue;
      var evType = ev.type;
      var senderUser = ev.sender || "";
      var content = ev.content || {};

      // 1. Plaintext `m.room_key_request` to-device event from Element/Cinny
      if (evType === "m.room_key_request") {
        if (
          content.action === "request" &&
          content.body &&
          content.body.algorithm === window.RUN_CONFIG.MEGOLM_ALGORITHM
        ) {
          pendingKeyRequestsToAnswer.push({
            requesterUserId: senderUser,
            requestingDeviceId: content.requesting_device_id,
            roomId: content.body.room_id,
            sessionId: content.body.session_id,
            senderKey: content.body.sender_key
          });
        }
        continue;
      }

      // 2. Olm-encrypted `m.room.encrypted` to-device event
      if (
        evType === window.RUN_CONFIG.ROOM_EVENT_ENCRYPTED &&
        content.algorithm === window.RUN_CONFIG.OLM_ALGORITHM
      ) {
        var senderCurveKey = content.sender_key;
        var cipherMap = content.ciphertext || {};
        var myCipher = cipherMap[myCurveKey];
        if (!senderCurveKey || !myCipher || !myCipher.body) continue;

        var decryptedStr = decryptOlmMessageInternal(
          senderCurveKey,
          myCipher.type,
          myCipher.body
        );
        if (decryptedStr) {
          try {
            var innerJson = JSON.parse(decryptedStr);
            handleDecryptedToDeviceEvent(senderUser, senderCurveKey, innerJson);
          } catch (_) {}
        }
      }
    }

    if (newlyReceivedSessions.length > 0 && typeof onRoomKeyReceivedCallback === "function") {
      try {
        onRoomKeyReceivedCallback(newlyReceivedSessions);
      } catch (_) {}
    }

    return pendingKeyRequestsToAnswer;
  }

  function decryptOlmMessageInternal(senderCurveKey, msgType, msgBody) {
    var vault = getOlmSessionsVault();
    var existingList = Array.isArray(vault[senderCurveKey]) ? vault[senderCurveKey] : [];

    // 1. Try existing Olm sessions
    for (var i = 0; i < existingList.length; i++) {
      var session = new window.Olm.Session();
      try {
        session.unpickle(PICKLE_KEY, existingList[i].pickle);
        if (msgType === 0) {
          if (session.matches_inbound_from(senderCurveKey, msgBody)) {
            var plain0 = session.decrypt(msgType, msgBody);
            saveOlmSession(senderCurveKey, session);
            return plain0;
          }
        } else {
          var plain1 = session.decrypt(msgType, msgBody);
          saveOlmSession(senderCurveKey, session);
          return plain1;
        }
      } catch (_) {
      } finally {
        try {
          session.free();
        } catch (_) {}
      }
    }

    // 2. If Pre-Key message (type === 0), create new inbound Olm session
    if (msgType === 0) {
      var newSession = new window.Olm.Session();
      try {
        newSession.create_inbound_from(olmAccount, senderCurveKey, msgBody);
        try {
          olmAccount.remove_one_time_keys(newSession);
          persistAccount();
        } catch (_) {}
        var plainNew = newSession.decrypt(msgType, msgBody);
        saveOlmSession(senderCurveKey, newSession);
        return plainNew;
      } catch (_) {
        return null;
      } finally {
        try {
          newSession.free();
        } catch (_) {}
      }
    }

    return null;
  }

  // =========================================================================
  // 6-DIGIT PIN KEY BACKUP (PBKDF2-HMAC-SHA256 + AES-256-GCM on Megolm Exports)
  // =========================================================================

  function bytesToBase64(bytes) {
    var bin = "";
    var arr = new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) {
      bin += String.fromCharCode(arr[i]);
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  async function deriveAesKeyFromPin(pin, saltBytes) {
    var enc = new TextEncoder();
    var baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(pin),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: 120000,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function exportAllMegolmSessionsForBackup() {
    var inVault = getInboundMegolmVault();
    var sessions = [];
    var keys = Object.keys(inVault);
    for (var i = 0; i < keys.length; i++) {
      var item = inVault[keys[i]];
      if (!item || !item.roomId || !item.sessionId || !item.exportedSessionKey) continue;
      sessions.push({
        algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM,
        room_id: item.roomId,
        session_id: item.sessionId,
        sender_key: item.senderKey || "",
        first_known_index: item.firstKnownIndex || 0,
        session_key: item.exportedSessionKey
      });
    }
    return {
      format: "matrix_megolm_export_v2",
      sessions: sessions
    };
  }

  function importMegolmSessionsFromBackup(decryptedObj) {
    var sessions = (decryptedObj && decryptedObj.sessions) || [];
    var importedCount = 0;
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var rId = s.room_id;
      var sId = s.session_id;
      var expKey = s.session_key;
      if (!rId || !sId || !expKey) continue;

      var inbound = new window.Olm.InboundGroupSession();
      try {
        inbound.import_session(expKey);
        storeInboundGroupSession(rId, sId, s.sender_key || "", inbound, "");
        importedCount++;
      } catch (_) {
      } finally {
        try {
          inbound.free();
        } catch (_) {}
      }
    }
    return importedCount;
  }

  async function createEncryptedPinBackupPayload(pin, userId) {
    if (!/^\d{6}$/.test(pin)) {
      throw new Error("رمز PIN يجب أن يتكون من 6 أرقام");
    }
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var aesKey = await deriveAesKeyFromPin(pin, salt);
    var enc = new TextEncoder();

    var exportedVault = exportAllMegolmSessionsForBackup();
    var plaintextBytes = enc.encode(JSON.stringify(exportedVault));
    var aadBytes = enc.encode(userId);

    var cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv, additionalData: aadBytes, tagLength: 128 },
      aesKey,
      plaintextBytes
    );

    safeStorageSet("pin_configured_" + userId, "1");

    return {
      version: 2,
      algorithm: "PBKDF2-SHA256-AES256-GCM",
      megolm_algorithm: window.RUN_CONFIG.MEGOLM_ALGORITHM,
      iterations: 120000,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(cipherBuffer),
      updated_at: Date.now()
    };
  }

  async function restoreFromEncryptedPinBackupPayload(pin, userId, payload) {
    if (!/^\d{6}$/.test(pin)) {
      throw new Error("رمز PIN يجب أن يتكون من 6 أرقام");
    }
    if (!payload || !payload.salt || !payload.iv || !payload.ciphertext) {
      throw new Error("لا توجد نسخة مفاتيح احتياطية محفوظة لهذا الحساب");
    }

    var salt = base64ToBytes(payload.salt);
    var iv = base64ToBytes(payload.iv);
    var cipherBytes = base64ToBytes(payload.ciphertext);
    var aesKey = await deriveAesKeyFromPin(pin, salt);
    var enc = new TextEncoder();
    var dec = new TextDecoder();

    var plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv, additionalData: enc.encode(userId), tagLength: 128 },
      aesKey,
      cipherBytes
    );

    var parsed = JSON.parse(dec.decode(plainBuffer));
    var count = importMegolmSessionsFromBackup(parsed);
    safeStorageSet("pin_configured_" + userId, "1");
    return count;
  }

  function isPinConfigured(userId) {
    return safeStorageGet("pin_configured_" + userId, "") === "1";
  }

  function setOnRoomKeyReceived(cb) {
    onRoomKeyReceivedCallback = cb;
  }

  return {
    initCryptoLibraries: initCryptoLibraries,
    initAccount: initAccount,
    getIdentityKeys: getIdentityKeys,
    getFormattedFingerprint: getFormattedFingerprint,
    toCanonicalJson: toCanonicalJson,
    signMatrixJson: signMatrixJson,
    verifyMatrixJsonSignature: verifyMatrixJsonSignature,
    buildKeysUploadPayload: buildKeysUploadPayload,
    markKeysUploaded: markKeysUploaded,
    processKeysQueryResponse: processKeysQueryResponse,
    getKnownDevicesForUsers: getKnownDevicesForUsers,
    setDeviceManuallyVerified: setDeviceManuallyVerified,
    hasOlmSessionForCurveKey: hasOlmSessionForCurveKey,
    processClaimedOneTimeKeys: processClaimedOneTimeKeys,
    getOrCreateOutboundRoomSessionData: getOrCreateOutboundRoomSessionData,
    filterDevicesMissingSession: filterDevicesMissingSession,
    markDevicesReceivedSession: markDevicesReceivedSession,
    clearSharedSessionCacheForRoom: clearSharedSessionCacheForRoom,
    buildOlmRoomKeyEvent: buildOlmRoomKeyEvent,
    buildOlmForwardedRoomKeyEvent: buildOlmForwardedRoomKeyEvent,
    encryptMegolmMessage: encryptMegolmMessage,
    decryptMegolmEvent: decryptMegolmEvent,
    processIncomingToDeviceEvents: processIncomingToDeviceEvents,
    createEncryptedPinBackupPayload: createEncryptedPinBackupPayload,
    restoreFromEncryptedPinBackupPayload: restoreFromEncryptedPinBackupPayload,
    isPinConfigured: isPinConfigured,
    setOnRoomKeyReceived: setOnRoomKeyReceived
  };
})();
