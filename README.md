# Audio Guard

A Scrypted plugin that listens to each camera's audio and turns it into the standard Scrypted **AudioSensor** (`audioDetected`). It turns on when a sound rises clearly above that camera's own background. Silence and steady noise (wind, a fan, traffic hum) keep it off.

## What you get

- A sound sensor per camera, learned from the camera's own background: there is no absolute threshold to tune per room.
- It works everywhere Scrypted devices go. The Scrypted MQTT bridge (and so Home Assistant) shows it as a `binary_sensor` with device class `sound`. Scrypted Stamina uses it as an event trigger.
- It is cheap: one small audio-only ffmpeg per enabled camera. No video is decoded, and on Rebroadcast's RTSP stream the video is not even sent (see [CPU](#cpu)).
- It is honest about cameras without audio. A camera whose streams have no audio track shows "No audio" and is checked again later, less and less often. A camera that sends digital silence (audio gated or turned off) shows that on its Status line, but is still listened to.

## How it works

The plugin reads the camera's low-resolution stream (`destination: 'low-resolution'`), the one Rebroadcast usually keeps open (prebuffered), so it adds no connection to the camera. ffmpeg uses the input arguments Rebroadcast gives it, keeps only the first audio track (`-map 0:a:0`; often AAC at 16 kHz on the RTMP substream), and decodes it to 8 kHz mono 16-bit PCM.

