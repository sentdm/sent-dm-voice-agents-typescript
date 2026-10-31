// The binary audio frame of an audio session: a 2-byte big-endian stream number, then 16-bit little-endian
// mono PCM at the session's sample rate, a whole number of samples. The header keeps the samples aligned, so a
// reader can view them as 16-bit integers without copying.

export const HEADER_BYTES = 2;

/** The stream a frame belongs to: the session whose stream it is, on this connection. */
export const streamOf = (frame: Buffer): number => frame.readUInt16BE(0);

/** The samples of a frame, as 16-bit little-endian mono PCM. */
export const samplesOf = (frame: Buffer): Buffer => frame.subarray(HEADER_BYTES);

/** A frame carrying `samples` for `stream`. */
export function audioFrame(stream: number, samples: Buffer): Buffer {
  if (samples.length % 2) throw new Error('audio is a whole number of 16-bit samples');
  const frame = Buffer.alloc(HEADER_BYTES + samples.length);
  frame.writeUInt16BE(stream, 0);
  samples.copy(frame, HEADER_BYTES);
  return frame;
}

/** How many bytes of samples carry `milliseconds` of audio at `sampleRate`: 640 for 20 ms at 16000 Hz. */
export const bytesPerFrame = (sampleRate: number, milliseconds = 20): number =>
  Math.floor((sampleRate * milliseconds) / 1000) * 2;
