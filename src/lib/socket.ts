import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  const url = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";
  socket = io(url, {
    // Allow fallback to HTTP long-polling when websockets are blocked.
    transports: ["websocket", "polling"],
    autoConnect: true,
    timeout: 8000,
    reconnectionAttempts: 10,
  });

  return socket;
}
