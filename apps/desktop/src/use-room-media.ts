import type {
  MediaTransport,
  ParticipantSummary,
  RoomSession,
  RoomSnapshot,
  ServerSignalMessage,
  ShareDescriptor,
  VideoPreset,
} from "@gamecast/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApiBaseUrl } from "./api";
import { diagnosticLog, errorDetails } from "./diagnostics";
import { VIDEO_PRESETS } from "./media";
import { type ActiveWatcher, updateActiveWatchers } from "./watch-notice";
import {
  type MediaStats,
  type MediaConnectionStage,
  P2PMediaManager,
} from "./p2p/p2p-media-manager";
import { SfuFallback } from "./p2p/sfu-fallback";
import { P2PVoiceManager, type VoiceCallbacks } from "./p2p/p2p-voice-manager";
import {
  createSignalUrl,
  type SignalConnectionState,
  SignalingClient,
} from "./p2p/signaling-client";

export type MediaConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "disconnected";

export type RoomSharer = {
  id: string;
  name: string;
  isLocal: boolean;
  preset: ShareDescriptor["preset"];
  hasSystemAudio: boolean;
  viewerCount: number;
};

export type RoomParticipant = {
  id: string;
  name: string;
  role: string;
  isSpeaking: boolean;
  isSharer: boolean;
};

