// Minimal FIT activity encoder (Garmin Flexible & Interoperable Data Transfer).
// Writes file_id, device_info, event, record, lap, session and activity
// messages: enough for Strava, intervals.icu, TrainingPeaks and Garmin Connect.
// sport=cycling + sub_sport=virtual_activity makes Strava file it as a Virtual Ride.

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);

// Base types: [id, size, invalid value]
const T = {
  enum: [0x00, 1, 0xff],
  uint8: [0x02, 1, 0xff],
  sint16: [0x83, 2, 0x7fff],
  uint16: [0x84, 2, 0xffff],
  sint32: [0x85, 4, 0x7fffffff],
  uint32: [0x86, 4, 0xffffffff],
  string: [0x07, 0, 0],
  uint32z: [0x8c, 4, 0],
};

const MESG = { file_id: 0, session: 18, lap: 19, record: 20, event: 21, device_info: 23, activity: 34 };

// Field tables: [name, fieldNumber, type]
const FIELDS = {
  file_id: [
    ['type', 0, T.enum],
    ['manufacturer', 1, T.uint16],
    ['product', 2, T.uint16],
    ['serial_number', 3, T.uint32z],
    ['time_created', 4, T.uint32],
  ],
  device_info: [
    ['timestamp', 253, T.uint32],
    ['device_index', 0, T.uint8],
    ['manufacturer', 2, T.uint16],
    ['product', 4, T.uint16],
    ['software_version', 5, T.uint16],
  ],
  event: [
    ['timestamp', 253, T.uint32],
    ['event', 0, T.enum],
    ['event_type', 1, T.enum],
    ['event_group', 4, T.uint8],
  ],
  record: [
    ['timestamp', 253, T.uint32],
    ['position_lat', 0, T.sint32],
    ['position_long', 1, T.sint32],
    ['altitude', 2, T.uint16], // scale 5, offset 500 m
    ['heart_rate', 3, T.uint8],
    ['cadence', 4, T.uint8],
    ['distance', 5, T.uint32], // scale 100 (m)
    ['speed', 6, T.uint16], // scale 1000 (m/s)
    ['power', 7, T.uint16],
    ['grade', 9, T.sint16], // scale 100 (%)
  ],
  lap: [
    ['timestamp', 253, T.uint32],
    ['event', 0, T.enum],
    ['event_type', 1, T.enum],
    ['start_time', 2, T.uint32],
    ['total_elapsed_time', 7, T.uint32], // scale 1000 (s)
    ['total_timer_time', 8, T.uint32], // scale 1000 (s)
    ['total_distance', 9, T.uint32], // scale 100
    ['total_calories', 11, T.uint16],
    ['avg_speed', 13, T.uint16],
    ['max_speed', 14, T.uint16],
    ['avg_heart_rate', 15, T.uint8],
    ['max_heart_rate', 16, T.uint8],
    ['avg_cadence', 17, T.uint8],
    ['max_cadence', 18, T.uint8],
    ['avg_power', 19, T.uint16],
    ['max_power', 20, T.uint16],
    ['total_ascent', 21, T.uint16],
    ['total_descent', 22, T.uint16],
    ['sport', 25, T.enum],
    ['sub_sport', 39, T.enum],
    ['normalized_power', 33, T.uint16],
    ['total_work', 41, T.uint32], // J
  ],
  session: [
    ['timestamp', 253, T.uint32],
    ['event', 0, T.enum],
    ['event_type', 1, T.enum],
    ['start_time', 2, T.uint32],
    ['sport', 5, T.enum],
    ['sub_sport', 6, T.enum],
    ['total_elapsed_time', 7, T.uint32],
    ['total_timer_time', 8, T.uint32],
    ['total_distance', 9, T.uint32],
    ['total_calories', 11, T.uint16],
    ['avg_speed', 14, T.uint16],
    ['max_speed', 15, T.uint16],
    ['avg_heart_rate', 16, T.uint8],
    ['max_heart_rate', 17, T.uint8],
    ['avg_cadence', 18, T.uint8],
    ['max_cadence', 19, T.uint8],
    ['avg_power', 20, T.uint16],
    ['max_power', 21, T.uint16],
    ['total_ascent', 22, T.uint16],
    ['total_descent', 23, T.uint16],
    ['first_lap_index', 25, T.uint16],
    ['num_laps', 26, T.uint16],
    ['normalized_power', 34, T.uint16],
    ['training_stress_score', 35, T.uint16], // scale 10
    ['intensity_factor', 36, T.uint16], // scale 1000
    ['threshold_power', 45, T.uint16],
    ['total_work', 48, T.uint32],
  ],
  activity: [
    ['timestamp', 253, T.uint32],
    ['total_timer_time', 0, T.uint32],
    ['num_sessions', 1, T.uint16],
    ['type', 2, T.enum],
    ['event', 3, T.enum],
    ['event_type', 4, T.enum],
    ['local_timestamp', 5, T.uint32],
  ],
};

