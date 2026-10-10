// Minimal protobuf wire-format decoder: enough to read Zwift controller messages.

export function decodeVarint(bytes, offset) {
  let result = 0;
  let multiplier = 1;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos++];
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [result, pos];
    multiplier *= 128;
  }
  throw new Error('Truncated varint');
}

// Returns Map<fieldNumber, value[]>. Varints are numbers, length-delimited fields are Uint8Arrays.
export function decodeFields(bytes) {
  const fields = new Map();
  let pos = 0;
  while (pos < bytes.length) {
    let key;
    [key, pos] = decodeVarint(bytes, pos);
    const fieldNumber = Math.floor(key / 8);
    const wireType = key & 0x07;
    let value;
    switch (wireType) {
      case 0:
        [value, pos] = decodeVarint(bytes, pos);
        break;
      case 1:
        value = bytes.subarray(pos, pos + 8);
        pos += 8;
        break;
      case 2: {
        let length;
        [length, pos] = decodeVarint(bytes, pos);
        value = bytes.subarray(pos, pos + length);
        pos += length;
        break;
      }
      case 5:
        value = bytes.subarray(pos, pos + 4);
        pos += 4;
        break;
      default:
        throw new Error(`Unsupported wire type ${wireType}`);
    }
    if (pos > bytes.length) throw new Error('Truncated field');
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

export function firstField(fields, fieldNumber) {
  return fields.get(fieldNumber)?.[0];
}
