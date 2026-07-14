import { useState, useEffect, useRef } from "react";
import Peer from "peerjs";
import {
  Video, VideoOff, Mic, MicOff, MonitorUp, MonitorX,
  PhoneOff, Copy, Check, Users, Radio, Volume2, VolumeX,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────
   OpenLine — peer-to-peer video calls via PeerJS.
   Signaling uses PeerJS's public broker (0.peerjs.com).
   First person to enter a room claims the host peer ID
   `openline-<ROOMCODE>` and maintains the roster; guests
   dial the host, receive the roster, then media-call every
   other peer directly. Screen sharing swaps the outgoing
   video track on each active call.
   ───────────────────────────────────────────────────────── */

const HOST_PREFIX = "openline-";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const makeCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");

const hostIdFor = (room) => `${HOST_PREFIX}${room.toLowerCase()}`;

export default function OpenLine() {
  const [stage, setStage] = useState("lobby");
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [peers, setPeers] = useState({});           // peerId -> { name, stream }
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [audioMuted, setAudioMuted] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [mediaReady, setMediaReady] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const peerRef = useRef(null);                     // PeerJS instance
  const callsRef = useRef({});                      // peerId -> MediaConnection
  const dataConnsRef = useRef({});                  // peerId -> DataConnection (host: to each guest; guest: to host only)
  const rosterRef = useRef({});                     // host-authoritative peerId -> name
  const isHostRef = useRef(false);
  const nameRef = useRef("");
  const roomRef = useRef("");
  const localVideoRef = useRef(null);
  const lobbyVideoRef = useRef(null);

  /* ── local media ─────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        localStreamRef.current = stream;
        setMediaReady(true);
        if (lobbyVideoRef.current) lobbyVideoRef.current.srcObject = stream;
      } catch {
        setNotice("Camera or microphone was blocked. Allow access and reload to join calls.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (stage === "lobby" && lobbyVideoRef.current && localStreamRef.current)
      lobbyVideoRef.current.srcObject = localStreamRef.current;
    if (stage === "call" && localVideoRef.current && localStreamRef.current)
      localVideoRef.current.srcObject = localStreamRef.current;
  }, [stage, mediaReady]);

  /* ── peer helpers ────────────────────────────────────── */

  const outgoingStreamForCall = () => {
    // If sharing, send screen video + mic audio; else camera+mic
    const local = localStreamRef.current;
    if (!local) return null;
    if (screenStreamRef.current) {
      const combined = new MediaStream();
      screenStreamRef.current.getVideoTracks().forEach((t) => combined.addTrack(t));
      local.getAudioTracks().forEach((t) => combined.addTrack(t));
      return combined;
    }
    return local;
  };

  const wireCall = (call, peerName) => {
    callsRef.current[call.peer] = call;
    call.on("stream", (stream) => {
      setPeers((prev) => ({
        ...prev,
        [call.peer]: { name: prev[call.peer]?.name || peerName || "Guest", stream },
      }));
    });
    call.on("close", () => dropRemote(call.peer));
    call.on("error", () => dropRemote(call.peer));
  };

  const dropRemote = (peerId) => {
    const call = callsRef.current[peerId];
    if (call) { try { call.close(); } catch {} delete callsRef.current[peerId]; }
    const conn = dataConnsRef.current[peerId];
    if (conn) { try { conn.close(); } catch {} delete dataConnsRef.current[peerId]; }
    if (isHostRef.current && rosterRef.current[peerId]) {
      delete rosterRef.current[peerId];
      broadcastRoster();
    }
    setPeers((prev) => { const next = { ...prev }; delete next[peerId]; return next; });
  };

  const dialPeer = (remoteId, remoteName) => {
    if (callsRef.current[remoteId]) return;
    const stream = outgoingStreamForCall();
    if (!stream || !peerRef.current) return;
    const call = peerRef.current.call(remoteId, stream, { metadata: { name: nameRef.current } });
    if (call) wireCall(call, remoteName);
  };

  const broadcastRoster = () => {
    if (!isHostRef.current) return;
    const roster = {
      [peerRef.current.id]: nameRef.current,
      ...rosterRef.current,
    };
    // Update our local view of peer names
    setPeers((prev) => {
      const next = { ...prev };
      Object.entries(roster).forEach(([id, n]) => {
        if (id !== peerRef.current.id && next[id]) next[id] = { ...next[id], name: n };
      });
      return next;
    });
    Object.values(dataConnsRef.current).forEach((conn) => {
      try { conn.send({ type: "roster", roster }); } catch {}
    });
  };

  const applyRosterAsGuest = (roster) => {
    const me = peerRef.current?.id;
    // Update names for known peers, add placeholders for new ones
    setPeers((prev) => {
      const next = { ...prev };
      Object.entries(roster).forEach(([id, n]) => {
        if (id === me) return;
        next[id] = { name: n, stream: next[id]?.stream || null };
      });
      // Drop peers no longer in roster
      Object.keys(next).forEach((id) => { if (!(id in roster)) delete next[id]; });
      return next;
    });
    // Dial peers whose id sorts lower than mine (deterministic pair direction)
    Object.entries(roster).forEach(([id, n]) => {
      if (id === me) return;
      if (id < me && !callsRef.current[id]) dialPeer(id, n);
    });
    // Drop calls for peers that left
    Object.keys(callsRef.current).forEach((id) => {
      if (!(id in roster)) dropRemote(id);
    });
  };

  /* ── join / leave ────────────────────────────────────── */

  const attachIncoming = (peer) => {
    peer.on("call", (call) => {
      const stream = outgoingStreamForCall();
      if (!stream) return;
      call.answer(stream);
      const remoteName = call.metadata?.name || "Guest";
      wireCall(call, remoteName);
    });

    peer.on("connection", (conn) => {
      // Only meaningful for host — a guest opening its data channel
      conn.on("open", () => {
        dataConnsRef.current[conn.peer] = conn;
        conn.on("data", (msg) => {
          if (!msg || typeof msg !== "object") return;
          if (msg.type === "hello" && isHostRef.current) {
            rosterRef.current[conn.peer] = msg.name || "Guest";
            broadcastRoster();
          }
        });
        conn.on("close", () => { dropRemote(conn.peer); });
      });
    });

    peer.on("disconnected", () => {
      try { peer.reconnect(); } catch {}
    });
  };

  const enterRoom = async (code) => {
    if (!localStreamRef.current) {
      setNotice("Camera and microphone access is needed to join. Allow access and reload.");
      return;
    }
    const room = code.toUpperCase().trim();
    if (room.length !== 6) return;
    roomRef.current = room;
    nameRef.current = name.trim() || "Guest";
    setRoomCode(room);
    setNotice("");
    setConnecting(true);

    const wantedHostId = hostIdFor(room);

    // Try to claim the host slot first
    let peer = new Peer(wantedHostId, { debug: 0 });
    let asHost = true;

    const openOrFail = () =>
      new Promise((resolve, reject) => {
        const onOpen = () => { peer.off("error", onError); resolve(); };
        const onError = (err) => { peer.off("open", onOpen); reject(err); };
        peer.once("open", onOpen);
        peer.once("error", onError);
      });

    try {
      await openOrFail();
    } catch (err) {
      // Host slot taken (or other issue). Retry as guest with random ID.
      try { peer.destroy(); } catch {}
      if (err?.type && err.type !== "unavailable-id") {
        setConnecting(false);
        setNotice("Couldn't reach the signaling service. Check your connection and try again.");
        return;
      }
      asHost = false;
      peer = new Peer({ debug: 0 });
      try {
        await new Promise((resolve, reject) => {
          peer.once("open", resolve);
          peer.once("error", reject);
        });
      } catch {
        try { peer.destroy(); } catch {}
        setConnecting(false);
        setNotice("Couldn't reach the signaling service. Check your connection and try again.");
        return;
      }
    }

    peerRef.current = peer;
    isHostRef.current = asHost;
    rosterRef.current = {};
    attachIncoming(peer);

    if (!asHost) {
      // Dial the host's data channel and identify ourselves
      const conn = peer.connect(wantedHostId, { reliable: true, metadata: { name: nameRef.current } });
      dataConnsRef.current[wantedHostId] = conn;
      conn.on("open", () => {
        try { conn.send({ type: "hello", name: nameRef.current }); } catch {}
      });
      conn.on("data", (msg) => {
        if (msg?.type === "roster") applyRosterAsGuest(msg.roster);
      });
      conn.on("close", () => {
        // Host left — end the call for this guest
        setNotice("The host ended the call.");
        leaveRoom();
      });
      conn.on("error", () => {});
    }

    setConnecting(false);
    setStage("call");
  };

  const leaveRoom = () => {
    // Close all calls and data connections
    Object.keys(callsRef.current).forEach((id) => {
      try { callsRef.current[id].close(); } catch {}
    });
    callsRef.current = {};
    Object.keys(dataConnsRef.current).forEach((id) => {
      try { dataConnsRef.current[id].close(); } catch {}
    });
    dataConnsRef.current = {};

    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch {}
      peerRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setSharing(false);
    }

    rosterRef.current = {};
    isHostRef.current = false;
    roomRef.current = "";
    setPeers({});
    setStage("lobby");
  };

  useEffect(() => () => {
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {} }
  }, []);

  /* ── controls ────────────────────────────────────────── */

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
  };

  const toggleCam = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setCamOn(track.enabled); }
  };

  const swapOutgoingVideo = (newTrack) => {
    Object.values(callsRef.current).forEach((call) => {
      const pc = call.peerConnection;
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(newTrack);
    });
  };

  const startShare = async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = screen;
      const track = screen.getVideoTracks()[0];
      swapOutgoingVideo(track);
      if (localVideoRef.current) localVideoRef.current.srcObject = screen;
      setSharing(true);
      track.onended = stopShare;
    } catch {}
  };

  const stopShare = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    const camTrack = localStreamRef.current?.getVideoTracks()[0];
    if (camTrack) swapOutgoingVideo(camTrack);
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    setSharing(false);
  };

  const copyInvite = async () => {
    const text = `Join my video call on OpenLine — open the app and enter room code ${roomCode}`;
    try { await navigator.clipboard.writeText(text); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  /* ── rendering ───────────────────────────────────────── */

  const peerEntries = Object.entries(peers);
  const tileCount = peerEntries.length + 1;
  const cols = tileCount === 1 ? 1 : tileCount <= 4 ? 2 : 3;

  return (
    <div className="ol-root">
      <style>{css}</style>

      {stage === "lobby" && (
        <div className="lobby">
          <header className="lobby-head">
            <div className="wordmark"><Radio size={18} strokeWidth={2.4} /><span>OpenLine</span></div>
            <p className="tagline">Video calls that connect browser to browser. Start a room, send the code, talk.</p>
          </header>

          <div className="lobby-grid">
            <div className="preview-wrap">
              <video ref={lobbyVideoRef} autoPlay playsInline muted className="preview-video" />
              {!mediaReady && <div className="preview-empty">Waiting for camera…</div>}
              <span className="preview-tag">Your camera</span>
            </div>

            <div className="lobby-panel">
              <label className="field-label" htmlFor="ol-name">Your name</label>
              <input
                id="ol-name" className="text-input" placeholder="e.g. Faizan" maxLength={24}
                value={name} onChange={(e) => setName(e.target.value)}
              />

              <button className="btn primary" onClick={() => enterRoom(makeCode())} disabled={!mediaReady || connecting}>
                {connecting ? "Connecting…" : "Start a new call"}
              </button>

              <div className="divider"><span>or join one</span></div>

              <div className="join-row">
                <input
                  className="text-input code-input" placeholder="ROOM CODE" maxLength={6}
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter" && joinCode.length === 6) enterRoom(joinCode); }}
                />
                <button className="btn ghost" disabled={joinCode.length !== 6 || !mediaReady || connecting}
                  onClick={() => enterRoom(joinCode)}>
                  {connecting ? "…" : "Join"}
                </button>
              </div>

              {notice && <p className="notice">{notice}</p>}
              <p className="fineprint">Room codes are visible to anyone using this app who has the code. Share them only with people you want on the call.</p>
            </div>
          </div>
        </div>
      )}

      {stage === "call" && (
        <div className="call">
          <header className="call-head">
            <div className="wordmark small plain"><span>OpenLine</span></div>
            <div className="room-sign" aria-label={`Room code ${roomCode}`}>
              {roomCode.split("").map((ch, i) => <span key={i} className="sign-cell">{ch}</span>)}
            </div>
            <div className="head-right">
              <span className="count"><Users size={14} /> {tileCount}</span>
              <button className="btn invite" onClick={copyInvite}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? "Copied" : "Copy invite"}
              </button>
            </div>
          </header>

          <main className="stage" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            <div className={`tile ${sharing ? "is-sharing" : ""}`}>
              <video ref={localVideoRef} autoPlay playsInline muted className={sharing ? "fit-contain" : ""} />
              {!camOn && !sharing && <div className="tile-off"><VideoOff size={28} /></div>}
              <span className="tile-name">
                {nameRef.current || "You"} (you)
                {!micOn && <MicOff size={12} className="name-icon" />}
                {sharing && <MonitorUp size={12} className="name-icon" />}
              </span>
            </div>

            {peerEntries.map(([id, peer]) => (
              <div className="tile" key={id}>
                {peer.stream
                  ? <PeerVideo stream={peer.stream} muted={audioMuted} />
                  : <div className="tile-off connecting">Connecting…</div>}
                <span className="tile-name">{peer.name}</span>
              </div>
            ))}

            {peerEntries.length === 0 && (
              <div className="tile waiting-tile">
                <div className="waiting-inner">
                  <p className="waiting-title">Nobody here yet</p>
                  <p className="waiting-sub">Send the room code <strong>{roomCode}</strong> to invite people.</p>
                  <button className="btn invite" onClick={copyInvite}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    {copied ? "Copied" : "Copy invite"}
                  </button>
                </div>
              </div>
            )}
          </main>

          <footer className="controls">
            <button className={`ctl ${micOn ? "" : "off"}`} onClick={toggleMic}
              aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
              {micOn ? <Mic size={20} /> : <MicOff size={20} />}
              <span className="ctl-label">{micOn ? "Mute" : "Unmute"}</span>
            </button>
            <button className={`ctl ${audioMuted ? "off" : ""}`} onClick={() => setAudioMuted((v) => !v)}
              aria-label={audioMuted ? "Unmute call audio" : "Mute call audio"}>
              {audioMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
              <span className="ctl-label">{audioMuted ? "Sound on" : "Sound off"}</span>
            </button>
            <button className={`ctl ${camOn ? "" : "off"}`} onClick={toggleCam}
              aria-label={camOn ? "Turn camera off" : "Turn camera on"} disabled={sharing}>
              {camOn ? <Video size={20} /> : <VideoOff size={20} />}
              <span className="ctl-label">{camOn ? "Camera off" : "Camera on"}</span>
            </button>
            <button className={`ctl ${sharing ? "active" : ""}`} onClick={sharing ? stopShare : startShare}
              aria-label={sharing ? "Stop sharing screen" : "Share screen"}>
              {sharing ? <MonitorX size={20} /> : <MonitorUp size={20} />}
              <span className="ctl-label">{sharing ? "Stop share" : "Share screen"}</span>
            </button>
            <button className="ctl leave" onClick={leaveRoom} aria-label="End call">
              <PhoneOff size={20} />
              <span className="ctl-label">End call</span>
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function PeerVideo({ stream, muted }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

/* ── styles ──────────────────────────────────────────────── */

const css = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

.ol-root {
  --ink: #0D1117;
  --panel: #151B24;
  --line: #26303D;
  --text: #E9EEF5;
  --muted: #8B97A8;
  --amber: #F2A93B;
  --amber-dim: rgba(242,169,59,0.14);
  --danger: #E4604D;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--ink);
  color: var(--text);
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  display: flex; flex-direction: column;
}
.ol-root * { box-sizing: border-box; }
.ol-root button { font-family: inherit; cursor: pointer; }
.ol-root button:focus-visible, .ol-root input:focus-visible {
  outline: 2px solid var(--amber); outline-offset: 2px;
}

/* wordmark */
.wordmark {
  display: inline-flex; align-items: center; gap: 8px;
  font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700;
  font-size: 20px; letter-spacing: -0.01em; color: var(--text);
}
.wordmark svg { color: var(--amber); }
.wordmark.small { font-size: 15px; }
.wordmark.plain svg { display: none; }

/* ── lobby ── */
.lobby { max-width: 960px; width: 100%; margin: 0 auto; padding: 48px 24px 64px; }
.lobby-head { margin-bottom: 36px; }
.tagline { color: var(--muted); font-size: 15px; margin: 10px 0 0; max-width: 44ch; line-height: 1.55; }

.lobby-grid { display: grid; grid-template-columns: 1.25fr 1fr; gap: 28px; align-items: start; }
@media (max-width: 760px) { .lobby-grid { grid-template-columns: 1fr; } }

.preview-wrap {
  position: relative; aspect-ratio: 4/3; border-radius: 14px; overflow: hidden;
  background: var(--panel); border: 1px solid var(--line);
}
.preview-video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
.preview-empty {
  position: absolute; inset: 0; display: grid; place-items: center;
  color: var(--muted); font-size: 14px;
}
.preview-tag {
  position: absolute; left: 12px; bottom: 12px; font-size: 12px; color: var(--text);
  background: rgba(13,17,23,0.72); padding: 4px 10px; border-radius: 999px;
}

.lobby-panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 24px; display: flex; flex-direction: column; gap: 14px;
}
.field-label { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.text-input {
  background: var(--ink); border: 1px solid var(--line); color: var(--text);
  border-radius: 9px; padding: 11px 13px; font-size: 15px; width: 100%;
}
.text-input::placeholder { color: #5A6678; }
.code-input {
  font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700;
  letter-spacing: 0.32em; text-transform: uppercase; font-size: 17px;
}

.btn {
  border: none; border-radius: 9px; padding: 12px 16px; font-size: 15px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  transition: filter 120ms ease;
}
.btn:hover:not(:disabled) { filter: brightness(1.08); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.primary { background: var(--amber); color: #1A1204; }
.btn.ghost { background: transparent; border: 1px solid var(--line); color: var(--text); }
.btn.invite {
  background: var(--amber-dim); color: var(--amber); border: 1px solid transparent;
  padding: 8px 14px; font-size: 13px; border-radius: 999px;
}

.divider { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.join-row { display: flex; gap: 10px; }
.join-row .btn { flex-shrink: 0; }
.notice { color: var(--danger); font-size: 13px; margin: 0; line-height: 1.5; }
.fineprint { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 4px 0 0; }

/* ── call ── */
.call { flex: 1; display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh; }
.call-head {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 20px; border-bottom: 1px solid var(--line);
}
.room-sign { display: flex; gap: 5px; }
.sign-cell {
  font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 17px;
  background: var(--panel); border: 1px solid var(--line); color: var(--amber);
  width: 30px; height: 36px; display: grid; place-items: center; border-radius: 7px;
}
.head-right { display: flex; align-items: center; gap: 12px; }
.count { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }

.stage {
  flex: 1; display: grid; gap: 12px; padding: 16px 20px;
  align-content: center;
}
.tile {
  position: relative; background: var(--panel); border: 1px solid var(--line);
  border-radius: 14px; overflow: hidden; aspect-ratio: 16/10; min-height: 180px;
}
.tile video { width: 100%; height: 100%; object-fit: cover; }
.tile video.fit-contain { object-fit: contain; background: #000; }
.tile.is-sharing { border-color: var(--amber); }
.tile-off {
  position: absolute; inset: 0; display: grid; place-items: center;
  color: var(--muted); background: var(--panel);
}
.tile-off.connecting { font-size: 14px; }
.tile-name {
  position: absolute; left: 10px; bottom: 10px; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 500; color: var(--text);
  background: rgba(13,17,23,0.72); padding: 4px 10px; border-radius: 999px;
}
.name-icon { color: var(--amber); }

.waiting-tile { display: grid; place-items: center; border-style: dashed; }
.waiting-inner { text-align: center; padding: 24px; display: flex; flex-direction: column; gap: 10px; align-items: center; }
.waiting-title { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 18px; margin: 0; }
.waiting-sub { color: var(--muted); font-size: 14px; margin: 0; }
.waiting-sub strong { color: var(--amber); letter-spacing: 0.12em; }

.controls {
  display: flex; justify-content: center; gap: 12px; padding: 16px 20px 22px;
  border-top: 1px solid var(--line); flex-wrap: wrap;
}
.ctl {
  min-height: 52px; padding: 8px 16px; border-radius: 26px; border: 1px solid var(--line);
  background: var(--panel); color: var(--text);
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 600;
  transition: background 120ms ease, color 120ms ease;
}
.ctl:hover:not(:disabled) { background: var(--line); }
.ctl:disabled { opacity: 0.4; cursor: not-allowed; }
.ctl.off { background: var(--text); color: var(--ink); }
.ctl.active { background: var(--line); color: var(--text); }
.ctl.leave { background: var(--danger); border-color: var(--danger); color: #fff; }
.ctl.leave:hover:not(:disabled) { background: #c8523f; }
.ctl-label { white-space: nowrap; }

@media (max-width: 720px) {
  .call-head { flex-wrap: wrap; gap: 10px; padding: 12px 14px; }
  .room-sign { order: 3; width: 100%; justify-content: center; }
  .sign-cell { width: 26px; height: 32px; font-size: 15px; }
  .head-right { margin-left: auto; }
  .stage { grid-template-columns: 1fr !important; padding: 12px; gap: 10px; }
  .tile { min-height: 0; aspect-ratio: 16/11; }
  .lobby { padding: 28px 16px 48px; }
  .lobby-head { margin-bottom: 24px; }
  .lobby-panel { padding: 18px; }
}
@media (max-width: 520px) {
  .controls { gap: 8px; padding: 12px 10px 16px; }
  .ctl { padding: 8px 12px; font-size: 12px; min-width: 48px; justify-content: center; }
  .ctl-label { display: none; }
}
@media (max-width: 420px) {
  .sign-cell { width: 22px; height: 28px; font-size: 13px; border-radius: 5px; }
  .btn.invite { padding: 7px 10px; font-size: 12px; }
  .count { font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .ol-root * { transition: none !important; }
}
`;
