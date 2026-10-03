import type { IceServerConfig } from "@gamecast/contracts";
import { diagnosticLog, errorDetails } from "../diagnostics";
import type { SignalingClient } from "./signaling-client";

export type VoiceCallbacks = {
  onRemoteMicStarted: (participantId: string, track: MediaStreamTrack) => void;
  onRemoteMicStopped: (participantId: string) => void;
  onConnected: () => void;
  onDisconnected: () => void;
};

type VoiceConnection = {
  pc: RTCPeerConnection;
  participantId: string;
  connectionId: string;
  role: "offerer" | "answerer";
  remoteDescriptionSet: boolean;
  pendingCandidates: RTCIceCandidate[];
  timeoutTimer?: ReturnType<typeof setTimeout>;
  connected: boolean;
};

/**
 * 独立的 P2P 语音连接管理器
 * 不依赖屏幕共享，进房间就能开麦语音
 * 走 TURN 中继，和屏幕共享一样稳定
 *
 * 连接用 connectionId 索引（因为 answer/ice 消息只有 connectionId）
 * 同时维护 participantId -> connectionId 的映射
 */
export class P2PVoiceManager {
  private connections = new Map<string, VoiceConnection>(); // connectionId -> connection
  private participantToConnection = new Map<string, string>(); // participantId -> connectionId
  private micTrack: MediaStreamTrack | undefined;
  private micStream: MediaStream | undefined;
  private micEnabled = false;
  private callbacks: VoiceCallbacks;
  private iceServers: RTCIceServer[] = [];
  private localParticipantId: string;
  private signaling: SignalingClient;
  private disposed = false;

  constructor(
    localParticipantId: string,
    iceServers: IceServerConfig[],
    signaling: SignalingClient,
    callbacks: VoiceCallbacks,
  ) {
    this.localParticipantId = localParticipantId;
    this.signaling = signaling;
    this.callbacks = callbacks;
    this.iceServers = iceServers.map((s) => ({
      urls: s.urls,
      username: s.username,
      credential: s.credential,
    }));
    diagnosticLog("voice-p2p", "manager.created", {
      iceServerCount: this.iceServers.length,
      hasTurn: this.iceServers.some((s) =>
        Array.isArray(s.urls) ? s.urls.some((u) => u.includes("turn:")) : s.urls?.includes("turn:"),
      ),
    });
  }

  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get localId(): string {
    return this.localParticipantId;
  }

