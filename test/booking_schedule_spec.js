'use strict';

const assert = require('assert');
const {
	parseBookableFilter,
	matchesTimedEvent,
	topicOf,
	isCancelled,
	timedEventsOfBooking,
	pollQuery,
	LocalEventScheduler,
	GRACE_MS,
} = require('../nodes/lib/booking-schedule');

const MINUTE = 60 * 1000;

function booking(overrides = {}) {
	return {
		id: 123,
		name: 'Training U12',
		start_time: '2026-10-11T18:00:00+02:00',
		end_time: '2026-10-11T19:30:00+02:00',
		deleted: false,
		booking_status: null,
		baseBookable: { id: 7, name: 'Halle 1' },
		baseLocation: { id: 2, name: 'Sportzentrum' },
		...overrides,
	};
}

/** Timers driven by the test instead of the clock. */
function fakeClock(start) {
	const clock = { now: start, timers: new Map(), nextId: 1 };
	clock.setTimer = (fn, delay) => {
		const id = clock.nextId++;
		clock.timers.set(id, { fn, at: clock.now + delay });
		return id;
	};
	clock.clearTimer = (id) => clock.timers.delete(id);
	clock.advance = (ms) => {
		clock.now += ms;
		for (const [id, timer] of [...clock.timers].sort((a, b) => a[1].at - b[1].at)) {
			if (timer.at <= clock.now && clock.timers.has(id)) {
				clock.timers.delete(id);
				timer.fn();
			}
		}
	};
	return clock;
}

describe('booking schedule', function () {
	it('computes the four timed events of a booking like the ERP', function () {
		const events = timedEventsOfBooking(booking(), { preStartMinutes: 30, postEndMinutes: 15 });
		assert.deepStrictEqual(events.map((event) => [event.type, event.due_at]), [
			['booking_pre_start', '2026-10-11T15:30:00.000Z'],
			['booking_start', '2026-10-11T16:00:00.000Z'],
			['booking_end', '2026-10-11T17:30:00.000Z'],
			['booking_post_end', '2026-10-11T17:45:00.000Z'],
		]);
		const start = events[1];
		assert.strictEqual(start.booking_id, 123);
		assert.strictEqual(start.booking_title, 'Training U12');
		assert.strictEqual(start.bookable_name, 'Halle 1');
		assert.strictEqual(start.location_id, 2);
		assert.strictEqual(start.pre_start_minutes, 30);
		assert.strictEqual(topicOf(start), 'Halle 1/booking_start');
		assert.deepStrictEqual(timedEventsOfBooking(booking({ start_time: null }), { preStartMinutes: 0, postEndMinutes: 0 }), []);
	});

	it('filters by event type and bookable id or name', function () {
		const event = { type: 'booking_start', bookable_id: 7, bookable_name: 'Halle 1' };
		assert.strictEqual(parseBookableFilter(' '), null);
		assert.deepStrictEqual(parseBookableFilter('7, Halle 2'), { ids: ['7'], names: ['halle 2'] });
		assert.strictEqual(matchesTimedEvent(event, {}), true);
		assert.strictEqual(matchesTimedEvent(event, { eventType: 'booking_end' }), false);
		assert.strictEqual(matchesTimedEvent(event, { bookables: parseBookableFilter('7') }), true);
		assert.strictEqual(matchesTimedEvent(event, { bookables: parseBookableFilter('halle 1') }), true);
		assert.strictEqual(matchesTimedEvent(event, { bookables: parseBookableFilter('8, Halle 2') }), false);
		assert.strictEqual(matchesTimedEvent({ type: 'create' }, {}), false);
	});

	it('skips cancelled and deleted bookings', function () {
		assert.strictEqual(isCancelled(booking()), false);
		assert.strictEqual(isCancelled(booking({ deleted: true })), true);
		assert.strictEqual(isCancelled(booking({ booking_status: 'FCS_CANCELLED_BY_BLOCKING' })), true);
		assert.strictEqual(isCancelled(booking({ booking_status: 'FCS_RESERVATION' })), false);
	});

	it('reads the bookings whose events fall into the window', function () {
		const now = Date.parse('2026-10-11T16:00:00Z');
		const qs = pollQuery({ now, horizonMs: 6 * MINUTE, preStartMinutes: 30, postEndMinutes: 15, bookables: parseBookableFilter('7,8') });
		assert.strictEqual(qs.startTimeCMP, `lte,IW_DATE_TIME_${(now + 36 * MINUTE) / 1000}`);
		assert.strictEqual(qs.endTimeCMP, `gte,IW_DATE_TIME_${(now - GRACE_MS - 15 * MINUTE) / 1000}`);
		assert.strictEqual(qs.baseBookableIN, '7,8');
		assert.strictEqual(qs.deleted, 'false');
		// names are filtered locally
		assert.strictEqual(pollQuery({ now, horizonMs: 0, preStartMinutes: 0, postEndMinutes: 0, bookables: parseBookableFilter('7, Halle 1') }).baseBookableIN, undefined);
	});

	it('schedules every event once, reschedules moved and drops cancelled bookings', function () {
		const clock = fakeClock(Date.parse('2026-10-11T15:59:00Z'));
		const sent = [];
		const scheduler = new LocalEventScheduler({ emit: (event) => sent.push(event), now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
		const options = { preStartMinutes: 30, postEndMinutes: 15 };
		const horizon = 6 * MINUTE;

		// pre start 15:30 is long past, start 16:00 within the horizon
		scheduler.update(timedEventsOfBooking(booking(), options), horizon);
		assert.strictEqual(scheduler.next().type, 'booking_start');
		clock.advance(MINUTE);
		assert.deepStrictEqual(sent.map((event) => event.type), ['booking_start']);
		assert.strictEqual(sent[0].dueMs, undefined);

		// the next poll finds the same event again: not sent twice
		scheduler.update(timedEventsOfBooking(booking(), options), horizon);
		clock.advance(MINUTE);
		assert.strictEqual(sent.length, 1);

		// a second booking moves, then is cancelled before its start
		const other = booking({ id: 124, start_time: '2026-10-11T16:05:00Z', end_time: '2026-10-11T17:00:00Z' });
		scheduler.update(timedEventsOfBooking(other, options), horizon);
		scheduler.update(timedEventsOfBooking({ ...other, start_time: '2026-10-11T16:06:00Z' }, options), horizon);
		assert.strictEqual(clock.timers.size, 1);
		scheduler.update([], horizon);
		assert.strictEqual(clock.timers.size, 0);
		clock.advance(10 * MINUTE);
		assert.strictEqual(sent.length, 1);
	});

	it('sends events up to two minutes late after a restart', function () {
		const clock = fakeClock(Date.parse('2026-10-11T16:01:30Z'));
		const sent = [];
		const scheduler = new LocalEventScheduler({ emit: (event) => sent.push(event), now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
		scheduler.update(timedEventsOfBooking(booking(), { preStartMinutes: 30, postEndMinutes: 15 }), 6 * MINUTE);
		clock.advance(0);
		assert.deepStrictEqual(sent.map((event) => event.type), ['booking_start']);
		scheduler.stop();
	});
});
