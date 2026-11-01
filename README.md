# Audio Guard

A Scrypted plugin that listens to each camera's audio and turns it into the standard Scrypted **AudioSensor** (`audioDetected`). It turns on for a sound near the camera: a loud short one (a bang, a door, breaking glass) or a sustained one (voices, footsteps). The camera's own faint noise, silence and steady or slowly changing noise (wind, rain, insects, traffic hum) keep it off.

## What you get

- A sound sensor per camera, relative to the camera's own learned background, with absolute minimum levels that keep the camera's own noise out.
- It works everywhere Scrypted devices go: any AudioSensor consumer can read it, for example to show it as a sound sensor or to use it as an event trigger.
- It is cheap: one small audio-only ffmpeg per enabled camera. No video is decoded, and on Rebroadcast's RTSP stream the video is not even sent (see [CPU](#cpu)).
- It is honest about cameras without audio. A camera whose streams have no audio track shows "No audio" and is checked again later, less and less often. A camera that sends digital silence (audio gated or turned off) shows that on its Status line, but is still listened to.

## How it works

The plugin reads the camera's low-resolution stream (`destination: 'low-resolution'`), the one Rebroadcast usually keeps open (prebuffered), so it adds no connection to the camera. ffmpeg uses the input arguments Rebroadcast gives it, keeps only the first audio track (`-map 0:a:0`; often AAC at 16 kHz on the RTMP substream), and decodes it to 8 kHz mono 16-bit PCM.

