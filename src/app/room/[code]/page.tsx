"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";

type RoomInfo = {
  code: string;
  hostSocketId: string;
  usersCount: number;
};

type PlaybackActionType = "play" | "pause" | "seek";

type PlaybackState = {
  isPlaying: boolean;
  positionSeconds: number;
  playbackRate: number;
  seq: number;
  serverTimeMs: number;
  by?: string;
  action?: PlaybackActionType | "state" | "rate";
};

type SyncIndicatorPayload = {
  isSynced: boolean;
  worstAbsDriftSeconds: number;
  toleranceSeconds: number;
  serverTimeMs: number;
};

type CorrectionPayload = {
  code: string;
  targetTimeSeconds: number;
  isPlaying: boolean;
  playbackRate: number;
  seq: number;
  serverTimeMs: number;
  mode: "soft" | "hard";
  toleranceSeconds: number;
};

async function tryPlay(video: HTMLVideoElement) {
  try {
    await video.play();
    return true;
  } catch {
    return false;
  }
}

export default function RoomPage({ params }: { params: { code: string } }) {
  const router = useRouter();
  const code = params.code.trim().toUpperCase();

  const socket = useMemo(() => getSocket(), []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const applyingRemoteRef = useRef(false);
  const suppressEmitsUntilRef = useRef(0);
  const isUserSeekingRef = useRef(false);
  const pendingStateRef = useRef<PlaybackState | null>(null);
  const lastSeqAppliedRef = useRef<number>(-1);
  const blockedAutoplayStateRef = useRef<PlaybackState | null>(null);
  const basePlaybackRateRef = useRef(1);
  const correctionTimeoutRef = useRef<number | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [usersCount, setUsersCount] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [playbackRateUi, setPlaybackRateUi] = useState(1);
  const [syncIndicator, setSyncIndicator] = useState<SyncIndicatorPayload>({
    isSynced: false,
    worstAbsDriftSeconds: 999,
    toleranceSeconds: 0.25,
    serverTimeMs: Date.now(),
  });

  const isHost = !!selfId && !!hostId && selfId === hostId;

  const suppressLocalEmits = useCallback((ms: number) => {
    suppressEmitsUntilRef.current = Math.max(suppressEmitsUntilRef.current, Date.now() + ms);
  }, []);

  const shouldEmitUserEvent = useCallback((ev: Event) => {
    if (!ev.isTrusted) return false;
    if (applyingRemoteRef.current) return false;
    if (Date.now() < suppressEmitsUntilRef.current) return false;
    if (closed || !!error) return false;
    return true;
  }, [closed, error]);

  const computeTargetTimeSeconds = useCallback((state: PlaybackState) => {
    const nowMs = Date.now();
    const ageSeconds = Math.max(0, (nowMs - state.serverTimeMs) / 1000);
    return state.isPlaying ? state.positionSeconds + ageSeconds * state.playbackRate : state.positionSeconds;
  }, []);

  const clearCorrectionTimer = useCallback(() => {
    if (correctionTimeoutRef.current) {
      window.clearTimeout(correctionTimeoutRef.current);
      correctionTimeoutRef.current = null;
    }
  }, []);

  const applyPlaybackStateToVideo = useCallback(async (state: PlaybackState) => {
    const video = videoRef.current;
    if (!video) return;

    // Ignore older/out-of-order states.
    if (state.seq <= lastSeqAppliedRef.current) return;

    if (video.readyState < 1) {
      pendingStateRef.current = state;
      return;
    }

    // Don't fight the user while they're scrubbing.
    if (isUserSeekingRef.current) {
      pendingStateRef.current = state;
      return;
    }

    const targetTimeSeconds = computeTargetTimeSeconds(state);

    // Authoritative base playback rate.
    basePlaybackRateRef.current = state.playbackRate;
    setPlaybackRateUi(state.playbackRate);
    clearCorrectionTimer();
    // Apply base rate immediately (corrections apply separately).
    video.playbackRate = state.playbackRate;

    applyingRemoteRef.current = true;

    // Keep suppression long enough to cover delayed media events fired by play/pause/seek.
    suppressLocalEmits(900);
    try {
      // Drift correction.
      const diff = targetTimeSeconds - video.currentTime;
      const abs = Math.abs(diff);
      const threshold = state.isPlaying ? 0.5 : 0.12;

      if (abs > threshold) {
        try {
          video.currentTime = Math.max(0, targetTimeSeconds);
        } catch {}
      }

      if (state.isPlaying) {
        if (video.paused && !video.ended) {
          const ok = await tryPlay(video);
          if (!ok) {
            blockedAutoplayStateRef.current = state;
            setNeedsGesture(true);
          } else {
            blockedAutoplayStateRef.current = null;
            setNeedsGesture(false);
          }
        }
      } else {
        if (!video.paused) video.pause();
        blockedAutoplayStateRef.current = null;
        setNeedsGesture(false);
      }

      lastSeqAppliedRef.current = state.seq;
    } finally {
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 500);
    }
  }, [clearCorrectionTimer, computeTargetTimeSeconds, suppressLocalEmits]);

  const applyPendingIfPossible = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState < 1) return;

    if (isUserSeekingRef.current) return;

    if (pendingStateRef.current) {
      const state = pendingStateRef.current;
      pendingStateRef.current = null;
      void applyPlaybackStateToVideo(state);
    }
  }, [applyPlaybackStateToVideo]);

  useEffect(() => {
    setError(null);
    setClosed(false);

    function onConnect() {
      setSelfId(socket.id ?? null);
      socket.emit("room:join", { code });
      socket.emit("playback:request", { code }, (state: PlaybackState) => {
        void applyPlaybackStateToVideo(state);
      });
    }

    function onRoomInfo(info: RoomInfo) {
      setHostId(info.hostSocketId);
      setUsersCount(info.usersCount);
    }

    function onRoomError(payload: { message: string }) {
      setError(payload.message);
    }

    function onRoomClosed() {
      setClosed(true);
    }

    socket.on("connect", onConnect);
    socket.on("room:info", onRoomInfo);
    socket.on("room:error", onRoomError);
    socket.on("room:closed", onRoomClosed);
    socket.on("playback:state", (state: PlaybackState) => {
      void applyPlaybackStateToVideo(state);
    });

    socket.on("room:sync", (payload: SyncIndicatorPayload) => {
      setSyncIndicator(payload);
    });

    socket.on("playback:correct", async (payload: CorrectionPayload) => {
      if (payload.code.trim().toUpperCase() !== code) return;

      const video = videoRef.current;
      if (!video) return;

      // Treat correction as remote-controlled.
      applyingRemoteRef.current = true;
      suppressLocalEmits(900);

      // Always converge to authoritative base rate.
      basePlaybackRateRef.current = payload.playbackRate;
      setPlaybackRateUi(payload.playbackRate);

      const target = computeTargetTimeSeconds({
        isPlaying: payload.isPlaying,
        positionSeconds: payload.targetTimeSeconds,
        playbackRate: payload.playbackRate,
        seq: payload.seq,
        serverTimeMs: payload.serverTimeMs,
      });

      const diff = target - video.currentTime;
      const abs = Math.abs(diff);

      clearCorrectionTimer();

      if (payload.mode === "hard" || abs >= 2.0) {
        try {
          video.currentTime = Math.max(0, target);
        } catch {}
        video.playbackRate = payload.playbackRate;

        if (payload.isPlaying) {
          if (video.paused && !video.ended) {
            const ok = await tryPlay(video);
            if (!ok) {
              blockedAutoplayStateRef.current = {
                isPlaying: payload.isPlaying,
                positionSeconds: payload.targetTimeSeconds,
                playbackRate: payload.playbackRate,
                seq: payload.seq,
                serverTimeMs: payload.serverTimeMs,
              };
              setNeedsGesture(true);
            }
          }
        } else {
          if (!video.paused) video.pause();
        }
      } else {
        // Soft correction: nudge playbackRate temporarily to close drift smoothly.
        // For large-ish drifts, do a tiny partial seek to avoid long catch-up times.
        if (abs > 0.75) {
          const partial = Math.max(-0.5, Math.min(0.5, diff * 0.5));
          try {
            video.currentTime = Math.max(0, video.currentTime + partial);
          } catch {}
        }

        const base = payload.playbackRate;
        // Drift-based nudge, capped so it stays subtle.
        const nudge = Math.max(-0.35, Math.min(0.35, diff * 0.25));
        const nudged = Math.max(0.5, Math.min(2.0, base + nudge));
        video.playbackRate = nudged;

        correctionTimeoutRef.current = window.setTimeout(() => {
          const v = videoRef.current;
          if (!v) return;
          v.playbackRate = basePlaybackRateRef.current;
          applyingRemoteRef.current = false;
          correctionTimeoutRef.current = null;
        }, 1200);

        // Ensure play/pause matches.
        if (payload.isPlaying) {
          if (video.paused && !video.ended) {
            const ok = await tryPlay(video);
            if (!ok) {
              blockedAutoplayStateRef.current = {
                isPlaying: payload.isPlaying,
                positionSeconds: payload.targetTimeSeconds,
                playbackRate: payload.playbackRate,
                seq: payload.seq,
                serverTimeMs: payload.serverTimeMs,
              };
              setNeedsGesture(true);
            }
          }
        } else {
          if (!video.paused) video.pause();
        }
      }

      // Release remote suppression shortly after correction.
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 400);
    });

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("room:info", onRoomInfo);
      socket.off("room:error", onRoomError);
      socket.off("room:closed", onRoomClosed);
      socket.off("playback:state");
      socket.off("room:sync");
      socket.off("playback:correct");
    };
  }, [applyPlaybackStateToVideo, clearCorrectionTimer, code, computeTargetTimeSeconds, socket, suppressLocalEmits]);

  useEffect(() => {
    // Periodic drift correction from authoritative server state.
    const id = setInterval(() => {
      if (!socket.connected) return;
      const video = videoRef.current;
      if (!video) return;
      if (video.readyState < 1) return;
      if (isUserSeekingRef.current) return;

      socket.emit("playback:request", { code }, (state: PlaybackState) => {
        const target = computeTargetTimeSeconds(state);
        const diff = Math.abs(target - video.currentTime);
        if (diff > 1.0) void applyPlaybackStateToVideo(state);
      });
    }, 12000);

    return () => clearInterval(id);
  }, [applyPlaybackStateToVideo, code, computeTargetTimeSeconds, socket]);

  // Client report loop (enables server-side verification + sync indicator).
  useEffect(() => {
    const id = setInterval(() => {
      if (!socket.connected) return;
      const video = videoRef.current;
      if (!video) return;
      if (video.readyState < 1) return;

      socket.emit("playback:report", {
        code,
        timeSeconds: video.currentTime,
        isPlaying: !video.paused && !video.ended,
        playbackRate: video.playbackRate,
      });
    }, 500);

    return () => clearInterval(id);
  }, [code, socket]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      clearCorrectionTimer();
    };
  }, [clearCorrectionTimer, videoUrl]);

  // Attach native media event listeners; emit ONLY on direct user actions.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = (ev: Event) => {
      if (!shouldEmitUserEvent(ev)) return;
      pendingStateRef.current = null;
      socket.emit("playback:action", { code, type: "play", timeSeconds: video.currentTime });
    };

    const onPause = (ev: Event) => {
      if (!shouldEmitUserEvent(ev)) return;
      pendingStateRef.current = null;
      socket.emit("playback:action", { code, type: "pause", timeSeconds: video.currentTime });
    };

    const onSeeking = (ev: Event) => {
      if (!ev.isTrusted) return;
      isUserSeekingRef.current = true;
    };

    const onSeeked = (ev: Event) => {
      if (!ev.isTrusted) return;
      isUserSeekingRef.current = false;
      if (!shouldEmitUserEvent(ev)) {
        applyPendingIfPossible();
        return;
      }

      pendingStateRef.current = null;
      socket.emit("playback:action", { code, type: "seek", timeSeconds: video.currentTime });
      applyPendingIfPossible();
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [applyPendingIfPossible, code, shouldEmitUserEvent, socket]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div
        className="fixed right-4 top-4 z-50 h-3 w-3 rounded-full border border-white/60 shadow"
        style={{ backgroundColor: syncIndicator.isSynced ? "#22c55e" : "#ef4444" }}
        title={
          syncIndicator.isSynced
            ? "Synced"
            : `Desynced (worst drift ${syncIndicator.worstAbsDriftSeconds.toFixed(2)}s, tol ${syncIndicator.toleranceSeconds}s)`
        }
      />

      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="text-lg font-semibold">Room {code}</div>
              {isHost ? (
                <span className="rounded-full bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white">
                  Host
                </span>
              ) : (
                <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700">
                  Guest
                </span>
              )}
              <span className="text-sm text-zinc-600">Users: {usersCount}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(code);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  } catch {}
                }}
              >
                {copied ? "Copied" : "Copy code"}
              </button>
              <button
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50"
                onClick={() => router.push("/")}
              >
                Leave
              </button>
            </div>
          </div>

          {(error || closed) && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
              {closed ? "Room closed (host disconnected)." : `Error: ${error ?? "Unknown error"}`}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="relative rounded-2xl border border-zinc-200 bg-black/95">
              <video
                ref={videoRef}
                className="aspect-video w-full rounded-2xl"
                src={videoUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={() => applyPendingIfPossible()}
                onError={() => {
                  setFormatNote(
                    "This format may not be supported by your browser. Try MP4 (H.264/AAC) or WebM if playback fails."
                  );
                }}
              />

              {needsGesture && (
                <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-black/60 p-4">
                  <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-950/80 p-4 text-center text-white">
                    <div className="text-sm font-semibold">Playback needs one click</div>
                    <div className="mt-2 text-xs text-zinc-200">
                      Your browser blocked autoplay. Click below once to resume synced playback.
                    </div>
                    <button
                      className="mt-3 w-full rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-100"
                      onClick={async () => {
                        const video = videoRef.current;
                        const desired = blockedAutoplayStateRef.current;
                        if (!video || !desired) return;

                        // Perform the seek and play as part of the user gesture.
                        try {
                          video.currentTime = Math.max(0, computeTargetTimeSeconds(desired));
                        } catch {}

                        const ok = await tryPlay(video);
                        if (ok) {
                          blockedAutoplayStateRef.current = null;
                          setNeedsGesture(false);
                        }
                      }}
                    >
                      Start playback
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="text-sm font-semibold text-zinc-900">Local video</div>
              <div className="text-sm text-zinc-600">
                Both people must pick the same file from their own computer. The file is never uploaded.
              </div>

              <div className="mt-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-zinc-700">Playback speed</div>
                  <div className="text-xs font-semibold text-zinc-900">{playbackRateUi.toFixed(2)}x</div>
                </div>
                <input
                  className="mt-2 w-full"
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.25}
                  value={playbackRateUi}
                  onChange={(e) => {
                    const next = Math.min(2, Math.max(0.5, Number(e.target.value)));
                    setPlaybackRateUi(next);

                    const video = videoRef.current;
                    if (!video) return;

                    // Direct user action → apply locally and notify server.
                    basePlaybackRateRef.current = next;
                    video.playbackRate = next;
                    socket.emit("playback:action", { code, type: "rate", timeSeconds: next });
                  }}
                />
                <div className="mt-2 flex justify-between text-[10px] text-zinc-500">
                  <span>0.5x</span>
                  <span>1x</span>
                  <span>2x</span>
                </div>

                <button
                  className="mt-3 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold hover:bg-zinc-50"
                  onClick={() => {
                    const video = videoRef.current;
                    if (!video) return;
                    // Restart is a seek to 0; allow anyone.
                    try {
                      video.currentTime = 0;
                    } catch {}
                    socket.emit("playback:action", { code, type: "seek", timeSeconds: 0 });
                  }}
                >
                  Restart
                </button>
              </div>

              <label className="block">
                <span className="sr-only">Choose video</span>
                <input
                  type="file"
                  accept="video/*,audio/*,.mkv,.mp4,.webm,.mov,.m4v,.avi,.mp3,.m4a,.wav,.ogg"
                  className="block w-full cursor-pointer rounded-xl border border-zinc-200 bg-white p-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:bg-zinc-50"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;

                    setSelectedFileName(file.name);
                    setFormatNote(null);

                    if (videoUrl) URL.revokeObjectURL(videoUrl);
                    const url = URL.createObjectURL(file);
                    setVideoUrl(url);

                    const video = videoRef.current;
                    if (video) {
                      const mime = file.type;
                      if (mime) {
                        const can = video.canPlayType(mime);
                        if (!can) {
                          setFormatNote(
                            `Your browser may not support this media type (${mime}). If playback fails, try MP4 (H.264/AAC) or WebM.`
                          );
                        }
                      }
                    }

                    setTimeout(() => applyPendingIfPossible(), 0);
                  }}
                />
              </label>

              {selectedFileName && (
                <div className="text-xs text-zinc-600">Selected: {selectedFileName}</div>
              )}

              {formatNote && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-700">
                  {formatNote}
                </div>
              )}

              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                Everyone can control playback. Any play/pause/seek will sync to the whole room.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
