// Server-sent events, read as they arrive (the copilot's answers, T4.04): `feed` takes text in any
// pieces the network gives it; each complete event (an `event:` name and its `data:` lines, ended
// by a blank line) reaches `onEvent` with its data parsed as JSON.

export interface SseEvent {
  event: string;
  data: unknown;
}

export function sseParser(onEvent: (e: SseEvent) => void): { feed(chunk: string): void; end(): void } {
  let buffer = '';
  let pending = ''; // a trailing "\r" waits: its "\n" may come in the next piece
  const emit = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    let parsed: unknown = data.join('\n');
    try {
      parsed = JSON.parse(parsed as string);
    } catch {
      // not JSON: the text as it is
    }
    onEvent({ event, data: parsed });
  };
  return {
    feed(chunk) {
      const raw = pending + chunk;
      const cut = raw.endsWith('\r') ? raw.length - 1 : raw.length;
      pending = raw.slice(cut);
      buffer += raw.slice(0, cut).replace(/\r\n?/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        emit(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    },
    end() {
      buffer += pending.replace(/\r/g, '\n');
      pending = '';
      if (buffer.trim()) emit(buffer);
      buffer = '';
    },
  };
}
