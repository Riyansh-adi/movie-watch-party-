"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSocket } from "@/lib/socket";

export default function Home() {
  const router = useRouter();
  const socket = useMemo(() => getSocket(), []);
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onCreated(payload: { code: string }) {
      setCreating(false);
      router.push(`/room/${payload.code}`);
    }

    function onRoomError(payload: { message: string }) {
      setCreating(false);
      setError(payload.message);
    }

    socket.on("room:created", onCreated);
    socket.on("room:error", onRoomError);

    return () => {
      socket.off("room:created", onCreated);
      socket.off("room:error", onRoomError);
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
                socket.emit("room:create");
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
