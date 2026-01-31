"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";

type RoomInfo = {
  code: string;
  hostSocketId: string;
  usersCount: number;
};

type SyncAction = {
  action: "play" | "pause" | "seek";
  time: number;
};

type SyncState = {
  currentTime: number;
  isPlaying: boolean;
};

async function safePlay(video: HTMLVideoElement) {
  try {
    await video.play();
  } catch {
    // Autoplay can be blocked; ignore.
  }
}

export default function RoomPage({ params }: { params: { code: string } }) {
  const router = useRouter();
  const code = params.code.trim().toUpperCase();

  const socket = useMemo(() => getSocket(), []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const applyingRemoteRef = useRef(false);
  const suppressEmitsUntilRef = useRef<number>(0);
  const pendingActionRef = useRef<SyncAction | null>(null);
  const pendingStateRef = useRef<SyncState | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [usersCount, setUsersCount] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [copied, setCopied] = useState(false);

  const isHost = !!selfId && !!hostId && selfId === hostId;

  const suppressLocalEmits = useCallback((ms: number) => {
    const until = Date.now() + ms;
    suppressEmitsUntilRef.current = Math.max(suppressEmitsUntilRef.current, until);
  }, []);

  const shouldSuppressLocalEmit = useCallback(() => {
    return applyingRemoteRef.current || Date.now() < suppressEmitsUntilRef.current;
  }, []);

  const handleRemoteAction = useCallback(async ({ action, time }: SyncAction) => {
    const video = videoRef.current;
    if (!video) return;

    if (video.readyState < 1) {
      pendingActionRef.current = { action, time };
      return;
    }

    applyingRemoteRef.current = true;
    // Keep suppression long enough to cover delayed media events triggered by play()/pause()/seek.
    suppressLocalEmits(800);
    try {
      try {
        video.currentTime = time;
      } catch {}

      if (action === "play") {
        if (video.paused && !video.ended) {
          await safePlay(video);
        }
      } else if (action === "pause") {
        if (!video.paused) video.pause();
      }
    } finally {
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 500);
    }
  }, [suppressLocalEmits]);

  const handleRemoteState = useCallback(({ currentTime, isPlaying }: SyncState) => {
    const video = videoRef.current;
    if (!video) return;

    if (video.readyState < 1) {
      pendingStateRef.current = { currentTime, isPlaying };
      return;
    }

    applyingRemoteRef.current = true;
    suppressLocalEmits(800);
    try {
      const diff = Math.abs(video.currentTime - currentTime);
      if (diff > 0.5) {
        try {
          video.currentTime = currentTime;
        } catch {}
      }

      if (isPlaying) {
        if (video.paused && !video.ended) void safePlay(video);
      } else {
        if (!video.paused) video.pause();
      }
    } finally {
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 500);
    }
  }, [suppressLocalEmits]);

  const applyPendingIfPossible = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState < 1) return;

    if (pendingActionRef.current) {
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      void handleRemoteAction(action);
    }

    if (pendingStateRef.current) {
      const state = pendingStateRef.current;
      pendingStateRef.current = null;
      handleRemoteState(state);
    }
  }, [handleRemoteAction, handleRemoteState]);

  useEffect(() => {
    setError(null);
    setClosed(false);

    function onConnect() {
      setSelfId(socket.id ?? null);
      socket.emit("room:join", { code });
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
    socket.on("sync:action", handleRemoteAction);
    socket.on("sync:state", handleRemoteState);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("room:info", onRoomInfo);
      socket.off("room:error", onRoomError);
      socket.off("room:closed", onRoomClosed);
      socket.off("sync:action", handleRemoteAction);
      socket.off("sync:state", handleRemoteState);
    };
  }, [code, handleRemoteAction, handleRemoteState, socket]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!socket.connected) return;

      socket.emit("sync:request", { code }, (state: SyncState) => {
        handleRemoteState(state);
      });
    }, 5000);

    return () => clearInterval(id);
  }, [code, handleRemoteState, socket]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const canControl = !closed && !error;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
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
            <div className="rounded-2xl border border-zinc-200 bg-black/95">
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
                onPlay={(e) => {
                  const video = videoRef.current;
                  if (!video) return;

                  if (!canControl) return;

                  const isTrusted = (e.nativeEvent as Event | undefined)?.isTrusted === true;
                  // Always honor real user intent, even if we are in a short remote-apply window.
                  if (!isTrusted && shouldSuppressLocalEmit()) return;
                  socket.emit("sync:action", { code, action: "play", time: video.currentTime });
                }}
                onPause={(e) => {
                  const video = videoRef.current;
                  if (!video) return;

                  if (!canControl) return;

                  const isTrusted = (e.nativeEvent as Event | undefined)?.isTrusted === true;
                  if (!isTrusted && shouldSuppressLocalEmit()) return;
                  socket.emit("sync:action", { code, action: "pause", time: video.currentTime });
                }}
                onSeeked={(e) => {
                  const video = videoRef.current;
                  if (!video) return;

                  if (!canControl) return;

                  const isTrusted = (e.nativeEvent as Event | undefined)?.isTrusted === true;
                  if (!isTrusted && shouldSuppressLocalEmit()) return;
                  socket.emit("sync:action", { code, action: "seek", time: video.currentTime });
                }}
              />
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4">
              <div className="text-sm font-semibold text-zinc-900">Local video</div>
              <div className="text-sm text-zinc-600">
                Both people must pick the same file from their own computer. The file is never uploaded.
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
