# Watch Party (Local File Sync)

Two people watch the same **local** video file together with realtime playback sync.

- The video file is selected via `<input type="file">` and is **never uploaded**.
- The **host** controls play/pause/seek.
- The guest mirrors actions immediately.
- Every 5 seconds, the host emits `{ currentTime, isPlaying }` and the guest drift-corrects if the difference is `> 0.5s`.

## Tech

- Next.js 14 (App Router) + TypeScript + Tailwind CSS
- Express + Socket.IO realtime server in `server/`

## Setup

### 1) Install dependencies

From the repo root:

```bash
npm install
```

From `server/`:

```bash
cd server
npm install
```

### 2) (Optional) Configure Socket server URL

By default the client connects to `http://localhost:4000`.

You can also create `.env.local` from `.env.local.example`:

```bash
copy .env.local.example .env.local
```

## Run (Dev)

### Terminal 1: Socket server

```bash
cd server
npm run dev
```

The server listens on `http://localhost:4000`.

### Terminal 2: Next.js app

```bash
npm run dev
```

Open `http://localhost:3000`.

## How to use

1. User A clicks **Create room** (becomes host).
2. User B enters the room code and clicks **Join**.
3. Both users pick the same local video file.
4. Host uses the video controls; guest stays synced.

## Notes

- “Perfect sync” here means best-effort sync for local playback with realtime events + periodic drift correction; exact frame-perfect sync depends on browser decode timing and hardware.
