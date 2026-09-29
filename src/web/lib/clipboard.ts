/**
 * Copies text that is still being fetched from the server.
 *
 * MUST be called synchronously inside the tap/click handler (before any await), so the
 * browser still counts it as a user gesture:
 *  1. ClipboardItem with a Promise value: works on Android Chrome and iOS Safari even
 *     though the text arrives after the server round trip.
 *  2. writeText once the text arrives (desktop browsers that lack promise ClipboardItem).
 * Resolves false if both fail; the caller then shows the select-and-copy fallback.
 * Never rejects, even if `text` rejects (the caller handles the server error itself).
 */
export function copyWhenReady(text: Promise<string>): Promise<boolean> {
  text.catch(() => {}); // the caller observes the error; avoid an unhandled rejection here

  const viaItem = async (): Promise<boolean> => {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
    blob.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return true;
  };

  return viaItem()
    .catch(() => false)
    .then(async (ok) => {
      if (ok) return true;
      try {
        const value = await text;
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        return false;
      }
    });
}
