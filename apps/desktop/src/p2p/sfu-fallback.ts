import type { SfuSession, VideoPreset } from "@gamecast/contracts";
import type {
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  LocalTrackPublication,
} from "livekit-client";
import { diagnosticLog, errorDetails } from "../diagnostics";

type StreamWaiter = {
  targetParticipantId: string;
  stream: MediaStream;
  resolve: (stream: MediaStream) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  resolved: boolean;
};

export type SfuVoiceCallbacks = {
  onRemoteMicStarted: (participantId: string, track: MediaStreamTrack) => void;
  onRemoteMicStopped: (participantId: string) => void;
  onRemoteSpeakingChanged: (participantId: string, speaking: boolean) => void;
  onVoiceConnected: () => void;
  onVoiceDisconnected: () => void;
};

export class SfuFallback {
  private room: Room | undefined;
  private connecting: Promise<Room> | undefined;
  private sdk: typeof import("livekit-client") | undefined;
  private sdkPromise: Promise<typeof import("livekit-client")> | undefined;
  private publishedStream: MediaStream | undefined;
  private publishedSignature: string | undefined;
  private publicationOperation: Promise<void> = Promise.resolve();
  private subscribedTarget: string | undefined;
  private subscription: StreamWaiter | undefined;
  private iceServers: RTCIceServer[] = [];

  // 麦克风语音相关
  private micTrack: MediaStreamTrack | undefined;
  private micPublication: LocalTrackPublication | undefined;
  private voiceConnected = false;
  private voiceCallbacks: SfuVoiceCallbacks | undefined;
  private voiceStream: MediaStream | undefined;

  constructor(
    private readonly session: SfuSession | undefined,
    iceServers?: RTCIceServer[],
  ) {
    if (iceServers) {
      this.iceServers = iceServers;
    }
  }

  get available(): boolean {
    return Boolean(this.session);
  }

  get isVoiceConnected(): boolean {
    return this.voiceConnected;
  }

  setVoiceCallbacks(callbacks: SfuVoiceCallbacks): void {
    this.voiceCallbacks = callbacks;
  }

  /**
   * 提前建立 SFU 语音连接（只接收，不发布）
   * 进房间时调用，这样用户不用开麦也能听到别人说话
   */
  async ensureVoiceConnected(): Promise<void> {
    if (!this.available) return;
    if (this.voiceConnected) return;
    try {
      await this.ensureConnected();
      // ensureConnected 内部会触发 voiceConnected 状态
      diagnosticLog("sfu-voice", "connection.established");
    } catch (error) {
      diagnosticLog("sfu-voice", "connection.failed", errorDetails(error), "error");
      throw error;
    }
  }

  /**
   * 获取远程麦克风混合流（所有远程参与者的麦克风音轨混合）
   */
  getVoiceStream(): MediaStream {
    if (!this.voiceStream) {
      this.voiceStream = new MediaStream();
    }
    return this.voiceStream;
  }

  publish(stream: MediaStream, preset: VideoPreset, maxBitrate: number): Promise<void> {
    return this.enqueuePublication(() => this.publishExclusive(stream, preset, maxBitrate));
  }

  unpublish(): Promise<void> {
    return this.enqueuePublication(() => this.unpublishExclusive());
  }

  /**
   * 发布麦克风音轨到 SFU
   */
  async publishMicrophone(track: MediaStreamTrack): Promise<void> {
    if (!this.available) throw new Error("SFU 不可用，无法发布麦克风");
    const room = await this.ensureConnected();
    const sdk = await this.loadSdk();

    // 如果已经发布了同一条，跳过
    if (this.micTrack === track && this.micPublication) return;

    // 先取消之前的
    await this.unpublishMicrophone();

    try {
      const publication = await room.localParticipant.publishTrack(track, {
        source: sdk.Track.Source.Microphone,
        stream: `mic-${room.localParticipant.identity}`,
        forceStereo: false,
      });
      this.micTrack = track;
      this.micPublication = publication;
      diagnosticLog("sfu-voice", "mic.published", { trackId: track.id });
    } catch (error) {
      diagnosticLog("sfu-voice", "mic.publish-failed", errorDetails(error), "error");
      throw error;
    }
  }

