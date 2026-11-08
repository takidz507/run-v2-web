/**
 * Run v2 Web — Real 1-to-1 WebRTC Video & Voice Call Engine.
 *
 * Uses browser `RTCPeerConnection` and `navigator.mediaDevices.getUserMedia`:
 * - Supports dynamic TURN credentials from `/_matrix/client/v3/voip/turnServer`
 *   plus fallback STUN servers (`stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`)
 * - Respects quality settings:
 *   - `DEFAULT_480P` (854x480 @ 24fps, ~650 kbps)
 *   - `DATA_SAVER` (426x240 @ 15fps, ~250 kbps)
 *   - `AUDIO_ONLY` (audio only, zero video tracks)
 * - Working controls: Mic Mute/Unmute, Camera On/Off, Speaker Audio Mute/Unmute, End Call.
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
      iceServers.push({
        urls: turnCredentials.uris,
        username: turnCredentials.username,
        credential: turnCredentials.password
      });
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

    var pc = new RTCPeerConnection({
      iceServers: buildIceServers(turnCredentials)
    });

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
      } else if (st === "failed" || st === "closed" || st === "disconnected") {
        if (typeof callbacks.onEnded === "function") {
          callbacks.onEnded();
        }
      }
    };

    peerConnection = pc;
    return pc;
  }

  async function startOutgoingCall(options) {
    var constraints = buildMediaConstraints(options.qualityMode, options.requestedVideo);
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    attachVideoElements(options.localVideoEl, options.remoteVideoEl);

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
  }

  async function answerIncomingCall(options) {
    var constraints = buildMediaConstraints(options.qualityMode, options.requestedVideo);
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    attachVideoElements(options.localVideoEl, options.remoteVideoEl);

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