When the input is RTSP (as Rebroadcast's is) and the stream reports an audio track, ffmpeg sets up only that track (`-allowed_media_types audio`), so Rebroadcast does not send the video at all. If the stream's audio is unknown, ffmpeg reads the whole stream and drops the video packets without decoding them. Then a stream with no audio track is still recognised as "no audio track".

If the low-resolution stream has no audio track, the plugin tries the `local` and then the `medium-resolution` destination, and then the camera's other streams that do not report "no audio". A stream that resolves to one already found without audio is skipped without starting ffmpeg. The stream that had audio is tried first next time. A stream that is not prebuffered makes Scrypted open an extra connection to the camera.

The plugin cuts the PCM into 100 ms windows and computes each window's RMS level in dBFS:

- **Noise floor:** the 20th percentile of the window levels over the last 5 minutes. Windows that are currently loud are left out, so a long sound does not raise the floor. The floor is learned in the first 10 s after a start; nothing is detected until then.
- **Spike:** at least two consecutive windows (200 ms) at **floor + Sensitivity** or more, and at or above an absolute minimum of −50 dBFS. A near-silent room plus a little noise therefore never triggers. A window counts only if both of its 50 ms halves are loud, so a click or a short tap, even one on a window boundary, is not a spike.
- **Hold:** the sensor stays on for **Hold** seconds after the last spike window.
- **A louder background that stays:** if the background itself steps up (rain starts, a fan turns on), the loud windows would never enter the floor. From the first loud window, the plugin records every window, quiet gaps included, until 1 s of quiet ends the run. When the last 60 s of the run are steady (at most 6 dB between their 25th and 75th percentiles), the floor is rebuilt from them, and the sensor goes off one Hold later. Speech, music or barking are not steady and never become the floor.
- **Digital silence:** audio at or below −90 dBFS for 60 s shows "the audio is digital silence" on the Status line, and nothing else changes. Gated or noise-suppressed cameras send exact zeros in a quiet room, so ffmpeg keeps running and a sound is still detected. The note clears after about 2 s of audio at or above −50 dBFS.
- **No audio track:** if no stream has an audio track, the camera is marked "No audio". Its ffmpeg stops and the plugin checks again after 5 min, then 10, 20 and 40 min, and every hour after that. Each camera has its own fixed ±20 % factor on these delays. The first audio received clears "No audio". When the camera's settings or streams change (Rebroadcast, the camera plugin), a camera marked "No audio" is checked again within 2 s, its backoff starts over, and the stream search starts again from the low-resolution stream.
- **Resilience:** if ffmpeg ends or fails to start, it restarts after 1 s, doubling the wait up to 60 s, each delay jittered by ±20 %. After a run of 60 s or more, the next failure starts again from 1 s. A stream that delivers no audio for 30 s is killed and restarted. A process that ends while the sensor is on turns it off, and so does disabling or removing the extension.
- **Spread starts:** each camera's first start waits a random 0 to 3 s, so loading the plugin does not start every ffmpeg at the same moment.

## Requirements

- Scrypted with a camera that has video and an audio track (the camera's microphone and audio recording enabled).
- The Rebroadcast plugin, preferably prebuffering the camera's low-resolution stream. Without that, Scrypted opens the stream on demand.
- ffmpeg available to Scrypted (it ships with Scrypted).

## Install and enable

1. Build and deploy: `npm install && npm run build`, then `npx scrypted-deploy <host>`.
2. Open a camera, go to Extensions, and enable Audio Guard. Nothing is enabled automatically, and ffmpeg runs only for cameras where the extension is enabled and its Enabled setting is on.
3. Wait about 10 s for the Status line to show "Listening".

## Settings (per camera)

- **Status** (read-only): the state (Listening, Listening with the audio as digital silence, Learning the background, Sound detected, Reconnecting, No audio, Disabled), the stream used when it is not the low-resolution one, the current level, the floor and the time of the last sound. It refreshes when the page is opened.
- **Enabled** (on by default): off stops the camera's audio process; the sensor stays off.
- **Sensitivity (dB)** (default 15, 6 to 40): how far above the background a sound must be. A lower value is more sensitive.
- **Hold (s)** (default 10, 1 to 600): how long the sensor stays on after the last loud sound.

The other values are fixed on purpose: windows of 100 ms, at least 2 windows, an absolute minimum of −50 dBFS, the 20th percentile over 5 min, 10 s of learning, silence at −90 dBFS for 60 s, a steady background within 6 dB.

## CPU

One ffmpeg per enabled camera, audio only, with a single thread. With the audio-only RTSP setup, Rebroadcast sends only the audio track. On one camera's substream (896x512 H.264 plus 16 kHz AAC), 10 s took 85 KB on the wire instead of 862 KB, about a tenth, with identical PCM out. Decoding AAC and resampling it to 8 kHz is small, and the per-window math in Node is O(samples): 8000 samples per second.

A 20 s capture of a camera's RTMP substream (640 px video, AAC audio) through Rebroadcast took 0.16 s of ffmpeg CPU (user plus system, start-up included) on an Apple-silicon Mac. That is about 0.8 % of one core, or about 0.5 % without start-up. On a small x86 server, expect about 1 % of a core per camera. Measure on your own host (for example with `top` on the ffmpeg processes) before enabling every camera. Memory is about 20 MB per ffmpeg.

## How others use it

- **Scrypted MQTT bridge / Home Assistant:** the AudioSensor appears as a sound `binary_sensor` on the camera's device (`on` while `audioDetected` is true).
- **Scrypted Stamina:** reads `audioDetected` through the standard AudioSensor interface. By default it is an event trigger. Any other plugin that implements AudioSensor works the same way.

## Troubleshooting

- **"No audio (no audio track)":** the stream has no audio. Enable the microphone or audio recording on the camera or NVR. The plugin checks again as soon as the camera's settings or streams change, otherwise at the next scheduled check.
- **"Listening (the audio is digital silence)":** the stream carries only zeros. In a quiet room this is normal for cameras that gate or suppress noise, and sounds are still detected. If it never clears, audio is probably turned off in the camera or NVR settings.
- **"… on stream …" in the Status:** the low-resolution stream has no audio and another stream is used. Enabling audio on the substream lets the plugin use the prebuffered one.
- **Too many detections:** raise Sensitivity (for example to 20 dB). Check the floor and level on the Status line.
- **Missed sounds:** lower Sensitivity. A sound must also be louder than −50 dBFS at the camera, and last at least 200 to 300 ms.
- **"Reconnecting":** the camera console shows why ffmpeg ended (stream URLs are masked).

## Development

- `npm test`: compiles with `tsconfig.test.json` and runs the node:test suites. The Scrypted SDK is stubbed in `test/harness.ts`; the tests feed synthetic PCM and use a fake clock and a fake ffmpeg process. Two tests run the real ffmpeg on generated input and are skipped when it is not installed.
- `npm run build`: builds `out/plugin.zip`. `npx scrypted-deploy <host>` installs it.

## License

MIT
