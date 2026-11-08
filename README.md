# USB Music Drop — direct relay

The sender opens the Render website. A small receiver script on this Windows PC continuously pulls from Render and writes each live transfer directly to the plugged-in USB.

```text
sender browser -> Render relay -> receiver.js on this PC -> USB drive
```

Render does not store the songs. The sender must keep the upload page open until each file says **on USB**. If this PC, the receiver, or the USB is unavailable, the sender page waits and retries automatically.

## What is preserved

- Original Unicode filenames and uploaded folder layout
- Every file byte, including embedded title, artist, album and artwork tags
- Existing files are never overwritten; a collision becomes `Song (2).mp3`
- SHA-256 is calculated at both ends and must match before the website reports success

## Deploy on Render

1. Put this folder in a Git repository. If it is inside a larger repository, select `render-usb-music-drop/render.yaml` as the Blueprint file.
2. Create a Render Blueprint from that repository. No disk or database is needed; the included configuration uses the free web-service plan.
3. Share the Render website URL with the sender. No environment variables, key, disk or database are required.

## Connect this PC to Render

Node.js 20 or newer is required.

1. Keep the removable USB plugged in.
2. Double-click `configure-usb-receiver.cmd` once and paste the Render website URL.
3. Double-click `start-usb-receiver.cmd`.
4. Keep that receiver window open while the sender is transferring music.

The script makes outbound HTTPS requests, so Render does not need your home IP and no router port forwarding is needed. It automatically selects the first Windows removable drive and creates `Incoming Music` on it.

To force a particular destination, edit `.receiver-config.json` and set `usbPath`, for example `E:\\`. The local config is excluded from Git.

## Sender workflow

The sender opens the website, chooses files/folders, and leaves the page open. Fast mode streams up to four files in parallel and the application does not impose a file-count or per-file-size cap. Supported formats: MP3, M4A, AAC, WAV, FLAC, OGG, OPUS, WMA, AIFF, ALAC, ZIP, RAR and 7Z.

## Local verification

```powershell
npm start
```

Open `http://localhost:3000`. Run `npm test` for the direct-relay integration test and `npm run check` for syntax checks.

## Reliability note

Because the service intentionally stores nothing, a broken connection restarts the current file from the sender. Completed USB files remain safe, and filename collision protection prevents overwriting them.
