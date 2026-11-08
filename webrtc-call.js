/**
 * Run v2 Web (v2.3.1) — Real 1-to-1 WebRTC Video & Voice Call Engine.
 *
 * Uses browser `RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`:
 * - Supports dynamic TURN credentials from `/_matrix/client/v3/voip/turnServer`
 *   plus fallback STUN servers (`stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`)
 * - Respects quality settings:
 *   - `DEFAULT_480P` (854x480 @ 24fps, ~650 kbps)
 *   - `DATA_SAVER` (426x240 @ 15fps, ~250 kbps)
 *   - `AUDIO_ONLY` (audio only, zero video tracks)
 * - Separates media acquisition errors (`NotAllowedError`, `NotFoundError`, `NotReadableError`, etc.)
 *   from WebRTC PeerConnection / SDP setup errors so the caller can report the exact cause.
 */
window.RunWebRtcManager = (function () {
  var peerConnection = null;
  var localStream = null;
  var remoteStream = null;
  var pendingRemoteCandidates = [];
  var candidateFlushTimer = null;
  var outgoingCandidatesBuffer = [];

  var callbacks = {
    onLocalCandidates: null,
    onConnected: null,
    onEnded: null
  };

  function configureCallbacks(cbs) {
    callbacks = Object.assign(callbacks, cbs || {});
  }

  function buildIceServers(turnCredentials) {
    var iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ];
    if (
      turnCredentials &&
      Array.isArray(turnCredentials.uris) &&
      turnCredentials.uris.length > 0 &&
      turnCredentials.username &&
      turnCredentials.password
    ) {
      var validUris = turnCredentials.uris.filter(function (u) {
        return typeof u === "string" && /^(turns?|stuns?):/i.test(u.trim());
      });
      if (validUris.length > 0) {
        iceServers.push({
          urls: validUris,
          username: turnCredentials.username,
          credential: turnCredentials.password
        });
      }
    }
    return iceServers;
  }

  function buildMediaConstraints(qualityMode, requestedVideo) {
    var useVideo = Boolean(requestedVideo && qualityMode !== "AUDIO_ONLY");
    if (!useVideo) {
      return {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      };
    }

    if (qualityMode === "DATA_SAVER") {
      return {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 426, max: 480 },
          height: { ideal: 240, max: 270 },
          frameRate: { ideal: 15, max: 18 },
          facingMode: "user"
        }
      };
    }

    // Default 480p
    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: {
        width: { ideal: 854, max: 854 },
        height: { ideal: 480, max: 480 },
        frameRate: { ideal: 24, max: 24 },
        facingMode: "user"
      }
    };
  }

  /**
   * Maps any media (`getUserMedia`) error to a clear, honest Arabic explanation
   * while preserving `err.name` and `err.message`.
   */
  function describeMediaError(err, requestedVideo) {
    var name = (err && err.name) || "MediaError";
    var msg = (err && err.message) || "";
    var deviceLabel = requestedVideo ? "الميكروفون أو الكاميرا" : "الميكروفون";

    if (
      name === "NotAllowedError" ||
      name === "PermissionDeniedError" ||
      name === "SecurityError"
    ) {
      return (
        "تم رفض صلاحية الوصول إلى " +
        deviceLabel +
        " (" +
        name +
        ") — اضغط أيقونة القفل بجانب عنوان الموقع في المتصفح وفعّل الصلاحية ثم أعد المحاولة"
      );
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "لم يتم العثور على " + deviceLabel + " متصل بهذا الجهاز (" + name + ")";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return (
        "تعذر تشغيل " +
        deviceLabel +
        " لأنه قيد الاستخدام من تطبيق آخر (" +
        name +
        (msg ? ": " + msg : "") +
        ")"
      );
    }
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return "إعدادات جودة الكاميرا غير مدعومة على هذا الجهاز (" + name + ")";
    }
    return (
      "تعذر الوصول إلى " +
      deviceLabel +
      " (" +
      name +
      (msg ? ": " + msg : "") +
      ")"
    );
  }

  /**
   * Acquires local microphone (+ camera if video call) stream with fallback
   * for mobile browsers that reject strict constraints.
   */
  async function acquireLocalMediaStream(qualityMode, requestedVideo) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      var unsupErr = new Error(
        "المتصفح الحالي لا يدعم الوصول إلى الميكروفون/الكاميرا (يتطلب HTTPS أو متصفحًا داعمًا لـ WebRTC)"
      );
      unsupErr.stage = "MEDIA";
      unsupErr.name = "NotSupportedError";
      console.error("[RunWebRTC/Media]", unsupErr.name, unsupErr.message);
      throw unsupErr;
    }

    var useVideo = Boolean(requestedVideo && qualityMode !== "AUDIO_ONLY");
    var primaryConstraints = buildMediaConstraints(qualityMode, useVideo);

    try {
      return await navigator.mediaDevices.getUserMedia(primaryConstraints);
    } catch (err) {
      console.warn(
        "[RunWebRTC/Media] Primary getUserMedia failed:",
        err && err.name,
        err && err.message
      );
      // If mobile browser rejected ideal/max video or audio processing constraints, retry with minimal constraints
      if (
        err &&
        (err.name === "OverconstrainedError" ||
          err.name === "ConstraintNotSatisfiedError" ||
          err.name === "TypeError")
      ) {
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: useVideo ? { facingMode: "user" } : false
          });
        } catch (err2) {
          console.error(
            "[RunWebRTC/Media] Fallback getUserMedia failed:",
            err2 && err2.name,
            err2 && err2.message
          );
          var wrapped2 = new Error(describeMediaError(err2, useVideo));
          wrapped2.stage = "MEDIA";
          wrapped2.causeName = (err2 && err2.name) || "MediaError";
          wrapped2.causeMessage = (err2 && err2.message) || "";
          throw wrapped2;
        }
      }

      console.error(
        "[RunWebRTC/Media] getUserMedia error:",
        err && err.name,
        err && err.message
      );
      var wrapped = new Error(describeMediaError(err, useVideo));
      wrapped.stage = "MEDIA";
      wrapped.causeName = (err && err.name) || "MediaError";
      wrapped.causeMessage = (err && err.message) || "";
      throw wrapped;
    }
  }

  async function applyBitrateCap(pc, qualityMode) {
    if (!pc || typeof pc.getSenders !== "function") return;
    var maxBitrate =
      qualityMode === "DATA_SAVER" ? 250000 : qualityMode === "AUDIO_ONLY" ? 64000 : 650000;
    var senders = pc.getSenders();
    for (var i = 0; i < senders.length; i++) {
      var sender = senders[i];
      if (sender.track && sender.track.kind === "video" && typeof sender.getParameters === "function") {
        try {
          var params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = maxBitrate;
          await sender.setParameters(params);
        } catch (_) {}
      }
    }
  }

  function attachVideoElements(localVideoEl, remoteVideoEl) {
    if (localVideoEl) {
      localVideoEl.srcObject = localStream || null;
    }
    if (remoteVideoEl) {
      remoteVideoEl.srcObject = remoteStream || null;
    }
  }

  function createPeerConnection(turnCredentials, remoteVideoEl) {
    cleanupPeerConnectionOnly();
    remoteStream = new MediaStream();
    if (remoteVideoEl) {
      remoteVideoEl.srcObject = remoteStream;
    }

    var pc = null;
    try {
      pc = new RTCPeerConnection({
        iceServers: buildIceServers(turnCredentials)
      });
    } catch (turnErr) {
      console.warn(
        "[RunWebRTC/ICE] RTCPeerConnection with TURN failed, falling back to STUN:",
        turnErr && turnErr.name,
        turnErr && turnErr.message
      );
      pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });
    }

    pc.onicecandidate = function (event) {
      if (event.candidate) {
        outgoingCandidatesBuffer.push({
          sdpMid: event.candidate.sdpMid || "0",
          sdpMLineIndex: event.candidate.sdpMLineIndex || 0,
          candidate: event.candidate.candidate
        });
        if (!candidateFlushTimer) {
          candidateFlushTimer = setTimeout(function () {
            candidateFlushTimer = null;
            var batch = outgoingCandidatesBuffer.slice();
            outgoingCandidatesBuffer = [];
            if (batch.length > 0 && typeof callbacks.onLocalCandidates === "function") {
              callbacks.onLocalCandidates(batch);
            }
          }, 250);
        }
      }
    };

    pc.ontrack = function (event) {
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach(function (t) {
          remoteStream.addTrack(t);
        });
      } else if (event.track) {
        remoteStream.addTrack(event.track);
      }
      if (remoteVideoEl) {
        remoteVideoEl.srcObject = remoteStream;
      }
    };

    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === "connected") {
        if (typeof callbacks.onConnected === "function") {
          callbacks.onConnected();
        }
      } else if (st === "failed" || st === "closed") {
        if (typeof callbacks.onEnded === "function") {
          callbacks.onEnded();
        }
      }
    };

    peerConnection = pc;
    return pc;
  }

  async function startOutgoingCall(options) {
    // Step 1: Acquire local media stream (throws stage="MEDIA" with exact cause on failure)
    localStream = await acquireLocalMediaStream(options.qualityMode, options.requestedVideo);
    attachVideoElements(options.localVideoEl, options.remoteVideoEl);

    // Step 2: Create RTCPeerConnection and SDP offer (throws stage="WEBRTC" on failure)
    try {
      var pc = createPeerConnection(options.turnCredentials, options.remoteVideoEl);
      localStream.getTracks().forEach(function (track) {
        pc.addTrack(track, localStream);
      });
      await applyBitrateCap(pc, options.qualityMode);

      var offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: Boolean(options.requestedVideo && options.qualityMode !== "AUDIO_ONLY")
      });
      await pc.setLocalDescription(offer);
      return offer.sdp;
    } catch (rtcErr) {
      console.error(
        "[RunWebRTC/Offer]",
        rtcErr && rtcErr.name,
        rtcErr && rtcErr.message
      );
      var wrappedRtc = new Error(
        "تعذر تهيئة اتصال WebRTC (" +
          ((rtcErr && rtcErr.name) || "Error") +
          (rtcErr && rtcErr.message ? ": " + rtcErr.message : "") +
          ")"
      );
      wrappedRtc.stage = "WEBRTC";
      throw wrappedRtc;
    }
  }

  async function answerIncomingCall(options) {
    // Step 1: Acquire local media stream
    localStream = await acquireLocalMediaStream(options.qualityMode, options.requestedVideo);
    attachVideoElements(options.localVideoEl, options.remoteVideoEl);

    // Step 2: Set remote offer & create SDP answer
    try {
      var pc = createPeerConnection(options.turnCredentials, options.remoteVideoEl);
      localStream.getTracks().forEach(function (track) {
        pc.addTrack(track, localStream);
      });
      await applyBitrateCap(pc, options.qualityMode);

      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: options.offerSdp })
      );
      await flushPendingRemoteCandidates();

      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return answer.sdp;
    } catch (rtcErr) {
      console.error(
        "[RunWebRTC/Answer]",
        rtcErr && rtcErr.name,
        rtcErr && rtcErr.message
      );
      var wrappedRtc = new Error(
        "تعذر إعداد رد اتصال WebRTC (" +
          ((rtcErr && rtcErr.name) || "Error") +
          (rtcErr && rtcErr.message ? ": " + rtcErr.message : "") +
          ")"
      );
      wrappedRtc.stage = "WEBRTC";
      throw wrappedRtc;
    }
  }

  async function onRemoteAnswerReceived(answerSdp) {
    if (!peerConnection || !answerSdp) return;
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: answerSdp })
    );
    await flushPendingRemoteCandidates();
  }

  async function onRemoteIceCandidatesReceived(candidates) {
    if (!Array.isArray(candidates)) return;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || !c.candidate) continue;
      if (peerConnection && peerConnection.remoteDescription) {
        try {
          await peerConnection.addIceCandidate(
            new RTCIceCandidate({
              sdpMid: c.sdpMid || "0",
              sdpMLineIndex: c.sdpMLineIndex || 0,
              candidate: c.candidate
            })
          );
        } catch (_) {}
      } else {
        pendingRemoteCandidates.push(c);
      }
    }
  }

  async function flushPendingRemoteCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    var list = pendingRemoteCandidates.slice();
    pendingRemoteCandidates = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      try {
        await peerConnection.addIceCandidate(
          new RTCIceCandidate({
            sdpMid: c.sdpMid || "0",
            sdpMLineIndex: c.sdpMLineIndex || 0,
            candidate: c.candidate
          })
        );
      } catch (_) {}
    }
  }

  function setMicMuted(muted) {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(function (t) {
      t.enabled = !muted;
    });
  }

  function setCameraEnabled(enabled) {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(function (t) {
      t.enabled = Boolean(enabled);
    });
  }

  function setSpeakerEnabled(enabled, remoteVideoEl) {
    if (remoteVideoEl) {
      remoteVideoEl.muted = !enabled;
    }
  }

  function cleanupPeerConnectionOnly() {
    if (candidateFlushTimer) {
      clearTimeout(candidateFlushTimer);
      candidateFlushTimer = null;
    }
    outgoingCandidatesBuffer = [];
    pendingRemoteCandidates = [];
    if (peerConnection) {
      try {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
      } catch (_) {}
      peerConnection = null;
    }
  }

  function endCall(localVideoEl, remoteVideoEl) {
    cleanupPeerConnectionOnly();
    if (localStream) {
      localStream.getTracks().forEach(function (t) {
        try {
          t.stop();
        } catch (_) {}
      });
      localStream = null;
    }
    remoteStream = null;
    if (localVideoEl) localVideoEl.srcObject = null;
    if (remoteVideoEl) remoteVideoEl.srcObject = null;
  }

  return {
    configureCallbacks: configureCallbacks,
    startOutgoingCall: startOutgoingCall,
    answerIncomingCall: answerIncomingCall,
    onRemoteAnswerReceived: onRemoteAnswerReceived,
    onRemoteIceCandidatesReceived: onRemoteIceCandidatesReceived,
    setMicMuted: setMicMuted,
    setCameraEnabled: setCameraEnabled,
    setSpeakerEnabled: setSpeakerEnabled,
    endCall: endCall
  };
})();