When the input is RTSP (as Rebroadcast's is) and the stream reports an audio track, ffmpeg sets up only that track (`-allowed_media_types audio`), so Rebroadcast does not send the video at all. If the stream's audio is unknown, ffmpeg reads the whole stream and drops the video packets without decoding them. Then a stream with no audio track is still recognised as "no audio track".

If the low-resolution stream has no audio track, the plugin tries the `local` and then the `medium-resolution` destination, and then the camera's other streams that do not report "no audio". A stream that resolves to one already found without audio is skipped without starting ffmpeg. The stream that had audio is tried first next time. A stream that is not prebuffered makes Scrypted open an extra connection to the camera.

The plugin cuts the PCM into 100 ms windows and computes each window's RMS level in dBFS:

- **Noise floor:** the 20th percentile of the window levels over the last 5 minutes. Windows that are currently loud are left out, so a long sound does not raise the floor. The floor is learned in the first 10 s after a start; nothing is detected until then.
- **A sound** counts through one of two tiers:
  - **Loud sound (impulse):** a single window at **Loud sound above the background** (default +25 dB) over the floor or more, and at or above **Loud sound level** (default −30 dBFS). A bang, a door slam or breaking glass counts at once, however short.
  - **Sustained sound:** windows at **floor + Sensitivity** or more and at or above **Minimum level** (default −45 dBFS), for **Minimum duration** (default 1 s), at least 60 % of it loud. Pauses of up to 0.2 s (between words or steps) do not break it. Here a window counts only if both of its 50 ms halves are loud, so a click does not.
  - **Wind on the microphone:** a window whose level above 1 kHz is more than 14 dB below its whole level counts for neither tier. Wind buffeting an outdoor microphone puts nearly all its energy below 300 Hz, even when a gust is loud enough to clip, and a distant engine or horn sits at a few hundred hertz; breaking glass, a shout, a bark or a bang carry a good share of theirs above 1 kHz. The high band is cut with a steep filter (24 dB per octave), so a strong low tone does not leak into it.

  The camera's own noise (IR-cut clicks, codec glitches, electronics) is faint and short, so it passes neither tier. Measured on outdoor Reolink cameras at night, these defaults turn about 60 false sounds per hour on a quiet camera into none (see [Defaults](#defaults)).
- **Background check:** with three or more cameras listening, a new sound waits 1 s before it is published. It is background (a gust of wind, rain, a distant bang or fireworks) and is not published when at least 60 % of the other listening cameras, and at least two, had a sound from 1 s before its start (its first loud window) on, about as loud above their own floors (at most 6 dB quieter than on this camera). So the camera where a sound is clearly loudest is never suppressed: the others heard it fainter, and it happened near that camera. An ignored sound shows as "Background" on the Status line and the plugin page, and is not checked again while it goes on. The camera's console logs "background check: sound ignored", at most once a minute (the others are counted). With fewer than three cameras listening there is no check and no delay.
- **Hold:** the sensor stays on for **Hold** seconds after the last spike window, and at least Hold seconds from when it turned on (with the background check, that is 1 s after the sound started).
- **A louder background that stays:** if the background itself steps up (rain starts, a fan turns on), the loud windows would never enter the floor. From the first loud window, the plugin records every window, quiet gaps included, until 1 s of quiet ends the run. When the last 60 s of the run are steady (at most 6 dB between their 25th and 75th percentiles) and their median is below the Loud sound level, the floor is rebuilt from them, and the sensor goes off one Hold later. Speech, music or barking are not steady, and a loud steady sound (an idling engine, an alarm) is a sound, not background: neither becomes the floor.
- **Digital silence:** audio at or below −90 dBFS for 60 s shows "the audio is digital silence" on the Status line, and nothing else changes. Gated or noise-suppressed cameras send exact zeros in a quiet room, so ffmpeg keeps running and a sound is still detected. The note clears after about 2 s of audio at or above the Minimum level.
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

- **Status** (read-only): the state (Listening, Listening with the audio as digital silence, Learning the background, Sound detected, Background, Reconnecting, No audio, Disabled), the stream used when it is not the low-resolution one, the current level, the floor and the time of the last sound. It refreshes when the page is opened.
  Below it, the **Activity** chart shows the last 10 minutes, one point per second: the sound level (the loudest sustained level of the second's 100 ms windows, the value the detector compares, in dBFS), the noise floor (faint, dashed), the sustained-sound threshold (amber: floor plus Sensitivity, never below the Minimum level), the seconds with a window that counted as a sound (red bands, published or not), and a **Sensor on** lane: green while `audioDetected` was on, grey while a sound was ignored by the background check. The loud-sound threshold is not drawn, because it is compared with the whole window's level, not the sustained level of the line; a note under the legend gives its current value. The lines break where there was no audio (no audio track, ffmpeg down or restarting). The dBFS axis follows the data between −90 and 0. The history is kept in memory (about 13 KB per camera) and lost on a plugin restart.
- **Enabled** (on by default): off stops the camera's audio process; the sensor stays off.
- **Sensitivity (dB)** (default 15, 6 to 40): how far above the background a sustained sound must be. A lower value is more sensitive.
- **Minimum level (dBFS)** (default −45, −90 to 0): a sustained sound must also be at least this loud.
- **Minimum duration (s)** (default 1, 0.2 to 10): how long a sustained sound must last.
- **Loud sound above the background (dB)** (default 25, 6 to 60) and **Loud sound level (dBFS)** (default −30, −90 to 0): a short sound counts at once when it is at least this far above the background and at least this loud.
- **Hold (s)** (default 10, 1 to 600): how long the sensor stays on after the last loud sound, counted from when it turned on. With the background check, the sensor turns on 1 s after the sound started.

Values outside a range are clamped when they are saved.

The other values are fixed on purpose: windows of 100 ms, pauses of up to 0.2 s inside a sustained sound, the 20th percentile over 5 min, 10 s of learning, silence at −90 dBFS for 60 s, a steady background within 6 dB, the wind check (1 kHz, 14 dB), and the background check (at least 3 listening cameras; 60 % of the others, at least two, within 1 s and within 6 dB).

### Defaults

The defaults come from outdoor cameras on a quiet night, measured per 100 ms window (3 minutes on each of six cameras, so 12 minutes of quiet cameras and 6 of normal ones):

| | Quiet cameras (4) | Normal cameras (2) |
|---|---|---|
| Noise floor | −68 to −73 dBFS | −61 and −50 dBFS |
| Faint blips (camera self-noise, far sounds) | 50 to 80 per 3 min, mostly 0.1 to 0.3 s at −50 to −60 dBFS | |
| Loudest short sound on a quiet camera | −31 dBFS for 0.6 s (one) | |
| Real nearby sounds | −36 to −24 dBFS for 1 to 24 s | −23 to −28 dBFS bangs, −34 dBFS for 1 to 3 s |
| Sounds with the old rule (floor + 15 dB, −50 dBFS, 0.2 s) | 14 in 12 min (about 70 per hour, 12 of them false) | 4 in 6 min |
| Sounds with the defaults | 2 (both real, on one camera) | 3 (real) |

The −45 dBFS minimum level sits above the self-noise and 1 s is longer than any of its blips; a −30 dBFS loud level is just above the loudest short sound a quiet camera picked up from afar.

- **Wind and rain:** steady rain, or a wind that stays, is learned into the floor (a lasting step is rebuilt into the floor after 60 s steady). Its onset can count once. Gusts that swell over seconds rise less than 15 dB over the floor and rarely reach −45 dBFS, so they do not count. A gust strong enough to pass is usually heard by most cameras at once and is dropped by the background check. Strong gusts right on one microphone can still count: raise Minimum level or Sensitivity on that camera.

## Plugin page

The plugin's own settings page shows:

- **Overview:** one row per camera with its state (Listening, Silent, Learning, Sound, Background, Starting, Restarting, No audio, Disabled), the current level and floor while ffmpeg runs, how long ago the last sound was, and the published sounds and the restarts of the last hour.
- **Performance:** the ffmpeg processes running out of those wanted (cameras without audio are not counted), the audio windows per second against the expected 10 per running camera, the plugin process CPU (ffmpeg not included) and memory, and CPU and memory sparklines over the last hour (one sample per minute, in memory).

Both are computed when the page is opened.

## CPU

One ffmpeg per enabled camera, audio only, with a single thread. With the audio-only RTSP setup, Rebroadcast sends only the audio track. On one camera's substream (896x512 H.264 plus 16 kHz AAC), 10 s took 85 KB on the wire instead of 862 KB, about a tenth, with identical PCM out. Decoding AAC and resampling it to 8 kHz is small, and the per-window math in Node is O(samples): 8000 samples per second.

A 20 s capture of a camera's RTMP substream (640 px video, AAC audio) through Rebroadcast took 0.16 s of ffmpeg CPU (user plus system, start-up included) on an Apple-silicon Mac. That is about 0.8 % of one core, or about 0.5 % without start-up. On a small x86 server, expect about 1 % of a core per camera. Measure on your own host (for example with `top` on the ffmpeg processes) before enabling every camera. Memory is about 20 MB per ffmpeg.

## How others use it

Any AudioSensor consumer reads `audioDetected` through the standard AudioSensor interface: `true` while the sensor is on.

## Troubleshooting

- **"No audio (no audio track)":** the stream has no audio. Enable the microphone or audio recording on the camera or NVR. The plugin checks again as soon as the camera's settings or streams change, otherwise at the next scheduled check.
- **"Listening (the audio is digital silence)":** the stream carries only zeros. In a quiet room this is normal for cameras that gate or suppress noise, and sounds are still detected. If it never clears, audio is probably turned off in the camera or NVR settings.
- **"… on stream …" in the Status:** the low-resolution stream has no audio and another stream is used. Enabling audio on the substream lets the plugin use the prebuffered one.
- **Too many detections:** check the floor and level on the Status line and the Activity chart. For sustained sounds raise Minimum level or Sensitivity (for example to 20 dB) or Minimum duration; for short ones raise Loud sound level.
- **Missed sounds:** a short sound must reach Loud sound level (−30 dBFS) at the camera; a quieter one must last Minimum duration (1 s) above Minimum level (−45 dBFS). Lower these for a camera far from where things happen. A sound most cameras hear about as loud at once is treated as background by the background check (the console logs it).
- **"Reconnecting":** the camera console shows why ffmpeg ended (stream URLs are masked).

## Development

- `npm test`: compiles with `tsconfig.test.json` and runs the node:test suites. The Scrypted SDK is stubbed in `test/harness.ts`; the tests feed synthetic PCM and use a fake clock and a fake ffmpeg process. Two tests run the real ffmpeg on generated input and are skipped when it is not installed.
- `npm run build`: builds `out/plugin.zip`. `npx scrypted-deploy <host>` installs it.

## License

MIT
