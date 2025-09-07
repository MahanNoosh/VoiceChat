document.addEventListener("DOMContentLoaded", () => {
  const SERVER = window.location.origin;
  const config = require("../backend/config");
  // ICE servers
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: `turn:${config.turnUrl}`,
      username: "chatuser",
      credential: "chatpass",
    },
  ];

  const DEFAULT_ROOMS = ["Room A", "Room B", "Room C"];

  let socket = null;
  let localStream = null;
  let username = null;
  let currentRoom = null;

  const peers = new Map(); // id -> { pc, el }
  const peerEls = new Map(); // id -> { container,label,audio,volumeInput,muteBtn }
  const peerUsernames = new Map(); // id -> username
  const candidateQueues = new Map(); // id -> [candidateObj]

  const els = {
    username: document.getElementById("username"),
    roomSelect: document.getElementById("roomSelect"),
    joinBtn: document.getElementById("joinBtn"),
    leaveBtn: document.getElementById("leaveBtn"),
    gainControl: document.getElementById("gainControl"),
    localAudio: document.getElementById("localAudio"),
    remoteAudios: document.getElementById("remoteAudios"),
    status: document.getElementById("status"),
    remoteVolume: document.getElementById("remoteVolume"),
  };

  let audioCtx = null,
    micSource = null,
    gainNode = null,
    userInteracted = false;

  function log(msg) {
    const div = document.createElement("div");
    div.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
    els.status.appendChild(div);
    els.status.scrollTop = els.status.scrollHeight;
    console.log(msg);
  }

  function populateRooms() {
    els.roomSelect.innerHTML = DEFAULT_ROOMS.map(
      (r) => `<option value="${r}">${r}</option>`
    ).join("");
    const saved = Storage.load("room", DEFAULT_ROOMS[0]);
    if (DEFAULT_ROOMS.includes(saved)) els.roomSelect.value = saved;
  }

  function restore() {
    els.username.value = Storage.load("username", "");
    els.remoteVolume.value = Storage.load("remoteVolume", 1);
    els.gainControl.value = Storage.load("micVolume", 1);
  }

  // Candidate queue
  async function flushCandidateQueueFor(id, pc) {
    const q = candidateQueues.get(id) || [];
    while (q.length) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(q.shift()));
      } catch (err) {
        log(
          `⚠️ addIceCandidate failed (${peerUsernames.get(id) || id}): ${
            err.message
          }`
        );
      }
    }
    candidateQueues.set(id, []);
  }

  // --- Mic init ---
  async function initMic() {
    if (localStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      localStream = stream;

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micSource = audioCtx.createMediaStreamSource(localStream);
      gainNode = audioCtx.createGain();
      gainNode.gain.value = Number(els.gainControl.value) || 1;

      const dest = audioCtx.createMediaStreamDestination();
      micSource.connect(gainNode).connect(dest);

      els.localAudio.srcObject = dest.stream;
      els.localAudio.muted = true;
      els.localAudio.setAttribute("playsinline", "");
      els.localAudio.play().catch(() => {});
      await audioCtx.resume();

      attachTracksToPeers(localStream);
      log("🎤 Mic ready.");
    } catch (err) {
      log(`❌ Mic init failed: ${err?.message || err}`);
      throw err;
    }
  }

  function attachTracksToPeers(stream) {
    if (!stream) return;
    const newTrack = stream.getAudioTracks()[0];
    peers.forEach(({ pc }) => {
      const sender = pc
        .getSenders()
        .find((s) => s.track && s.track.kind === "audio");
      if (sender) sender.replaceTrack(newTrack);
      else pc.addTrack(newTrack, stream);
    });
  }

  // Restart mic
  async function restartMic() {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const newTrack = newStream.getAudioTracks()[0];

      if (audioCtx) {
        micSource = audioCtx.createMediaStreamSource(newStream);
        micSource.connect(gainNode);
      }

      peers.forEach(({ pc }) => {
        const sender = pc
          .getSenders()
          .find((s) => s.track && s.track.kind === "audio");
        if (sender) sender.replaceTrack(newTrack);
        else pc.addTrack(newTrack, newStream);
      });

      localStream.getTracks().forEach((t) => t.stop());
      localStream = newStream;
      log("✅ Mic restarted successfully.");
    } catch (err) {
      log(`❌ Failed to restart mic: ${err?.message || err}`);
    }
  }

  // --- Socket & signaling ---
  function initSocket() {
    if (socket) return;
    socket = io(SERVER, { transports: ["websocket"] });

    socket.on("connect", () => log(`Connected (${socket.id})`));
    socket.on("disconnect", () => log("Disconnected"));

    socket.on("existing-peers", (list) => {
      list.forEach(({ id, username: uname }) => {
        if (id === socket.id) return;
        peerUsernames.set(id, uname || id);
        createPeer(id, uname || id, false);
      });
    });

    socket.on("new-peer", ({ id, username: uname }) => {
      if (id === socket.id) return;
      peerUsernames.set(id, uname || id);
      log(`👋 ${uname || id} joined`);
      createPeer(id, uname || id, true);
    });

    socket.on("signal", async ({ from, signal }) => {
      if (!from) return;
      const rec =
        peers.get(from) ||
        createPeer(from, peerUsernames.get(from) || from, false);
      const pc = rec.pc;
      try {
        if (signal.type === "offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await flushCandidateQueueFor(from, pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("signal", { to: from, signal: pc.localDescription });
        } else if (signal.type === "answer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await flushCandidateQueueFor(from, pc);
        } else if (signal.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type)
            await pc.addIceCandidate(new RTCIceCandidate(signal));
          else {
            if (!candidateQueues.has(from)) candidateQueues.set(from, []);
            candidateQueues.get(from).push(signal);
          }
        }
      } catch (e) {
        log(
          `⚠️ Signal error (${peerUsernames.get(from) || from}): ${
            e?.message || e
          }`
        );
      }
    });

    socket.on("peer-disconnect", (id) => {
      cleanupPeer(id);
      log(`👋 Peer left: ${peerUsernames.get(id) || id}`);
      peerUsernames.delete(id);
    });
  }

  // --- Room join/leave ---
  async function joinRoom() {
    username =
      (els.username.value || "").trim() ||
      `guest-${Math.floor(Math.random() * 1000)}`;
    currentRoom = els.roomSelect.value;
    Storage.save("username", username);
    Storage.save("room", currentRoom);

    initSocket();
    socket.emit("join-room", { room: currentRoom, username });
    log(`✅ Joined ${currentRoom} as ${username}`);
    els.joinBtn.disabled = true;
    els.leaveBtn.disabled = false;

    userInteracted = true;
    unlockRemoteAudioPlayback();
  }

  function leaveRoom() {
    if (!socket) return;
    [...peers.keys()].forEach(cleanupPeer);
    try {
      socket.emit("leave-room", { room: currentRoom, username });
    } catch (e) {}
    try {
      socket.disconnect();
    } catch (e) {}
    socket = null;

    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;

    audioCtx?.close();
    audioCtx = micSource = gainNode = null;

    els.remoteAudios.innerHTML = "";
    els.joinBtn.disabled = false;
    els.leaveBtn.disabled = true;
    log("🚪 Left room.");
  }

  // --- Peer creation & management ---
  function createPeer(id, uname, initiator) {
    if (peers.has(id)) return peers.get(id);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const el = createPeerEl(id, uname);

    // Ensure transceiver first (m-line order fixed)
    pc.addTransceiver("audio", { direction: "sendrecv" });
    if (localStream)
      localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.ontrack = (e) => {
      if (!el.audio.srcObject) {
        el.audio.srcObject = e.streams[0];
        el.audio.setAttribute("playsinline", "");
        el.audio.volume = Number(els.remoteVolume.value);
        if (userInteracted) el.audio.muted = false;
        el.audio.play().catch(() => {});
        log(`🔊 Receiving audio from ${uname}`);
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (pc.remoteDescription && pc.remoteDescription.type)
        socket?.emit("signal", { to: id, signal: e.candidate });
      else {
        if (!candidateQueues.has(id)) candidateQueues.set(id, []);
        candidateQueues.get(id).push(e.candidate);
      }
    };

    pc.oniceconnectionstatechange = () => {
      log(`ICE(${uname}): ${pc.iceConnectionState}`);
      if (["failed", "disconnected", "closed"].includes(pc.iceConnectionState))
        cleanupPeer(id);
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("signal", { to: id, signal: pc.localDescription });
      } catch (e) {
        log(`Negotiation error: ${e.message}`);
      }
    };

    peers.set(id, { pc, el });

    if (initiator)
      renegotiate(pc, id).catch((e) =>
        log(`Offer error (${uname}): ${e?.message || e}`)
      );

    return peers.get(id);
  }

  async function renegotiate(pc, id) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { to: id, signal: pc.localDescription });
  }

  function cleanupPeer(id) {
    const rec = peers.get(id);
    if (!rec) return;
    try {
      rec.pc.close();
    } catch (e) {}
    try {
      rec.el.container.remove();
    } catch (e) {}
    peers.delete(id);
    peerEls.delete(id);
    candidateQueues.delete(id);
  }

  function createPeerEl(id, uname) {
    const container = document.createElement("div");
    container.className = "peer";
    const label = document.createElement("div");
    label.className = "peer-label";
    label.textContent = uname;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.controls = true;
    audio.muted = !userInteracted || id === socket?.id;
    audio.setAttribute("playsinline", "");

    const controls = document.createElement("div");
    controls.className = "controls";
    const vol = document.createElement("input");
    vol.type = "range";
    vol.min = "0";
    vol.max = "2";
    vol.step = "0.01";
    vol.value = "1";
    vol.oninput = () => {
      audio.volume = Math.min(
        1,
        Number(els.remoteVolume.value) * Number(vol.value)
      );
    };
    const muteBtn = document.createElement("button");
    muteBtn.textContent = audio.muted ? "Unmute" : "Mute";
    muteBtn.onclick = () => {
      audio.muted = !audio.muted;
      muteBtn.textContent = audio.muted ? "Unmute" : "Mute";
    };

    controls.append(muteBtn, vol);
    container.append(label, audio, controls);
    els.remoteAudios.appendChild(container);

    const record = { container, label, audio, volumeInput: vol, muteBtn };
    peerEls.set(id, record);
    return record;
  }

  function unlockRemoteAudioPlayback() {
    peerEls.forEach(({ audio }) => {
      if (audio.srcObject) {
        audio.muted = false;
        audio.play().catch(() => {});
      }
    });
  }

  // --- UI wiring ---
  els.gainControl.addEventListener("input", () => {
    const v = Number(els.gainControl.value) || 1;
    gainNode && (gainNode.gain.value = v);
    Storage.save("micVolume", v);
  });
  els.remoteVolume.addEventListener("input", () => {
    const base = Number(els.remoteVolume.value) || 1;
    peerEls.forEach(({ audio, volumeInput }) => {
      audio.volume = Math.min(1, base * Number(volumeInput.value || 1));
    });
    Storage.save("remoteVolume", base);
  });

  els.joinBtn.onclick = async () => {
    try {
      userInteracted = true;
      await initMic();
      initSocket();
      await joinRoom();
      unlockRemoteAudioPlayback();
    } catch (err) {
      log(`❌ Cannot join: ${err?.message || err}`);
    }
  };
  els.leaveBtn.onclick = leaveRoom;
  document.addEventListener(
    "click",
    () => {
      userInteracted = true;
      audioCtx?.resume();
      unlockRemoteAudioPlayback();
    },
    { once: true }
  );

  populateRooms();
  restore();
});