export const SPORT_CYCLING = 2;
export const SUB_SPORT_VIRTUAL_ACTIVITY = 58;
const EVENT_TIMER = 0;
const EVENT_LAP = 9;
const EVENT_ACTIVITY = 26;
const EVENT_TYPE_START = 0;
const EVENT_TYPE_STOP = 1;
const EVENT_TYPE_STOP_ALL = 4;
const MANUFACTURER_DEVELOPMENT = 255;

export function fitTimestamp(ms) {
  return Math.round((ms - FIT_EPOCH_MS) / 1000);
}

export function degreesToSemicircles(deg) {
  return Math.round(deg * (2 ** 31 / 180));
}

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function fitCrc(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  concat() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

function encodeValue(view, offset, [typeId, size, invalid], value) {
  const v = value == null || Number.isNaN(value) ? invalid : Math.round(value);
  switch (typeId) {
    case 0x00:
    case 0x02:
      view.setUint8(offset, clamp(v, 0, 0xff));
      break;
    case 0x83:
      view.setInt16(offset, value == null ? invalid : clamp(v, -0x8000, 0x7ffe), true);
      break;
    case 0x84:
      view.setUint16(offset, clamp(v, 0, 0xffff), true);
      break;
    case 0x85:
      view.setInt32(offset, value == null ? invalid : clamp(v, -0x80000000, 0x7ffffffe), true);
      break;
    case 0x86:
    case 0x8c:
      view.setUint32(offset, clamp(v, 0, 0xffffffff), true);
      break;
    default:
      throw new Error(`Unsupported FIT type ${typeId}`);
  }
  return offset + size;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class FitWriter {
  constructor() {
    this.body = new ByteWriter();
    this.localTypes = new Map(); // message name -> local message number
  }

  define(name) {
    if (this.localTypes.has(name)) return this.localTypes.get(name);
    const local = this.localTypes.size;
    if (local > 15) throw new Error('Too many local message types');
    const fields = FIELDS[name];
    const bytes = new Uint8Array(6 + fields.length * 3);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 0x40 | local); // definition message header
    view.setUint8(1, 0); // reserved
    view.setUint8(2, 0); // little-endian
    view.setUint16(3, MESG[name], true);
    view.setUint8(5, fields.length);
    fields.forEach(([, num, type], i) => {
      view.setUint8(6 + i * 3, num);
      view.setUint8(7 + i * 3, type[1]);
      view.setUint8(8 + i * 3, type[0]);
    });
    this.body.push(bytes);
    this.localTypes.set(name, local);
    return local;
  }

  write(name, values) {
    const local = this.define(name);
    const fields = FIELDS[name];
    const size = 1 + fields.reduce((s, [, , t]) => s + t[1], 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, local);
    let offset = 1;
    for (const [fieldName, , type] of fields) offset = encodeValue(view, offset, type, values[fieldName]);
    this.body.push(bytes);
  }

  finish() {
    const data = this.body.concat();
    const header = new Uint8Array(14);
    const hv = new DataView(header.buffer);
    hv.setUint8(0, 14);
    hv.setUint8(1, 0x20); // protocol 2.0
    hv.setUint16(2, 2132, true); // profile version 21.32
    hv.setUint32(4, data.length, true);
    header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    hv.setUint16(12, fitCrc(header.subarray(0, 12)), true);
    const out = new Uint8Array(14 + data.length + 2);
    out.set(header, 0);
    out.set(data, 14);
    const crc = fitCrc(out.subarray(0, 14 + data.length));
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = crc >> 8;
    return out;
  }
}

// samples: [{ time (ms), power, cadence, heartRate, speed (m/s), distance (m),
//             altitude (m)?, grade (%)?, lat?, lon? }]
// summary: output of recorder.summarize()
export function encodeActivity(samples, { summary, ftp } = {}) {
  if (!samples.length) throw new Error('Nothing recorded');
  const w = new FitWriter();
  const start = fitTimestamp(samples[0].time);
  const end = fitTimestamp(samples.at(-1).time);
  const elapsed = Math.max(0, end - start + 1);
  const timer = samples.length; // one sample per riding second
  const serial = (samples[0].time / 1000) >>> 0 || 1;

  w.write('file_id', { type: 4, manufacturer: MANUFACTURER_DEVELOPMENT, product: 1, serial_number: serial, time_created: start });
  w.write('device_info', { timestamp: start, device_index: 0, manufacturer: MANUFACTURER_DEVELOPMENT, product: 1, software_version: 100 });
  w.write('event', { timestamp: start, event: EVENT_TIMER, event_type: EVENT_TYPE_START, event_group: 0 });

  let ascent = 0;
  let descent = 0;
  let maxSpeed = 0;
  let maxCadence = 0;
  let prevAlt = null;
  let prevTime = null;
  for (const s of samples) {
    const ts = fitTimestamp(s.time);
    if (prevTime != null && ts - prevTime > 3) {
      // A pause: close and reopen the timer so moving time stays honest.
      w.write('event', { timestamp: prevTime, event: EVENT_TIMER, event_type: EVENT_TYPE_STOP_ALL, event_group: 0 });
      w.write('event', { timestamp: ts, event: EVENT_TIMER, event_type: EVENT_TYPE_START, event_group: 0 });
    }
    prevTime = ts;
    if (s.altitude != null) {
      if (prevAlt != null) {
        const d = s.altitude - prevAlt;
        if (d > 0) ascent += d;
        else descent -= d;
      }
      prevAlt = s.altitude;
    }
    maxSpeed = Math.max(maxSpeed, s.speed ?? 0);
    maxCadence = Math.max(maxCadence, s.cadence ?? 0);
    w.write('record', {
      timestamp: ts,
      position_lat: s.lat != null ? degreesToSemicircles(s.lat) : null,
      position_long: s.lon != null ? degreesToSemicircles(s.lon) : null,
      altitude: s.altitude != null ? (s.altitude + 500) * 5 : null,
      heart_rate: s.heartRate > 0 ? s.heartRate : null,
      cadence: s.cadence != null ? Math.min(254, s.cadence) : null,
      distance: (s.distance ?? 0) * 100,
      speed: (s.speed ?? 0) * 1000,
      power: s.power ?? null,
      grade: s.grade != null ? s.grade * 100 : null,
    });
  }

  const sm = summary ?? {};
  const distance = samples.at(-1).distance ?? 0;
  const totals = {
    timestamp: end,
    event: EVENT_LAP,
    event_type: EVENT_TYPE_STOP,
    start_time: start,
    total_elapsed_time: elapsed * 1000,
    total_timer_time: timer * 1000,
    total_distance: distance * 100,
    total_calories: sm.kilojoules ?? null,
    avg_speed: timer ? (distance / timer) * 1000 : null,
    max_speed: maxSpeed * 1000,
    avg_heart_rate: sm.avgHeartRate ?? null,
    max_heart_rate: sm.maxHeartRate ?? null,
    avg_cadence: sm.avgCadence ?? null,
    max_cadence: maxCadence || null,
    avg_power: sm.avgPower ?? null,
    max_power: sm.maxPower ?? null,
    total_ascent: Math.round(ascent),
    total_descent: Math.round(descent),
    sport: SPORT_CYCLING,
    sub_sport: SUB_SPORT_VIRTUAL_ACTIVITY,
    normalized_power: sm.normalizedPower ?? null,
    total_work: sm.kilojoules != null ? sm.kilojoules * 1000 : null,
  };
  w.write('event', { timestamp: end, event: EVENT_TIMER, event_type: EVENT_TYPE_STOP_ALL, event_group: 0 });
  w.write('lap', totals);
  w.write('session', {
    ...totals,
    event: EVENT_ACTIVITY,
    first_lap_index: 0,
    num_laps: 1,
    training_stress_score: sm.tss != null ? sm.tss * 10 : null,
    intensity_factor: sm.intensityFactor != null ? sm.intensityFactor * 1000 : null,
    threshold_power: ftp ?? null,
  });
  const tzOffset = -new Date(samples[0].time).getTimezoneOffset() * 60;
  w.write('activity', {
    timestamp: end,
    total_timer_time: timer * 1000,
    num_sessions: 1,
    type: 0,
    event: EVENT_ACTIVITY,
    event_type: EVENT_TYPE_STOP,
    local_timestamp: end + tzOffset,
  });
  return w.finish();
}
