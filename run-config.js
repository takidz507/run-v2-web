/**
 * Internal configuration for Run v2 Web (v2.3.2).
 * STRICT RULE: Never expose HOMESERVER_BASE_URL, SERVER_DOMAIN, "Matrix",
 * or "unredacted.org" in any user-facing UI string.
 */
window.RUN_CONFIG = (function () {
  var APP_VERSION = "2.3.2";
  var HOMESERVER_BASE_URL = "https://matrix.unredacted.org";
  var SERVER_DOMAIN = "unredacted.org";
  var ACCOUNT_DATA_KEY_BACKUP_EVENT = "m.runv2.key_backup.v2";
  var ROOM_EVENT_ENCRYPTED = "m.room.encrypted";
  var OLM_ALGORITHM = "m.olm.v1.curve25519-aes-sha2";
  var MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

  var AVATAR_COLORS = [
    "#8a6d3b",
    "#4e7a51",
    "#7a5c8f",
    "#3f6d8e",
    "#a0526b",
    "#d95d28"
  ];

  /**
   * Strips invisible Unicode bidirectional control characters (\u200B-\u200F,
   * \u202A-\u202E, \u2060-\u206F, \uFEFF) and surrounding whitespace that
   * mobile browsers often include when copying text from RTL Arabic layouts.
   */
  function stripInvisibleAndTrim(input) {
    return String(input || "")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .trim();
  }

  function toLocalpart(handleOrUserId) {
    var raw = stripInvisibleAndTrim(handleOrUserId);
    raw = raw.replace(/^run:\/\/friend\//i, "").trim();
    if (raw.startsWith("@")) raw = raw.slice(1);
    return raw.split(":")[0].trim().toLowerCase();
  }

  function toInternalUserId(handleOrLocalpart) {
    var localpart = toLocalpart(handleOrLocalpart);
    if (!localpart) return "";
    return "@" + localpart + ":" + SERVER_DOMAIN;
  }

  function toPublicHandle(internalUserId) {
    var localpart = toLocalpart(internalUserId);
    return localpart ? "@" + localpart : "@user";
  }

  /**
   * Extracts a clean room code or room ID from any user input:
   * - `run://join/AGEN-9641` -> `AGEN-9641`
   * - `#/join/AGEN-9641` -> `AGEN-9641`
   * - `#agen-9641:unredacted.org` -> `agen-9641`
   * - `!roomId:unredacted.org` -> `!roomId:unredacted.org`
   */
  function cleanRoomCodeOrIdInput(codeOrLink) {
    var cleaned = stripInvisibleAndTrim(codeOrLink)
      .replace(/^https?:\/\/[^/]+\/(?:#\/join\/|\?join=)/i, "")
      .replace(/^run:\/\/join\//i, "")
      .replace(/^run:\/\/friend\//i, "")
      .replace(/^#\/join\//i, "")
      .trim();
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch (_) {}
    cleaned = stripInvisibleAndTrim(cleaned);
    if (cleaned.startsWith("!") && cleaned.indexOf(":") !== -1) {
      return cleaned;
    }
    return cleaned.replace(/^#/, "").split(":")[0].trim();
  }

  function toInternalRoomAliasOrId(codeOrLink) {
    var cleaned = cleanRoomCodeOrIdInput(codeOrLink);
    if (!cleaned) return "";
    if (cleaned.startsWith("!") && cleaned.indexOf(":") !== -1) {
      return cleaned;
    }
    return "#" + cleaned.toLowerCase() + ":" + SERVER_DOMAIN;
  }

  /**
   * Returns candidate aliases `[lowercase, uppercase, exact]` for a room code
   * so alias lookup/join succeeds regardless of alias case on the server.
   */
  function getCandidateRoomAliases(codeOrLink) {
    var cleaned = cleanRoomCodeOrIdInput(codeOrLink);
    if (!cleaned || (cleaned.startsWith("!") && cleaned.indexOf(":") !== -1)) {
      return [];
    }
    var lower = "#" + cleaned.toLowerCase() + ":" + SERVER_DOMAIN;
    var upper = "#" + cleaned.toUpperCase() + ":" + SERVER_DOMAIN;
    var exact = "#" + cleaned + ":" + SERVER_DOMAIN;
    return Array.from(new Set([lower, upper, exact]));
  }

  function toPublicRoomCode(aliasOrRoomId) {
    if (!aliasOrRoomId) return "";
    var raw = stripInvisibleAndTrim(aliasOrRoomId)
      .replace(/^run:\/\/join\//i, "")
      .replace(/^#/, "")
      .replace(/^!/, "")
      .split(":")[0]
      .trim();
    return raw.toUpperCase();
  }

  function looksLikeRoomCode(input) {
    var cleaned = cleanRoomCodeOrIdInput(input);
    if (!cleaned || cleaned.indexOf(" ") !== -1) return false;
    return /^[A-Za-z0-9]{2,12}-[A-Za-z0-9]{2,12}$/.test(cleaned);
  }

  function buildRoomInviteLink(roomCode) {
    return "run://join/" + stripInvisibleAndTrim(roomCode);
  }

  function buildFriendInviteLink(publicHandle) {
    return "run://friend/" + toPublicHandle(publicHandle);
  }

  function avatarColorFor(seed) {
    var str = String(seed || "run");
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) & 0x7fffffff;
    }
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  return {
    APP_VERSION: APP_VERSION,
    HOMESERVER_BASE_URL: HOMESERVER_BASE_URL,
    SERVER_DOMAIN: SERVER_DOMAIN,
    ACCOUNT_DATA_KEY_BACKUP_EVENT: ACCOUNT_DATA_KEY_BACKUP_EVENT,
    ROOM_EVENT_ENCRYPTED: ROOM_EVENT_ENCRYPTED,
    OLM_ALGORITHM: OLM_ALGORITHM,
    MEGOLM_ALGORITHM: MEGOLM_ALGORITHM,
    stripInvisibleAndTrim: stripInvisibleAndTrim,
    cleanRoomCodeOrIdInput: cleanRoomCodeOrIdInput,
    toLocalpart: toLocalpart,
    toInternalUserId: toInternalUserId,
    toPublicHandle: toPublicHandle,
    toInternalRoomAliasOrId: toInternalRoomAliasOrId,
    getCandidateRoomAliases: getCandidateRoomAliases,
    toPublicRoomCode: toPublicRoomCode,
    looksLikeRoomCode: looksLikeRoomCode,
    buildRoomInviteLink: buildRoomInviteLink,
    buildFriendInviteLink: buildFriendInviteLink,
    avatarColorFor: avatarColorFor
  };
})();