  async startMicrophone(): Promise<void> {
    if (this.micEnabled) return;
    diagnosticLog("voice-p2p", "mic.start.requested");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("未获取到麦克风音轨");
      this.micStream = stream;
      this.micTrack = audioTrack;
      this.micEnabled = true;
      diagnosticLog("voice-p2p", "mic.started", { trackId: audioTrack.id });
    } catch (error) {
      diagnosticLog("voice-p2p", "mic.start-failed", errorDetails(error), "error");
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = undefined;
      }
      this.micTrack = undefined;
      this.micEnabled = false;
      throw error;
    }
  }

  async stopMicrophone(): Promise<void> {
    if (!this.micEnabled) return;
    diagnosticLog("voice-p2p", "mic.stop.requested");
    // 关闭所有语音连接
    for (const [connectionId, conn] of this.connections) {
      try {
        conn.pc.close();
      } catch {
        // ignore
      }
      this.callbacks.onRemoteMicStopped(conn.participantId);
    }
    this.connections.clear();
    this.participantToConnection.clear();
    // 停止麦克风
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = undefined;
    }
    this.micTrack = undefined;
    this.micEnabled = false;
    this.callbacks.onDisconnected();
    diagnosticLog("voice-p2p", "mic.stopped");
  }

  /**
   * 给指定参与者发起语音连接
   */
  async callParticipant(participantId: string): Promise<void> {
    if (!this.micEnabled || !this.micTrack || !this.micStream) {
      throw new Error("麦克风未开启");
    }
    // 如果已有连接，先关闭旧的
    const oldConnId = this.participantToConnection.get(participantId);
    if (oldConnId) {
      this.closeConnection(oldConnId);
    }
    const connectionId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
    });
    const conn: VoiceConnection = {
      pc,
      participantId,
      connectionId,
      role: "offerer",
      remoteDescriptionSet: false,
      pendingCandidates: [],
      connected: false,
    };
    this.connections.set(connectionId, conn);
    this.participantToConnection.set(participantId, connectionId);
    diagnosticLog("voice-p2p", "call.started", { participantId, connectionId });

    // 连接超时检测（15 秒）
    conn.timeoutTimer = setTimeout(() => {
      if (!conn.connected && this.connections.has(connectionId)) {
        diagnosticLog("voice-p2p", "connection.timeout", { participantId, connectionId, role: "offerer" }, "warn");
        this.closeConnection(connectionId);
      }
    }, 15_000);

    // 添加麦克风音轨
    pc.addTrack(this.micTrack, this.micStream);

    // 监听远程音轨
    pc.ontrack = (event) => {
      if (event.track.kind === "audio") {
        diagnosticLog("voice-p2p", "remote-track.received", {
          participantId,
          trackId: event.track.id,
        });
        this.callbacks.onRemoteMicStarted(participantId, event.track);
        event.track.addEventListener("ended", () => {
          this.callbacks.onRemoteMicStopped(participantId);
        });
      }
    };

    // ICE 候选
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendIceCandidate(conn, event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      diagnosticLog("voice-p2p", "connection.state", {
        participantId,
        state: pc.connectionState,
        role: "offerer",
      });
      if (pc.connectionState === "connected") {
        conn.connected = true;
        if (conn.timeoutTimer) {
          clearTimeout(conn.timeoutTimer);
          conn.timeoutTimer = undefined;
        }
        this.callbacks.onConnected();
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.callbacks.onDisconnected();
      }
    };

    // 创建 offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 发送 offer（connectionId 以 voice- 开头，用于区分语音和屏幕共享信令）
    this.signaling.send({
      type: "rtc.offer",
      connectionId,
      targetParticipantId: participantId,
      description: { type: "offer", sdp: offer.sdp ?? "" },
    });

    diagnosticLog("voice-p2p", "offer.sent", { participantId, connectionId });
  }

  /**
   * 收到语音 offer 时处理
   */
  async handleOffer(
    connectionId: string,
    fromParticipantId: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    // 如果已有连接，先关闭旧的
    const oldConnId = this.participantToConnection.get(fromParticipantId);
    if (oldConnId && oldConnId !== connectionId) {
      this.closeConnection(oldConnId);
    }
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
    });
    const conn: VoiceConnection = {
      pc,
      participantId: fromParticipantId,
      connectionId,
      role: "answerer",
      remoteDescriptionSet: false,
      pendingCandidates: [],
      connected: false,
    };
    this.connections.set(connectionId, conn);
    this.participantToConnection.set(fromParticipantId, connectionId);
    diagnosticLog("voice-p2p", "offer.received", { participantId: fromParticipantId, connectionId, micEnabled: this.micEnabled });

    // 连接超时检测（15 秒）
    conn.timeoutTimer = setTimeout(() => {
      if (!conn.connected && this.connections.has(connectionId)) {
        diagnosticLog("voice-p2p", "connection.timeout", { participantId: fromParticipantId, connectionId, role: "answerer" }, "warn");
        this.closeConnection(connectionId);
      }
    }, 15_000);

    // 如果自己也开了麦，把音轨加进去（双向语音）
    if (this.micEnabled && this.micTrack && this.micStream) {
      pc.addTrack(this.micTrack, this.micStream);
    }

    // 监听远程音轨
    pc.ontrack = (event) => {
      if (event.track.kind === "audio") {
        diagnosticLog("voice-p2p", "remote-track.received", {
          participantId: fromParticipantId,
          trackId: event.track.id,
        });
        this.callbacks.onRemoteMicStarted(fromParticipantId, event.track);
        event.track.addEventListener("ended", () => {
          this.callbacks.onRemoteMicStopped(fromParticipantId);
        });
      }
    };

    // ICE 候选
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendIceCandidate(conn, event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      diagnosticLog("voice-p2p", "connection.state", {
        participantId: fromParticipantId,
        state: pc.connectionState,
        role: "answerer",
      });
      if (pc.connectionState === "connected") {
        conn.connected = true;
        if (conn.timeoutTimer) {
          clearTimeout(conn.timeoutTimer);
          conn.timeoutTimer = undefined;
        }
        this.callbacks.onConnected();
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.callbacks.onDisconnected();
      }
    };

    await pc.setRemoteDescription(description);
    conn.remoteDescriptionSet = true;

    // 处理暂存的 ICE 候选
    for (const candidate of conn.pendingCandidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        diagnosticLog("voice-p2p", "ice.pending-add-failed", errorDetails(error), "warn");
      }
    }
    conn.pendingCandidates = [];

    // 创建 answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // 发送 answer
    this.signaling.send({
      type: "rtc.answer",
      connectionId,
      targetParticipantId: fromParticipantId,
      description: { type: "answer", sdp: answer.sdp ?? "" },
    });

    diagnosticLog("voice-p2p", "answer.sent", { participantId: fromParticipantId, connectionId });
  }

  /**
   * 收到 answer 时处理
   */
  async handleAnswer(
    connectionId: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      diagnosticLog("voice-p2p", "answer.no-connection", { connectionId }, "warn");
      return;
    }
    diagnosticLog("voice-p2p", "answer.received", { participantId: conn.participantId, connectionId });
    await conn.pc.setRemoteDescription(description);
    conn.remoteDescriptionSet = true;

    // 处理暂存的 ICE 候选
    for (const candidate of conn.pendingCandidates) {
      try {
        await conn.pc.addIceCandidate(candidate);
      } catch (error) {
        diagnosticLog("voice-p2p", "ice.pending-add-failed", errorDetails(error), "warn");
      }
    }
    conn.pendingCandidates = [];
  }

  /**
   * 收到 ICE 候选时处理
   */
  async handleIce(
    connectionId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return;
    }
    if (!conn.remoteDescriptionSet) {
      // 远端描述还没设置，先暂存候选
      conn.pendingCandidates.push(new RTCIceCandidate(candidate));
      return;
    }
    try {
      await conn.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      diagnosticLog("voice-p2p", "ice.add-failed", errorDetails(error), "warn");
    }
  }

  private sendIceCandidate(conn: VoiceConnection, candidate: RTCIceCandidate): void {
    const json = candidate.toJSON();
    if (!json.candidate) {
      // 空候选表示 ICE 收集完成，发送 null
      this.signaling.send({
        type: "rtc.ice",
        connectionId: conn.connectionId,
        targetParticipantId: conn.participantId,
        candidate: null,
      });
      return;
    }
    this.signaling.send({
      type: "rtc.ice",
      connectionId: conn.connectionId,
      targetParticipantId: conn.participantId,
      candidate: {
        candidate: json.candidate,
        sdpMid: json.sdpMid ?? null,
        sdpMLineIndex: json.sdpMLineIndex ?? null,
        usernameFragment: json.usernameFragment ?? null,
      },
    });
  }

  private closeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    if (conn.timeoutTimer) {
      clearTimeout(conn.timeoutTimer);
      conn.timeoutTimer = undefined;
    }
    try {
      conn.pc.close();
    } catch {
      // ignore
    }
    this.connections.delete(connectionId);
    this.participantToConnection.delete(conn.participantId);
    this.callbacks.onRemoteMicStopped(conn.participantId);
    diagnosticLog("voice-p2p", "connection.closed", {
      participantId: conn.participantId,
      connectionId,
      role: conn.role,
      wasConnected: conn.connected,
    });
  }

  /**
   * 参与者离开时清理连接
   */
  handleParticipantLeft(participantId: string): void {
    const connectionId = this.participantToConnection.get(participantId);
    if (connectionId) {
      this.closeConnection(connectionId);
    }
  }

  /**
   * 获取当前所有连接的参与者 ID
   */
  getConnectedParticipants(): string[] {
    return Array.from(this.participantToConnection.keys());
  }

  close(): void {
    this.disposed = true;
    for (const [connectionId, conn] of this.connections) {
      try {
        conn.pc.close();
      } catch {
        // ignore
      }
      this.callbacks.onRemoteMicStopped(conn.participantId);
    }
    this.connections.clear();
    this.participantToConnection.clear();
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = undefined;
    }
    this.micTrack = undefined;
    this.micEnabled = false;
    this.callbacks.onDisconnected();
    diagnosticLog("voice-p2p", "manager.closed");
  }
}
