# SoundKami

A clean, customisable Discord soundboard for Windows. Click a button or press a hotkey and everyone in your voice channel hears the sound — mixed with your mic, plus any music you choose to share.

## Features

- **Boards** — organise sounds into as many boards as you like; drag sounds between them.
- **Unlimited sounds** — drag files in from Explorer (MP3, WAV, OGG, FLAC, M4A, …) or add a whole folder. SoundKami keeps its own copy, so moving the originals never breaks a button.
- **Per-sound customisation** — name, emoji, colour, volume (0–200%), waveform trimming, loop, and what happens when you press it again (restart, stop, or layer).
- **Global hotkeys** — work while you're in a game. Numpad and F13–F24 keys work on their own; other keys need Ctrl/Alt/Shift.
- **Mic passthrough** — your voice goes through SoundKami, with optional mic ducking while sounds play.
- **Shared audio** — stream music from Spotify, a browser, VLC or any other app straight into the call. It captures only the apps you pick (Windows 10 2004+), so Discord's own audio is never echoed back.
- **You-hear monitor** — hear your sounds on your headphones at a separate volume, and preview sounds privately.
- **Stop all** button and hotkey, Esc to stop everything.
- **Appearance** — dark, light or match Windows; seven accent colours or your own; compact, comfortable or large buttons.
- **Tray app** — closing the window keeps hotkeys and shared audio running; optional launch at startup.
- **Share boards** — export a board (sounds included) as a `.skboard` file and import a friend's.
- **Portable mode** — create a `data` folder next to `SoundKami.exe` and everything is stored there.

## How it works

Discord can only listen to one microphone, so SoundKami builds the mix itself and hands it to Discord through a virtual audio cable:

```
Your mic ─┐
Sounds ───┼──► SoundKami mix ──► CABLE Input ══► CABLE Output ──► Discord (as your mic)
Music  ───┘
Sounds ──────► Your headphones (so you hear them too)
```

## Setup

1. **Install VB-CABLE** (free): https://vb-audio.com/Cable/ — unzip, right-click `VBCABLE_Setup_x64.exe` → *Run as administrator* → *Install Driver*, then restart your PC.
2. **Run SoundKami.** The first-run setup finds the cable and asks for your mic and headphones.
3. **In Discord → User Settings → Voice & Video:**
   - Input Device: **CABLE Output (VB-Audio Virtual Cable)**
   - Turn off **Noise Suppression** and **Echo Cancellation** (they filter out music and effects)
   - Use **Voice Activity**, or hold push-to-talk while playing sounds.

Don't set *CABLE Input* as your Windows default speaker, and don't choose *CABLE Output* as SoundKami's microphone — either creates an echo loop.

## Sharing music

Start playing music in any app, then click **+** next to *Shared audio* in the sidebar and switch the app on. Its audio is mixed into what Discord hears; the *Shared audio* slider sets the level. If you close and reopen the app, SoundKami reconnects automatically.

## Building from source

Requirements: Node.js 20+, and a MinGW-w64 g++ (on Windows via MSYS2, on Linux `g++-mingw-w64-x86-64-posix`).

```bash
npm install
npm run build:native   # builds native/sk-capture.exe (the app-audio capture helper)
npm start              # run in development
npm run package        # → dist/SoundKami-win32-x64 and a portable zip
npx electron-builder --win nsis --x64 --prepackaged dist/SoundKami-win32-x64   # → installer
```

Pushing a tag like `v1.0.0` to GitHub runs `.github/workflows/release.yml`, which builds the installer and portable zip on Windows and attaches them to a GitHub release.

## Project layout

```
src/main.js              Electron main process: window, tray, hotkeys, library, capture helper
src/preload.js           The safe bridge between the UI and the main process
src/renderer/app.js      The interface
src/renderer/audio.js    Audio engine (Web Audio): mic + sounds + shared audio → cable, monitor
src/renderer/pcm-worklet.js  Jitter buffer/resampler for shared app audio
native/sk-capture.cpp    Windows helper: lists audio apps, captures one app via process loopback
assets/                  App and tray icons
scripts/package.js       Cross-platform packager (sets exe icon + version info)
```

Settings and sounds live in `%APPDATA%\SoundKami` (`config.json` and the `sounds` folder).

## Troubleshooting

- **Friends can't hear anything** — check Discord's input is *CABLE Output*, and that the status in the bottom bar says *Live to Discord*. Use *Settings → Audio routing → Test* to send a beep.
- **A hotkey doesn't work** — its badge is crossed out when another app already owns that key. Pick a different one.
- **Music sounds choppy or quiet in Discord** — turn off Discord's Noise Suppression (Krisp) and Echo Cancellation.
- **An app isn't in the Shared audio list** — it only appears once it has played sound since it opened. Start playback, then press *Refresh*.
