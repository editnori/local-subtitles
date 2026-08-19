# Privacy

Local Subtitles processes captured tab audio on the user's device. It does not transmit audio, generated subtitles, page content, browsing history, identifiers, or usage events to an application server.

The extension makes one type of external request: it downloads the English Moonshine Tiny Streaming model from `download.moonshine.ai` when the model is not already present in browser Cache Storage. Those requests contain ordinary network metadata such as the user's IP address and browser request headers, but they do not contain captured audio or transcript text.

The extension stores subtitle appearance settings and current runtime status with Chrome storage. Moonshine model files use the browser's Cache Storage. Stopping subtitles closes the audio track and offscreen document; removing the extension removes its extension-owned storage according to the browser's normal removal behavior.
