"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";

export default function Home() {
  const router = useRouter();
  const socket = useMemo(() => getSocket(), []);
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createTimeoutRef = useRef<number | null>(null);
  const createConnectHandlerRef = useRef<(() => void) | null>(null);

  const clearCreatePending = () => {
    if (createTimeoutRef.current) {
      window.clearTimeout(createTimeoutRef.current);
      createTimeoutRef.current = null;
    }

    if (createConnectHandlerRef.current) {
      socket.off("connect", createConnectHandlerRef.current);
      createConnectHandlerRef.current = null;
    }
  };

  useEffect(() => {
    function onCreated(payload: { code: string }) {
      clearCreatePending();
      setCreating(false);
      router.push(`/room/${payload.code}`);
    }

    function onRoomError(payload: { message: string }) {
      clearCreatePending();
      setCreating(false);
      setError(payload.message);
    }

    socket.on("room:created", onCreated);
    socket.on("room:error", onRoomError);

    function onConnectError(err: unknown) {
      const message = err instanceof Error ? err.message : "Unable to connect to server";
      clearCreatePending();
      setCreating(false);
      setError(message);
    }

    socket.on("connect_error", onConnectError);

    return () => {
      socket.off("room:created", onCreated);
      socket.off("room:error", onRoomError);
      socket.off("connect_error", onConnectError);
    };
  }, [router, socket]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-4 py-10">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="text-2xl font-semibold tracking-tight">Watch Party</div>
          <div className="mt-2 text-sm text-zinc-600">
            Two people watch the same local file with realtime sync (no streaming, no uploads).
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
              {error}
            </div>
          )}

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60"
              disabled={creating}
              onClick={() => {
                setError(null);
                setCreating(true);

                // Avoid getting stuck if the server isn't reachable.
                clearCreatePending();

                createTimeoutRef.current = window.setTimeout(() => {
                  clearCreatePending();
                  setCreating(false);
                  setError(
                    "Create room timed out. Make sure the Socket.IO server is running (default http://localhost:4000)."
                  );
                }, 8000);

                const emitCreate = () => {
                  socket.emit("room:create", (payload?: { code?: string }) => {
                    if (payload?.code) {
                      clearCreatePending();
                      setCreating(false);
                      router.push(`/room/${payload.code}`);
                      return;
                    }
                    // Fallback: server may emit room:created instead of ack.
                  });
                };

                if (!socket.connected) {
                  // Ensure we connect first; the emit will then succeed immediately.
                  socket.connect();
                  const onConnect = () => emitCreate();
                  createConnectHandlerRef.current = onConnect;
                  socket.on("connect", onConnect);
                  return;
                }

                emitCreate();
              }}
            >
              {creating ? "Creating…" : "Create room"}
            </button>

            <div className="flex gap-2">
              <input
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm outline-none focus:border-zinc-400"
                placeholder="Enter room code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              />
              <button
                className="shrink-0 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold hover:bg-zinc-50"
                onClick={() => {
                  const code = joinCode.trim().toUpperCase();
                  if (!code) return;
                  router.push(`/room/${code}`);
                }}
              >
                Join
              </button>
            </div>
          </div>

          <div className="mt-5 text-xs text-zinc-500">
            Tip: start the Socket.IO server on port 4000.
          </div>
        </div>
      </div>
    </div>
  );
}
