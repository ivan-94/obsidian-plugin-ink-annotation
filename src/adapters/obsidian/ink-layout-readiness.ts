/** Prevent startup font loading from being mistaken for a persistent Ink layout change. */
export async function waitForInkLayoutReadiness(document: Document): Promise<void> {
  const fonts = document.fonts;
  if (fonts === undefined) return;
  await fonts.ready;
}
