"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

type SyncStatus = {
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
  const pendingActionRef = useRef<SyncAction | null>(null);
  const pendingStatusRef = useRef<SyncStatus | null>(null);

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

  function applyPendingIfPossible() {
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState < 1) return;

    if (pendingActionRef.current) {
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      void handleRemoteAction(action);
    }

    if (pendingStatusRef.current) {
      const status = pendingStatusRef.current;
      pendingStatusRef.current = null;
      handleRemoteStatus(status);
    }
  }

  async function handleRemoteAction({ action, time }: SyncAction) {
    const video = videoRef.current;
    if (!video) return;

    if (video.readyState < 1) {
      pendingActionRef.current = { action, time };
      return;
    }

    applyingRemoteRef.current = true;
    try {
      try {
        video.currentTime = time;
      } catch {
        // ignore
      }

      if (action === "play") {
        await safePlay(video);
      } else if (action === "pause") {
        video.pause();
      }
    } finally {
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 0);
    }
  }

  function handleRemoteStatus({ currentTime, isPlaying }: SyncStatus) {
    const video = videoRef.current;
    if (!video) return;

    if (video.readyState < 1) {
      pendingStatusRef.current = { currentTime, isPlaying };
      return;
    }

    applyingRemoteRef.current = true;
    try {
      const diff = Math.abs(video.currentTime - currentTime);
      if (diff > 0.5) {
        try {
          video.currentTime = currentTime;
        } catch {
          // ignore
        }
      }

      if (isPlaying) {
        void safePlay(video);
      } else {
        video.pause();
      }
    } finally {
      setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 0);
    }
  }

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
    socket.on("sync:status", handleRemoteStatus);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("room:info", onRoomInfo);
      socket.off("room:error", onRoomError);
      socket.off("room:closed", onRoomClosed);
      socket.off("sync:action", handleRemoteAction);
      socket.off("sync:status", handleRemoteStatus);
    };
  }, [code, socket]);

  useEffect(() => {
    if (!isHost) return;

    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (!socket.connected) return;

      socket.emit("sync:status", {
        code,
        currentTime: video.currentTime,
        isPlaying: !video.paused && !video.ended,
      });
    }, 5000);

    return () => clearInterval(id);
  }, [code, isHost, socket]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const canControl = isHost && !closed && !error;

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
                  } catch {
                    // ignore
                  }
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
              {closed
                ? "Room closed (host disconnected)."
                : `Error: ${error ?? "Unknown error"}`}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="rounded-2xl border border-zinc-200 bg-black/95">
              <video
                ref={videoRef}
                className="aspect-video w-full rounded-2xl"
                src={videoUrl ?? undefined}
                controls={isHost}
                onLoadedMetadata={() => applyPendingIfPossible()}
                onError={() => {
                  setFormatNote(
                    "This format may not be supported by your browser. Try MP4 (H.264/AAC) or WebM if playback fails."
                  );
                }}
                onPlay={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (!canControl) return;
                  if (applyingRemoteRef.current) return;

                  socket.emit("sync:action", { code, action: "play", time: video.currentTime });
                }}
                onPause={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (!canControl) return;
                  if (applyingRemoteRef.current) return;

                  socket.emit("sync:action", { code, action: "pause", time: video.currentTime });
                }}
                onSeeked={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (!canControl) return;
                  if (applyingRemoteRef.current) return;

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
                  // Note: this only affects what files can be selected.
                  // Actual playback depends on browser codec support.
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
                      // file.type can be empty for some files (e.g., .mkv on Windows).
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

                    // Best-effort: apply any pending sync once metadata is available.
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

              {!isHost && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                  Only the host can control playback. Your player will mirror host play/pause/seek.
                </div>
              )}

              {isHost && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                  You control playback. Guests sync instantly + drift-correct every 5 seconds.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
