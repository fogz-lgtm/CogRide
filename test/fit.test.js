import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decoder, Stream } from '@garmin/fitsdk';
import { encodeActivity, fitCrc, fitTimestamp } from '../js/core/fit.js';
import { summarize } from '../js/recorder.js';

const start = Date.UTC(2026, 9, 10, 7, 0, 0);
const samples = Array.from({ length: 600 }, (_, i) => ({
  time: start + (i < 300 ? i : i + 60) * 1000, // 60 s pause in the middle
  power: 200 + (i % 10),
  cadence: 90,
  heartRate: 140,
  speed: 9.5,
  distance: (i + 1) * 9.5,
  altitude: 720 + i * 0.5,
  grade: 5,
  lat: 45.05 + i * 1e-5,
  lon: 6.03,
}));

test('CRC of known bytes', () => {
  assert.equal(fitCrc(new Uint8Array([])), 0);
  // A valid FIT file's CRC over all bytes including its own CRC is zero.
  const bytes = encodeActivity(samples, { summary: summarize(samples, 250), ftp: 250 });
  assert.equal(fitCrc(bytes), 0);
});

test('Garmin FIT SDK decodes our activity as a virtual ride', () => {
  const bytes = encodeActivity(samples, { summary: summarize(samples, 250), ftp: 250 });
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  assert.ok(decoder.isFIT());
  assert.ok(decoder.checkIntegrity());
  const { messages, errors } = decoder.read({ convertTypesToStrings: true });
  assert.deepEqual(errors, []);
  assert.equal(messages.fileIdMesgs[0].type, 'activity');
  assert.equal(messages.recordMesgs.length, 600);
  const r = messages.recordMesgs[10];
  assert.equal(r.power, 200);
  assert.equal(r.cadence, 90);
  assert.equal(r.heartRate, 140);
  assert.ok(Math.abs(r.speed - 9.5) < 0.01);
  assert.ok(Math.abs(r.altitude - 725) < 0.3);
  assert.ok(Math.abs(r.grade - 5) < 0.01);
  assert.ok(Math.abs(r.positionLat - Math.round((45.0501 * 2 ** 31) / 180)) <= 1);
  const session = messages.sessionMesgs[0];
  assert.equal(session.sport, 'cycling');
  assert.equal(session.subSport, 'virtualActivity');
  assert.equal(session.totalTimerTime, 600);
  assert.equal(session.totalElapsedTime, 660);
  assert.ok(Math.abs(session.totalDistance - 5700) < 0.1);
  assert.equal(messages.activityMesgs[0].numSessions, 1);
  // timer stop/start around the pause
  const timerEvents = messages.eventMesgs.filter((e) => e.event === 'timer').map((e) => e.eventType);
  assert.deepEqual(timerEvents, ['start', 'stopAll', 'start', 'stopAll']);
  assert.equal(new Date(r.timestamp).getTime(), start + 10_000);
});

test('records without optional fields stay valid', () => {
  const bare = [{ time: start, power: 100, speed: 5, distance: 5 }, { time: start + 1000, power: 110, speed: 5, distance: 10 }];
  const decoder = new Decoder(Stream.fromByteArray(Array.from(encodeActivity(bare))));
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, []);
  assert.equal(messages.recordMesgs[1].power, 110);
  assert.equal(messages.recordMesgs[1].heartRate, undefined);
  assert.equal(fitTimestamp(Date.UTC(1989, 11, 31)), 0);
});