export function useRoomMedia(session: RoomSession) {
  const [participants, setParticipants] = useState<ParticipantSummary[]>([]);
  const [shares, setShares] = useState<ShareDescriptor[]>([]);
  const [selectedSharerId, setSelectedSharerId] = useState<string | null>(null);
  const [displayedSharerId, setDisplayedSharerId] = useState<string | null>(null);
  const [selectedStream, setSelectedStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<MediaConnectionState>("connecting");
  const [transport, setTransport] = useState<MediaTransport | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [localPreviewStream, setLocalPreviewStream] = useState<MediaStream | null>(null);
  const [hasSystemAudio, setHasSystemAudio] = useState(false);
  const [stats, setStats] = useState<MediaStats | undefined>();
  const [publisherStats, setPublisherStats] = useState<MediaStats | undefined>();
  const [connectionStage, setConnectionStage] = useState<MediaConnectionStage>({
    phase: "idle",
    message: "未选择共享画面",
  });
  const [captureMode, setCaptureMode] = useState<"browser" | "native" | null>(null);
  const [encoder, setEncoder] = useState<string | undefined>();
  // 麦克风语音
  const [micEnabled, setMicEnabled] = useState(false);
  const [micError, setMicError] = useState("");
  const [micVolume, setMicVolume] = useState(0);
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [voiceMode, setVoiceMode] = useState<"p2p" | "sfu" | "none">("none");
  const [remoteSpeakers, setRemoteSpeakers] = useState<Set<string>>(new Set());
  // Who is watching this participant's screen. Watching used to be entirely silent for the sharer.
  const [watchers, setWatchers] = useState<ActiveWatcher[]>([]);
  const managerRef = useRef<P2PMediaManager | undefined>(undefined);
  const voiceManagerRef = useRef<P2PVoiceManager | undefined>(undefined);
  const signalingRef = useRef<SignalingClient | undefined>(undefined);
  const ensureVoicePlayingRef = useRef<((reason: string) => void) | undefined>(undefined);
  const lastVoiceStreamRef = useRef<MediaStream | null>(null);
  const displayedConnectionRef = useRef<string | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const applySnapshot = useCallback((snapshot: RoomSnapshot) => {
    setParticipants(snapshot.participants);
    setShares(snapshot.shares);
    if (snapshot.activeWatch) {
      setSelectedSharerId(snapshot.activeWatch.targetParticipantId);
      setTransport(snapshot.activeWatch.transport);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let manager: P2PMediaManager | undefined;
    diagnosticLog("room", "session.started", {
      participantId: session.participant.id,
      roomId: session.room.id,
      maxParticipants: session.room.limits.maxParticipants,
      maxSharers: session.room.limits.maxSharers,
      maxViewersPerShare: session.room.limits.maxViewersPerShare,
      sfuAvailable: Boolean(session.sfu),
      iceServerCount: session.p2p.iceServers.length,
    });
    const signaling = new SignalingClient(
      createSignalUrl(getApiBaseUrl(), session.signaling.path),
      session.sessionToken,
      session.signaling.reconnectGraceSeconds,
    );
    signalingRef.current = signaling;

    const updateSignalState = (state: SignalConnectionState) => {
      if (disposed) return;
      diagnosticLog("room", "connection-state", { state });
      setConnectionState(state);
      if (state === "connected") setMediaError("");
      if (state === "disconnected") {
        setMediaError("与房间服务的连接已断开，请重新连接");
      }
    };
    signaling.onStateChange = updateSignalState;

    const initialize = async () => {
      const networks = await window.electronAPI?.listNetworkInterfaces().catch(() => []);
      // The effect can be torn down while this IPC call is in flight — StrictMode does exactly that
      // on every mount. Without this guard the continuation below would construct a manager and open
      // a fresh authenticated signaling socket after cleanup ran, and nothing would ever close them.
      if (disposed) return;
      const virtualNetworks = (networks ?? []).filter((network) => network.recommended);
      const allowedHostAddresses = session.p2p.candidatePolicy === "all"
        ? []
        : (virtualNetworks.length > 0 ? virtualNetworks : networks ?? []).map(
            (network) => network.address,
          );
      diagnosticLog("room", "network-policy", {
        discovered: (networks ?? []).map((network) => ({
          name: network.name,
          address: network.address,
          kind: network.kind,
          recommended: network.recommended,
        })),
        allowedHostAddresses,
      });
      // 把 P2P 的 ICE 服务器（含 TURN）也传给 SFU，走 TURN 中继更稳定
      const sfuIceServers: RTCIceServer[] = (session.p2p.iceServers ?? []).map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      }));
      const sfu = new SfuFallback(session.sfu, sfuIceServers);
      // 独立的 P2P 语音管理器（不依赖屏幕共享）
      const voiceManager = new P2PVoiceManager(
        session.participant.id,
        session.p2p.iceServers ?? [],
        signaling,
        {
          onRemoteMicStarted: (participantId, track) => {
            if (disposed) return;
            diagnosticLog("voice", "p2p.remote-mic-started", { participantId, trackId: track.id });
            setRemoteSpeakers((current) => new Set(current).add(participantId));
            // 加到语音播放流
            const audio = voiceAudioRef.current;
            if (audio) {
              let stream = audio.srcObject as MediaStream | null;
              if (!stream) {
                stream = new MediaStream();
                audio.srcObject = stream;
              }
              if (!stream.getTracks().includes(track)) {
                stream.addTrack(track);
                diagnosticLog("voice", "p2p.track-added", {
                  participantId,
                  trackCount: stream.getAudioTracks().length,
                });
              }
              ensureVoicePlayingRef.current?.("p2p-remote-mic");
            }
          },
          onRemoteMicStopped: (participantId) => {
            if (disposed) return;
            diagnosticLog("voice", "p2p.remote-mic-stopped", { participantId });
            setRemoteSpeakers((current) => {
              const next = new Set(current);
              next.delete(participantId);
              return next;
            });
          },
          onConnected: () => {
            if (disposed) return;
            setVoiceConnected(true);
            setVoiceMode("p2p");
            diagnosticLog("voice", "p2p.connected");
          },
          onDisconnected: () => {
            if (disposed) return;
            setVoiceConnected(false);
            diagnosticLog("voice", "p2p.disconnected");
          },
        },
      );
      voiceManagerRef.current = voiceManager;
      manager = new P2PMediaManager(
        session.participant.id,
        session.p2p,
        signaling,
        allowedHostAddresses,
        sfu,
        {
          onStream: (connectionId, participantId, stream, mode) => {
            if (disposed) return;
            diagnosticLog("viewer", "stream.attached-to-state", {
              connectionId,
              participantId,
              transport: mode,
              tracks: stream.getTracks().map((track) => ({
                kind: track.kind,
                id: track.id,
                muted: track.muted,
                readyState: track.readyState,
              })),
            });
            displayedConnectionRef.current = connectionId;
            setSelectedStream(stream);
            setDisplayedSharerId(participantId);
            setTransport(mode);
          },
          onStreamCleared: (connectionId) => {
            if (disposed || displayedConnectionRef.current !== connectionId) return;
            diagnosticLog("viewer", "stream.cleared", { connectionId });
            displayedConnectionRef.current = undefined;
            setSelectedStream(null);
            setDisplayedSharerId(null);
            setStats(undefined);
          },
          onLocalShareChanged: (
            stream,
            audioAvailable,
            active = Boolean(stream),
            nextCaptureMode = "browser",
            nextEncoder,
          ) => {
            if (disposed) return;
            setIsSharing(active);
            setLocalPreviewStream(active ? stream ?? null : null);
            setHasSystemAudio(audioAvailable);
            setCaptureMode(active ? nextCaptureMode : null);
            setEncoder(active ? nextEncoder : undefined);
          },
          onConnectionCommitted: (participantId, mode) => {
            if (disposed) return;
            diagnosticLog("viewer", "connection.committed", { participantId, transport: mode });
            setSelectedSharerId(participantId);
            setTransport(mode);
          },
          onError: (message) => {
            diagnosticLog("media", "error", { message }, "error");
            if (!disposed) setMediaError(message);
          },
          onStats: (nextStats) => !disposed && setStats(nextStats),
          onPublisherStats: (nextStats) => !disposed && setPublisherStats(nextStats),
          onConnectionStage: (stage) => !disposed && setConnectionStage(stage),
          // 麦克风语音回调
          onMicStateChanged: (enabled) => {
            if (disposed) return;
            setMicEnabled(enabled);
            if (enabled) setMicError("");
            if (!enabled) setMicVolume(0);
          },
          onMicVolumeChanged: (volume) => {
            if (disposed) return;
            setMicVolume(volume);
          },
          onRemoteMicStateChanged: (participantId, speaking) => {
            if (disposed) return;
            setRemoteSpeakers((prev) => {
              const next = new Set(prev);
              if (speaking) next.add(participantId);
              else next.delete(participantId);
              return next;
            });
            // 有人开始说话时，确保 audio 元素在播放（绕过自动播放限制的兜底）
            if (speaking) {
              ensureVoicePlayingRef.current?.("remote-speech-start");
            }
          },
          onVoiceConnected: () => {
            if (disposed) return;
            setVoiceConnected(true);
            diagnosticLog("voice", "sfu.connected");
            // SFU 重连后 voiceStream 是新对象，需要重新绑定到 audio 元素
            const audio = voiceAudioRef.current;
            const mgr = managerRef.current;
            if (audio && mgr) {
              const newStream = mgr.getRemoteVoiceStream();
              if (newStream && audio.srcObject !== newStream) {
                // 清理旧 stream 的事件监听
                if (lastVoiceStreamRef.current && lastVoiceStreamRef.current !== newStream) {
                  lastVoiceStreamRef.current.onaddtrack = null;
                }
                audio.srcObject = newStream;
                lastVoiceStreamRef.current = newStream;
                // 重新监听新音轨添加事件
                newStream.onaddtrack = () => {
                  diagnosticLog("voice", "stream.track-added", {
                    trackCount: newStream.getAudioTracks().length,
                  });
                  ensureVoicePlayingRef.current?.("on-addtrack-reconnect");
                };
                diagnosticLog("voice", "audio.rebound-after-reconnect", {
                  trackCount: newStream.getAudioTracks().length,
                });
                // 如果已经有音轨了，立即播放
                if (newStream.getAudioTracks().length > 0) {
                  ensureVoicePlayingRef.current?.("tracks-present-on-reconnect");
                }
              }
            }
          },
          onVoiceDisconnected: () => {
            if (disposed) return;
            setVoiceConnected(false);
            diagnosticLog("voice", "sfu.disconnected");
          },
          // P2P 语音回调
          onP2PRemoteMicAdded: (participantId, track) => {
            if (disposed) return;
            diagnosticLog("voice", "p2p.remote-mic-added", { participantId, trackId: track.id });
            // P2P 模式：把远程麦克风音轨加到语音播放流
            const audio = voiceAudioRef.current;
            if (audio) {
              let stream = audio.srcObject as MediaStream | null;
              if (!stream) {
                stream = new MediaStream();
                audio.srcObject = stream;
              }
              if (!stream.getTracks().includes(track)) {
                stream.addTrack(track);
                diagnosticLog("voice", "p2p.track-added-to-stream", {
                  participantId,
                  trackCount: stream.getAudioTracks().length,
                });
              }
              setVoiceMode("p2p");
              ensureVoicePlayingRef.current?.("p2p-mic-added");
            }
          },
          onP2PRemoteMicRemoved: (participantId) => {
            if (disposed) return;
            diagnosticLog("voice", "p2p.remote-mic-removed", { participantId });
          },
        },
        VIDEO_PRESETS[2]!,
      );
      managerRef.current = manager;
      // manager 创建好后，如果 audio 元素已经挂载了，重新绑定语音流
      // （因为 bindVoiceAudio callback ref 在 manager 创建前就执行过了，那时候 manager 还是 null）
      const audioEl = voiceAudioRef.current;
      if (audioEl) {
        const voiceStream = manager.getRemoteVoiceStream();
        if (voiceStream) {
          // 清理旧 stream 的事件监听
          if (lastVoiceStreamRef.current && lastVoiceStreamRef.current !== voiceStream) {
            lastVoiceStreamRef.current.onaddtrack = null;
          }
          if (audioEl.srcObject !== voiceStream) {
            audioEl.srcObject = voiceStream;
          }
          lastVoiceStreamRef.current = voiceStream;
          // 监听新音轨添加事件：每次重连后新音轨加入时自动恢复播放
          voiceStream.onaddtrack = () => {
            diagnosticLog("voice", "stream.track-added", {
              trackCount: voiceStream.getAudioTracks().length,
            });
            ensureVoicePlayingRef.current?.("on-addtrack");
          };
          audioEl.volume = 1.0;
          audioEl.muted = false;
          diagnosticLog("voice", "audio.bound-after-manager-ready", {
            trackCount: voiceStream.getAudioTracks().length,
          });
          // 如果已经有音轨了，立即尝试播放
          if (voiceStream.getAudioTracks().length > 0) {
            ensureVoicePlayingRef.current?.("tracks-already-present-on-ready");
          }
        }
      }

      signaling.onMessage = (message) => {
        if (disposed || !manager) return;
        updateRoomState(message, manager, voiceManager);
        // 语音消息（connectionId 以 voice- 开头）交给 voiceManager 处理
        if (
          (message.type === "rtc.offer" || message.type === "rtc.answer" || message.type === "rtc.ice") &&
          message.connectionId.startsWith("voice-")
        ) {
          if (!voiceManager) {
            diagnosticLog("voice-p2p", "msg.dropped-no-manager", { type: message.type, connectionId: message.connectionId }, "warn");
            return;
          }
          diagnosticLog("voice-p2p", "msg.received", { type: message.type, connectionId: message.connectionId });
          const msg = message as {
            type: "rtc.offer" | "rtc.answer" | "rtc.ice";
            connectionId: string;
            participantId?: string;
            description?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
          };
          if (msg.type === "rtc.offer" && msg.participantId && msg.description) {
            void voiceManager.handleOffer(msg.connectionId, msg.participantId, msg.description).catch((error) => {
              diagnosticLog("voice-p2p", "offer-handler.failed", errorDetails(error), "error");
            });
          } else if (msg.type === "rtc.answer" && msg.description) {
            void voiceManager.handleAnswer(msg.connectionId, msg.description).catch((error) => {
              diagnosticLog("voice-p2p", "answer-handler.failed", errorDetails(error), "error");
            });
          } else if (msg.type === "rtc.ice" && msg.candidate) {
            void voiceManager.handleIce(msg.connectionId, msg.candidate).catch((error) => {
              diagnosticLog("voice-p2p", "ice-handler.failed", errorDetails(error), "error");
            });
          } else {
            diagnosticLog("voice-p2p", "msg.dropped-invalid", { type: msg.type, hasParticipantId: !!msg.participantId, hasDescription: !!msg.description, hasCandidate: !!msg.candidate }, "warn");
          }
          return;
        }
        void manager.handleSignal(message).catch((error) => {
          diagnosticLog("media", "signal-handler.failed", errorDetails(error), "error");
          setMediaError(error instanceof Error ? error.message : "媒体信令处理失败");
        });
      };
      try {
        const snapshot = await signaling.connect();
        // Disposal during the handshake: `connect()` clears manualClose and opens a new socket, so
        // the earlier cleanup close would otherwise be undone here.
        if (disposed) {
          signaling.close();
          return;
        }
        applySnapshot(snapshot);
      } catch (error) {
        if (disposed) return;
        diagnosticLog("room", "connect.failed", errorDetails(error), "error");
        setConnectionState("failed");
        setMediaError(error instanceof Error ? error.message : "无法连接房间");
      }
    };

    const updateRoomState = (message: ServerSignalMessage, mediaManager: P2PMediaManager, voiceManager: P2PVoiceManager | undefined) => {
      // Independent of the media flow: the sharing banner must reflect the audience.
      setWatchers((current) => updateActiveWatchers(current, message));
      switch (message.type) {
        case "auth.ok":
          applySnapshot(message.snapshot);
          return;
        case "participant.joined":
          setParticipants((current) => [
            ...current.filter((participant) => participant.id !== message.participant.id),
            message.participant,
          ]);
          // 如果自己开麦了，主动给新参与者发起语音连接
          if (voiceManager?.isMicEnabled && message.participant.id !== session.participant.id) {
            void voiceManager.callParticipant(message.participant.id).catch((error) => {
              diagnosticLog("voice", "auto-call.failed", errorDetails(error), "warn");
            });
          }
          return;
        case "participant.left":
          setParticipants((current) =>
            current.filter((participant) => participant.id !== message.participantId),
          );
          setShares((current) =>
            current.filter((share) => share.participantId !== message.participantId),
          );
          mediaManager.handleShareStopped(message.participantId);
          // 清理语音连接
          voiceManager?.handleParticipantLeft(message.participantId);
          return;
        case "share.updated":
          setShares((current) => [
            ...current.filter((share) => share.participantId !== message.share.participantId),
            message.share,
          ]);
          if (message.share.participantId === session.participant.id) {
            mediaManager.setViewerCount(message.share.viewerCount);
          }
          return;
        case "share.stopped":
          setShares((current) =>
            current.filter((share) => share.participantId !== message.participantId),
          );
          mediaManager.handleShareStopped(message.participantId);
          return;
        case "room.closed":
          setConnectionState("disconnected");
          setMediaError(message.reason);
          return;
        default:
          return;
      }
    };

    void initialize();
    return () => {
      disposed = true;
      diagnosticLog("room", "session.disposed", { participantId: session.participant.id });
      signaling.close();
      signalingRef.current = undefined;
      managerRef.current = undefined;
      // 关闭语音管理器
      try {
        voiceManagerRef.current?.close();
      } catch (error) {
        diagnosticLog("room", "voice-manager.close.failed", errorDetails(error), "warn");
      }
      voiceManagerRef.current = undefined;
      // `close()` awaits the SFU disconnect, which can reject; an unhandled rejection here would
      // escape teardown. Optional chaining short-circuits the whole chain when no manager was built.
      void manager?.close().catch((error) => {
        diagnosticLog("room", "manager.close.failed", errorDetails(error), "warn");
      });
    };
  }, [applySnapshot, session]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryAttempts = 0;
    // Keep the video element isolated from the system-audio bridge. Chromium
    // reports audio decode failures on the video element for a combined stream,
    // even while video RTP is still decoding successfully.
    const displayStream = selectedStream
      ? new MediaStream(selectedStream.getVideoTracks())
      : null;
    const attach = (reason: "initial" | "decode-recovery") => {
      if (disposed || !displayStream) return;
      video.srcObject = displayStream;
      video.muted = true;
      video.autoplay = true;
      diagnosticLog("viewer", "video.src-object", {
        attached: true,
        reason,
        tracks: displayStream.getTracks().map((track) => ({
          kind: track.kind,
          id: track.id,
          muted: track.muted,
          readyState: track.readyState,
        })),
      });
      void video.play()
        .then(() => diagnosticLog("viewer", "video.play.resolved", { reason }))
        .catch((error) => diagnosticLog("viewer", "video.play.rejected", { reason, ...errorDetails(error) }, "error"));
    };
    const recoverFromDecodeError = () => {
      if (disposed || !displayStream || video.srcObject !== displayStream) return;
      if (recoveryAttempts >= 2) {
        diagnosticLog("viewer", "video.decode-recovery.exhausted", {
          attempts: recoveryAttempts,
        }, "error");
        return;
      }
      recoveryAttempts += 1;
      const attempt = recoveryAttempts;
      diagnosticLog("viewer", "video.decode-recovery.scheduled", { attempt }, "warn");
      video.pause();
      video.srcObject = null;
      video.load();
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (disposed) return;
        diagnosticLog("viewer", "video.decode-recovery.started", { attempt }, "warn");
        attach("decode-recovery");
      }, attempt * 150);
    };
    const onVideoError = () => {
      // Chromium exposes MEDIA_ERR_DECODE as code 3. Use the numeric value so
      // this also works in Electron contexts where MediaError is not global.
      if (video.error?.code === 3) recoverFromDecodeError();
    };
    video.addEventListener("error", onVideoError);
    attach("initial");
    const timer = selectedStream
      ? setInterval(() => {
          diagnosticLog("viewer", "video.element-state", {
            readyState: video.readyState,
            networkState: video.networkState,
            paused: video.paused,
            ended: video.ended,
            currentTime: video.currentTime,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          });
        }, 15_000)
      : undefined;
    return () => {
      disposed = true;
      video.removeEventListener("error", onVideoError);
      if (timer) clearInterval(timer);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      if (video.srcObject === displayStream) video.srcObject = null;
    };
  }, [selectedStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const eventNames = [
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "playing",
      "waiting",
      "stalled",
      "suspend",
      "emptied",
      "ended",
      "error",
      "resize",
    ] as const;
    const listeners = eventNames.map((eventName) => {
      const listener = () => diagnosticLog(
        "viewer",
        `video.${eventName}`,
        {
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          currentTime: video.currentTime,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          errorCode: video.error?.code,
          errorMessage: video.error?.message,
        },
        eventName === "error" || eventName === "stalled" ? "warn" : "info",
      );
      video.addEventListener(eventName, listener);
      return { eventName, listener };
    });
    return () => {
      for (const { eventName, listener } of listeners) {
        video.removeEventListener(eventName, listener);
      }
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const isLocal = displayedSharerId === session.participant.id;
    const audioStream = isLocal || !selectedStream
      ? null
      : new MediaStream(selectedStream.getAudioTracks());
    audio.srcObject = audioStream;
    if (audio.srcObject) {
      audio.play().catch((error) => {
        diagnosticLog("viewer", "audio.play.rejected", errorDetails(error), "warn");
        setAudioBlocked(true);
      });
    }
    return () => {
      if (audio.srcObject === audioStream) audio.srcObject = null;
    };
  }, [displayedSharerId, selectedStream, session.participant.id]);

  const sharers = useMemo<RoomSharer[]>(
    () =>
      shares.map((share) => ({
        id: share.participantId,
        name: share.displayName,
        isLocal: share.participantId === session.participant.id,
        preset: share.preset,
        hasSystemAudio: share.hasSystemAudio,
        viewerCount: share.viewerCount,
      })),
    [session.participant.id, shares],
  );

  const selectSharer = useCallback(
    (participantId: string) => {
      const share = shares.find((candidate) => candidate.participantId === participantId);
      if (!share) return;
      setSelectedSharerId(participantId);
      setMediaError("");
      managerRef.current?.selectShare(share);
    },
    [shares],
  );

  const startSharing = useCallback(async (sourceId: string, preset: VideoPreset) => {
    const manager = managerRef.current;
    if (!manager) throw new Error("房间连接尚未建立");
    await manager.startSharing(sourceId, preset);
  }, []);

  const updateSharePreset = useCallback(async (preset: VideoPreset) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.updatePreset(preset);
  }, []);

  const stopSharing = useCallback(async () => {
    await managerRef.current?.stopSharing();
  }, []);

  const retryConnection = useCallback(() => signalingRef.current?.reconnect(), []);
  const retryMediaConnection = useCallback(() => managerRef.current?.retrySelectedShare(), []);
  const resumeAudio = useCallback(async () => {
    await audioRef.current?.play();
    setAudioBlocked(false);
  }, []);

  // 语音播放：把远程麦克风混合流绑定到 audio 元素
  // 用 ref 回调确保每次 audio 元素变化时都重新绑定
  const voiceAudioRef = useRef<HTMLAudioElement>(null);
  const voicePlayAttemptedRef = useRef(false);

  const logAudioState = useCallback((label: string) => {
    const audio = voiceAudioRef.current;
    const manager = managerRef.current;
    const stream = manager?.getRemoteVoiceStream();
    diagnosticLog("voice", "audio-state", {
      label,
      audioExists: !!audio,
      audioPaused: audio?.paused ?? null,
      audioMuted: audio?.muted ?? null,
      audioVolume: audio?.volume ?? null,
      audioReadyState: audio?.readyState ?? null,
      srcObjectSet: audio ? audio.srcObject !== null : null,
      streamTrackCount: stream?.getAudioTracks().length ?? null,
      playAttempted: voicePlayAttemptedRef.current,
    });
  }, []);

  const ensureVoicePlaying = useCallback((reason: string) => {
    const audio = voiceAudioRef.current;
    if (!audio) {
      diagnosticLog("voice", "play.skipped", { reason, why: "no-audio-element" });
      return;
    }
    if (audio.paused) {
      voicePlayAttemptedRef.current = true;
      audio
        .play()
        .then(() => {
          diagnosticLog("voice", "play.resolved", { reason });
          logAudioState("after-play-resolved");
        })
        .catch((error) => {
          diagnosticLog("voice", "play.rejected", { reason, error: errorDetails(error) }, "warn");
        });
    } else {
      diagnosticLog("voice", "play.already-playing", { reason });
    }
  }, [logAudioState]);

  // 把 ensureVoicePlaying 存到 ref 里，方便在 useEffect 回调中使用
  ensureVoicePlayingRef.current = ensureVoicePlaying;

  const bindVoiceAudio = useCallback((audio: HTMLAudioElement | null) => {
    voiceAudioRef.current = audio;
    if (!audio) return;
    const manager = managerRef.current;
    if (!manager) {
      diagnosticLog("voice", "audio.bound-no-manager");
      return;
    }
    const voiceStream = manager.getRemoteVoiceStream();
    if (!voiceStream) {
      diagnosticLog("voice", "audio.bound-no-stream");
      return;
    }
    // 只有当 stream 变化时才重新设置
    if (audio.srcObject !== voiceStream) {
      // 清理旧 stream 的事件监听
      if (lastVoiceStreamRef.current && lastVoiceStreamRef.current !== voiceStream) {
        lastVoiceStreamRef.current.onaddtrack = null;
      }
      audio.srcObject = voiceStream;
      lastVoiceStreamRef.current = voiceStream;
      diagnosticLog("voice", "audio.stream-bound", {
        trackCount: voiceStream.getAudioTracks().length,
      });
      // 监听新音轨添加事件：每次重连后新音轨加入时自动恢复播放
      voiceStream.onaddtrack = () => {
        diagnosticLog("voice", "stream.track-added", {
          trackCount: voiceStream.getAudioTracks().length,
        });
        ensureVoicePlayingRef.current?.("on-addtrack");
      };
      // 如果已经有音轨了，立即尝试播放
      if (voiceStream.getAudioTracks().length > 0) {
        ensureVoicePlayingRef.current?.("tracks-already-present");
      }
    }
    audio.volume = 1.0;
    audio.muted = false;
    logAudioState("after-bind");
    // 尝试播放（可能因为自动播放策略失败，失败了也没关系，用户点麦克风时会再试）
    ensureVoicePlaying("auto-on-bind");
  }, [ensureVoicePlaying, logAudioState]);

  // 麦克风控制
  const toggleMicrophone = useCallback(async () => {
    const voiceManager = voiceManagerRef.current;
    if (!voiceManager) return;
    try {
      setMicError("");
      if (voiceManager.isMicEnabled) {
        await voiceManager.stopMicrophone();
        setMicEnabled(false);
        setVoiceMode("none");
      } else {
        // 独立 P2P 语音：不依赖屏幕共享，进房间就能开麦
        // 给房间里所有其他参与者发起语音连接
        diagnosticLog("voice", "mic.start", { participantCount: participants.length });
        await voiceManager.startMicrophone();
        setMicEnabled(true);
        // 给所有其他参与者发起语音连接
        const otherParticipants = participants.filter((p) => p.id !== voiceManager.localId);
        diagnosticLog("voice", "mic.calling-participants", { count: otherParticipants.length });
        for (const participant of otherParticipants) {
          void voiceManager.callParticipant(participant.id).catch((error) => {
            diagnosticLog("voice", "mic.call-failed", { participantId: participant.id, ...errorDetails(error) }, "warn");
          });
        }
        setVoiceMode("p2p");
        // 开麦成功后，确保语音播放也启动了（用户交互后浏览器允许自动播放）
        ensureVoicePlaying("after-mic-toggle");
      }
    } catch (error) {
      setMicError(error instanceof Error ? error.message : "麦克风操作失败");
      diagnosticLog("voice", "mic.toggle-failed", errorDetails(error), "error");
    }
  }, [ensureVoicePlaying, participants]);

  return {
    participants,
    sharers,
    selectedSharer: sharers.find((sharer) => sharer.id === selectedSharerId),
    selectedSharerId,
    displayedSharerId,
    selectSharer,
    startSharing,
    updateSharePreset,
    stopSharing,
    isSharing,
    watchers,
    localPreviewStream,
    hasSystemAudio,
    connectionState,
    mediaError,
    retryConnection,
    retryMediaConnection,
    connectionStage,
    audioBlocked,
    resumeAudio,
    participantCount: participants.length,
    transport,
    stats,
    publisherStats,
    captureMode,
    encoder,
    videoRef,
    audioRef,
    // 麦克风语音
    micEnabled,
    micError,
    micVolume,
    voiceConnected,
    voiceMode,
    voiceAvailable: Boolean(session.sfu),
    remoteSpeakers,
    toggleMicrophone,
    bindVoiceAudio,
  };
}