  /**
   * 取消发布麦克风
   */
  async unpublishMicrophone(): Promise<void> {
    if (!this.room || !this.micTrack) return;
    try {
      await this.room.localParticipant.unpublishTrack(this.micTrack, false);
    } catch (error) {
      diagnosticLog("sfu-voice", "mic.unpublish-failed", errorDetails(error), "warn");
    }
    this.micTrack = undefined;
    this.micPublication = undefined;
    diagnosticLog("sfu-voice", "mic.unpublished");
  }

  private async publishExclusive(
    stream: MediaStream,
    preset: VideoPreset,
    maxBitrate: number,
  ): Promise<void> {
    const room = await this.ensureConnected();
    const sdk = await this.loadSdk();
    const signature = `${stream.id}:${preset.width}x${preset.height}@${preset.frameRate}:${maxBitrate}`;
    if (this.publishedStream === stream && this.publishedSignature === signature) return;
    await this.unpublishExclusive();
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("没有可发布的屏幕视频轨道");
    const streamName = `screen-${room.localParticipant.identity}`;
    const publishedTracks: MediaStreamTrack[] = [];
    try {
      await room.localParticipant.publishTrack(videoTrack, {
        source: sdk.Track.Source.ScreenShare,
        stream: streamName,
        videoCodec: "h264",
        simulcast: false,
        screenShareEncoding: {
          maxBitrate,
          maxFramerate: preset.frameRate,
        },
      });
      publishedTracks.push(videoTrack);
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        try {
          await room.localParticipant.publishTrack(audioTrack, {
            source: sdk.Track.Source.ScreenShareAudio,
            stream: streamName,
            forceStereo: true,
          });
          publishedTracks.push(audioTrack);
        } catch (error) {
          diagnosticLog("sfu", "audio.publish-failed", errorDetails(error), "warn");
        }
      }
      this.publishedStream = stream;
      this.publishedSignature = signature;
    } catch (error) {
      for (const track of publishedTracks) {
        await room.localParticipant.unpublishTrack(track, false).catch(() => undefined);
      }
      throw error;
    }
  }

  private async unpublishExclusive(): Promise<void> {
    if (!this.room || !this.publishedStream) return;
    for (const track of this.publishedStream.getTracks()) {
      await this.room.localParticipant.unpublishTrack(track, false).catch(() => undefined);
    }
    this.publishedStream = undefined;
    this.publishedSignature = undefined;
  }

  private enqueuePublication(operation: () => Promise<void>): Promise<void> {
    const queued = this.publicationOperation.catch(() => undefined).then(operation);
    this.publicationOperation = queued.catch(() => undefined);
    return queued;
  }

  async subscribe(targetParticipantId: string): Promise<MediaStream> {
    const room = await this.ensureConnected();
    this.unsubscribe();
    this.subscribedTarget = targetParticipantId;
    const stream = new MediaStream();
    const promise = new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.subscription?.stream === stream) this.subscription = undefined;
        reject(new Error("等待 SFU 画面超时"));
      }, 10_000);
      this.subscription = {
        targetParticipantId,
        stream,
        resolve,
        reject,
        timer,
        resolved: false,
      };
    });
    const participant = room.remoteParticipants.get(targetParticipantId);
    if (participant) this.subscribeParticipant(participant);
    return promise;
  }

  unsubscribe(): void {
    if (this.subscription) {
      if (this.subscription.timer) clearTimeout(this.subscription.timer);
      if (!this.subscription.resolved) {
        this.subscription.reject(new Error("已切换到其他共享者"));
      }
      // The stream handed to the caller otherwise keeps live remote tracks after we stop watching.
      for (const track of this.subscription.stream.getTracks()) {
        this.subscription.stream.removeTrack(track);
        track.stop();
      }
      this.subscription = undefined;
    }
    if (this.room && this.subscribedTarget) {
      const participant = this.room.remoteParticipants.get(this.subscribedTarget);
      if (participant) {
        for (const publication of participant.trackPublications.values()) {
          // 只取消屏幕共享相关的订阅，保留麦克风
          if (
            publication.source === (this.sdk?.Track.Source.ScreenShare ?? 2) ||
            publication.source === (this.sdk?.Track.Source.ScreenShareAudio ?? 3)
          ) {
            (publication as RemoteTrackPublication).setSubscribed(false);
          }
        }
      }
    }
    this.subscribedTarget = undefined;
  }

  async disconnect(): Promise<void> {
    this.unsubscribe();
    await this.unpublish();
    await this.unpublishMicrophone();
    this.voiceConnected = false;
    this.voiceCallbacks?.onVoiceDisconnected();
    // 清理语音流
    if (this.voiceStream) {
      for (const track of this.voiceStream.getTracks()) {
        track.stop();
        this.voiceStream.removeTrack(track);
      }
      this.voiceStream = undefined;
    }
    this.room?.disconnect();
    this.room = undefined;
    this.connecting = undefined;
  }

  private async ensureConnected(): Promise<Room> {
    if (!this.session) throw new Error("房主没有配置可用的 SFU");
    if (this.room?.state === "connected") return this.room;
    if (this.connecting) return this.connecting;
    const sdk = await this.loadSdk();

    const room = new sdk.Room({
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
    });
    this.registerEvents(room, sdk);

    // 构建连接选项
    const connectOptions: Parameters<typeof room.connect>[2] = {
      autoSubscribe: false,
      // 增加连接超时（默认15秒，国内网络容易超时）
      peerConnectionTimeout: 20_000, // 20秒
      websocketTimeout: 10_000, // 10秒
    };

    // 如果有 TURN 服务器，加到 RTC 配置里（走 TURN 中继更稳定）
    if (this.iceServers.length > 0) {
      connectOptions.rtcConfig = {
        iceServers: this.iceServers,
      };
      diagnosticLog("sfu-voice", "ice-servers.configured", {
        count: this.iceServers.length,
        hasTurn: this.iceServers.some((s) =>
          typeof s.urls === "string"
            ? s.urls.includes("turn:")
            : s.urls?.some((u) => u.includes("turn:")),
        ),
      });
    }

    // 连接超时保护
    const connectTimeoutMs = 25_000; // 25秒总超时
    const connectPromise = room.connect(this.session.serverUrl, this.session.token, connectOptions);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`SFU 连接超时（${connectTimeoutMs}ms）`)), connectTimeoutMs);
    });

    this.connecting = Promise.race([connectPromise, timeoutPromise])
      .then(() => {
        this.room = room;
        this.connecting = undefined;
        // 连接成功后自动订阅所有远程参与者的麦克风
        this.subscribeAllMicrophones(room, sdk);
        if (!this.voiceConnected) {
          this.voiceConnected = true;
          this.voiceCallbacks?.onVoiceConnected();
          diagnosticLog("sfu-voice", "connected");
        }
        return room;
      })
      .catch((error) => {
        this.connecting = undefined;
        room.disconnect();
        throw error;
      });
    return this.connecting;
  }

  /**
   * 订阅房间内所有远程参与者的麦克风音轨
   */
  private subscribeAllMicrophones(room: Room, sdk: typeof import("livekit-client")): void {
    for (const participant of room.remoteParticipants.values()) {
      this.subscribeParticipantMicrophone(participant, sdk);
    }
  }

  private subscribeParticipantMicrophone(
    participant: RemoteParticipant,
    sdk: typeof import("livekit-client"),
  ): void {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === sdk.Track.Source.Microphone) {
        (publication as RemoteTrackPublication).setSubscribed(true);
      }
    }
  }

  private registerEvents(room: Room, sdk: typeof import("livekit-client")): void {
    room.on(sdk.RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity === this.subscribedTarget) this.subscribeParticipant(participant);
      // 新参与者加入时订阅其麦克风
      this.subscribeParticipantMicrophone(participant, sdk);
      diagnosticLog("sfu-voice", "participant.joined", { id: participant.identity });
    });

    room.on(sdk.RoomEvent.ParticipantDisconnected, (participant) => {
      // 参与者离开时，从语音流中移除其音轨
      this.removeRemoteMic(participant.identity);
      diagnosticLog("sfu-voice", "participant.left", { id: participant.identity });
    });

    room.on(sdk.RoomEvent.TrackPublished, (publication, participant) => {
      // 屏幕共享相关的订阅
      if (participant.identity === this.subscribedTarget) {
        if (
          publication.source === sdk.Track.Source.ScreenShare ||
          publication.source === sdk.Track.Source.ScreenShareAudio
        ) {
          publication.setSubscribed(true);
        }
      }
      // 麦克风发布：自动订阅
      if (publication.source === sdk.Track.Source.Microphone) {
        publication.setSubscribed(true);
        diagnosticLog("sfu-voice", "remote-mic.published", { participantId: participant.identity });
      }
    });

    room.on(sdk.RoomEvent.TrackUnpublished, (publication, participant) => {
      // 麦克风取消发布
      if (publication.source === sdk.Track.Source.Microphone) {
        this.removeRemoteMic(participant.identity);
        diagnosticLog("sfu-voice", "remote-mic.unpublished", { participantId: participant.identity });
      }
    });

    room.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      // 屏幕共享流
      const subscription = this.subscription;
      if (
        subscription &&
        participant.identity === subscription.targetParticipantId &&
        (publication.source === sdk.Track.Source.ScreenShare ||
          publication.source === sdk.Track.Source.ScreenShareAudio)
      ) {
        if (!subscription.stream.getTracks().some((candidate) => candidate.id === track.mediaStreamTrack.id)) {
          subscription.stream.addTrack(track.mediaStreamTrack);
        }
        if (track.kind === sdk.Track.Kind.Video && !subscription.resolved) {
          if (subscription.timer) clearTimeout(subscription.timer);
          subscription.timer = undefined;
          subscription.resolved = true;
          subscription.resolve(subscription.stream);
        }
      }

      // 麦克风音轨：加入语音混合流
      if (publication.source === sdk.Track.Source.Microphone && track.kind === sdk.Track.Kind.Audio) {
        const voiceStream = this.getVoiceStream();
        if (!voiceStream.getTracks().some((t) => t.id === track.mediaStreamTrack.id)) {
          voiceStream.addTrack(track.mediaStreamTrack);
        }
        this.voiceCallbacks?.onRemoteMicStarted(participant.identity, track.mediaStreamTrack);
        diagnosticLog("sfu-voice", "remote-mic.subscribed", {
          participantId: participant.identity,
          trackId: track.mediaStreamTrack.id,
        });
      }
    });

    room.on(sdk.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      // 麦克风取消订阅：从语音混合流移除
      if (publication.source === sdk.Track.Source.Microphone) {
        const voiceStream = this.voiceStream;
        if (voiceStream) {
          try {
            voiceStream.removeTrack(track.mediaStreamTrack);
          } catch {
            // ignore
          }
        }
        this.voiceCallbacks?.onRemoteMicStopped(participant.identity);
        diagnosticLog("sfu-voice", "remote-mic.unsubscribed", {
          participantId: participant.identity,
        });
      }
    });

    room.on(sdk.RoomEvent.Disconnected, () => {
      if (this.voiceConnected) {
        this.voiceConnected = false;
        this.voiceCallbacks?.onVoiceDisconnected();
        diagnosticLog("sfu-voice", "disconnected");
      }
    });

    // 说话状态变化（如果 SDK 支持）
    const speakingEvent = (sdk.RoomEvent as Record<string, string>).ParticipantSpeakingChanged;
    if (speakingEvent) {
      (room as unknown as { on: (event: string, handler: (...args: unknown[]) => void) => void }).on(
        speakingEvent,
        (...args: unknown[]) => {
          const participant = args[0] as RemoteParticipant;
          const speaking = args[1] as boolean;
          if (participant.identity === room.localParticipant.identity) return;
          this.voiceCallbacks?.onRemoteSpeakingChanged(participant.identity, speaking);
          diagnosticLog("sfu-voice", "speaking-changed", {
            participantId: participant.identity,
            speaking,
          });
        },
      );
    }
  }

  private removeRemoteMic(participantId: string): void {
    // 这里我们没有按参与者记录音轨，直接通过回调通知上层
    // 实际的音轨移除会在 TrackUnsubscribed 事件中处理
    this.voiceCallbacks?.onRemoteMicStopped(participantId);
  }

  private subscribeParticipant(participant: RemoteParticipant): void {
    const sdk = this.sdk;
    if (!sdk) return;
    for (const publication of participant.trackPublications.values()) {
      if (
        publication.source === sdk.Track.Source.ScreenShare ||
        publication.source === sdk.Track.Source.ScreenShareAudio ||
        publication.source === sdk.Track.Source.Microphone
      ) {
        (publication as RemoteTrackPublication).setSubscribed(true);
      }
    }
  }

  private async loadSdk(): Promise<typeof import("livekit-client")> {
    if (this.sdk) return this.sdk;
    this.sdkPromise ??= import("livekit-client");
    this.sdk = await this.sdkPromise;
    return this.sdk;
  }
}
