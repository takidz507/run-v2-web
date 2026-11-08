/**
 * Internal configuration for Run v2 Web.
 * STRICT RULE: Never expose HOMESERVER_BASE_URL, SERVER_DOMAIN, "Matrix",
 * or "unredacted.org" in any user-facing UI string.
 */
window.RUN_CONFIG = (function () {
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

  function toLocalpart(handleOrUserId) {
    var raw = String(handleOrUserId || "").trim();
    if (raw.startsWith("@")) raw = raw.slice(1);
    return raw.split(":")[0].toLowerCase();
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

  function toInternalRoomAliasOrId(codeOrLink) {
    var cleaned = String(codeOrLink || "")
      .trim()
      .replace(/^run:\/\/join\//i, "")
      .replace(/^run:\/\/friend\//i, "")
      .trim();
    if (cleaned.startsWith("!") && cleaned.indexOf(":") !== -1) {
      return cleaned;
    }
    var aliasLocal = cleaned.replace(/^#/, "").split(":")[0].toLowerCase();
    return "#" + aliasLocal + ":" + SERVER_DOMAIN;
  }

  function toPublicRoomCode(aliasOrRoomId) {
    if (!aliasOrRoomId) return "";
    var raw = String(aliasOrRoomId)
      .trim()
      .replace(/^#/, "")
      .replace(/^!/, "")
      .split(":")[0];
    return raw.toUpperCase();
  }

  function buildRoomInviteLink(roomCode) {
    return "run://join/" + String(roomCode || "").trim();
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
    HOMESERVER_BASE_URL: HOMESERVER_BASE_URL,
    SERVER_DOMAIN: SERVER_DOMAIN,
    ACCOUNT_DATA_KEY_BACKUP_EVENT: ACCOUNT_DATA_KEY_BACKUP_EVENT,
    ROOM_EVENT_ENCRYPTED: ROOM_EVENT_ENCRYPTED,
    OLM_ALGORITHM: OLM_ALGORITHM,
    MEGOLM_ALGORITHM: MEGOLM_ALGORITHM,
    toLocalpart: toLocalpart,
    toInternalUserId: toInternalUserId,
    toPublicHandle: toPublicHandle,
    toInternalRoomAliasOrId: toInternalRoomAliasOrId,
    toPublicRoomCode: toPublicRoomCode,
    buildRoomInviteLink: buildRoomInviteLink,
    buildFriendInviteLink: buildFriendInviteLink,
    avatarColorFor: avatarColorFor
  };
})();
