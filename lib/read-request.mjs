// A sandbox relay may leave stdin nonblocking: consume it as a stream, not readFileSync(0).
export async function readRequest(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1024 * 1024) throw new Error("Confined request exceeds 1 MiB");
    chunks.push(data);
  }
  const input = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a request object");
  return input;
}
