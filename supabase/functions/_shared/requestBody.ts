// A small JSON request body (audit A6): the user-facing data functions take a ticker or a short
// list, so anything larger is refused before it is read into memory. Null for a body over the cap.
export async function smallJson(req: Request, maxBytes = 4096): Promise<unknown | null> {
  if (Number(req.headers.get("content-length")) > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let size = 0, text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    text += decoder.decode(value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode() || "{}"); } catch { return {}; }
}
