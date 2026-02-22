# mnusic-visualizer

A **Progressive Web App** that captures microphone input and renders a real-time **graphic equalizer** display using the Web Audio API and HTML5 Canvas.

## Features

- 🎙️ Live microphone input via `getUserMedia`
- 📊 Frequency-band bar graph (logarithmic scale, 16 / 32 / 64 / 128 bands)
- 📈 Peak-hold markers with smooth decay
- 〰️ Optional line-graph overlay
- 🔊 Adjustable input gain
- 📱 Installable PWA – works offline after first load
- ♿ Accessible status announcements

## Running locally

Serve the project root with any static HTTP server, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080` (or the port your server uses), click **Start**, and allow microphone access.

> **Note:** Microphone access requires a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (`https://` or `localhost`).

## Project structure

```
index.html      – App shell
styles.css      – Dark-theme styles
app.js          – Web Audio API visualizer logic
manifest.json   – PWA manifest
sw.js           – Service worker (offline cache)
icons/          – PWA icons (192 × 192 and 512 × 512)
```