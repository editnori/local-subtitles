# Local Subtitles visual system

The Rounds extension supplies the visual reference for the popup: a dark bezel around one soft canvas, filled surfaces instead of borders between components, 16 px sheets, 12 px fields, full-round controls, sentence-case labels, compact type, and color that names a state.

One status card owns the whole session. Its signal circle takes the tone of the current phase, its heading carries the state message, and its detail line explains what happens next, so the popup needs no separate state chip, fact strip, or footer restating the same information. Blue marks the idle signal, the primary Start action, and selected appearance controls. Green appears only while transcription is live. Amber means the model is opening or downloading. Coral appears only for Stop and errors. The popup has no gradients, decorative badges, fake activity, or nested cards that do not own a separate state.

The Speech model card owns the one non-appearance setting. Its segmented control picks Tiny, Small, or Medium, its hint line states the one-time download size and the device class the choice fits, and the header meta line names the chosen model.

The body keeps its 390 px design width but centers inside wider viewports and stretches the canvas to the full sheet height, because a mobile browser can open the popup as a full-screen sheet rather than an anchored bubble; the dark bezel then reads as an even frame instead of bare background.

Paired icons such as play and stop or moon and sun swap through CSS classes because SVG elements ignore the HTML hidden attribute; relying on it renders both glyphs at once.

The subtitle itself stays independent of the popup theme because it must remain readable over arbitrary video. It uses white text, a user-controlled near-black backing, balanced wrapping, safe-area spacing, and a restrained blur. The block rolls up like broadcast captions: the finished line stays visible above the line still forming, the forming words use reduced opacity until Moonshine commits them, and the block clips from the top at three visual lines so the newest words are always fully shown. The on-video status pill appears only when the phase or message changes, hides shortly after subtitles go live, and stays hidden while captions are flowing; the engine does not resend an unchanged status just because another inference pass finished.

The 350 px breakpoint keeps the same controls and behavior while reducing padding. Every primary touch target is at least 42 px high, the popup fits a narrow extension sheet, and the video overlay uses viewport and safe-area units for mobile playback.

The inference runtime follows the same mobile constraint. One WebAssembly SIMD engine runs inside Moonshine's dedicated speech worker, so native inference never blocks the popup and does not preallocate a pthread pool. The AudioWorklet remains independent and continues handing off captured mono audio while the model is decoding.
