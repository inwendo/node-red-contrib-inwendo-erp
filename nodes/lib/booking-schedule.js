'use strict';

/**
 * Timed booking events: booking_pre_start (lead time before the start), booking_start, booking_end
 * and booking_post_end (lag time after the end). The ERP sends them as trigger webhooks
 * (database_action booking_*, ERP setting integration_booking_timed_events_enabled); without that
 * the booking schedule node reads the bookings and schedules the same events itself.
 */
const EVENT_TYPES = ['booking_pre_start', 'booking_start', 'booking_end', 'booking_post_end'];
/** database_action of all four timed events */
const ALL_TIMED = 'booking_timed';
const MINUTE_MS = 60 * 1000;
/** Events found up to this late (deploy, slow poll) are still sent, like the ERP (1-2 minutes late). */
const GRACE_MS = 2 * MINUTE_MS;

/**
 * Bookable filter of the node: ids and / or names, separated by commas.
 * @returns {{ids: string[], names: string[]}|null} null = all bookables
 */
function parseBookableFilter(value) {
	const parts = String(value === undefined || value === null ? '' : value).split(',').map((part) => part.trim()).filter((part) => part !== '');
	if (parts.length === 0) {
		return null;
	}
	return {
		ids: parts.filter((part) => /^\d+$/.test(part)),
		names: parts.filter((part) => !/^\d+$/.test(part)).map((part) => part.toLowerCase()),
	};
}

/** Whether a timed event (iw_timed_event) passes the event type and bookable filter of the node. */
function matchesTimedEvent(event, { eventType = 'all', bookables = null } = {}) {
	if (!event || !EVENT_TYPES.includes(event.type)) {
		return false;
	}
	if (eventType !== 'all' && event.type !== eventType) {
		return false;
	}
	if (!bookables) {
		return true;
	}
	const id = event.bookable_id !== undefined && event.bookable_id !== null ? String(event.bookable_id) : null;
	const name = event.bookable_name ? String(event.bookable_name).toLowerCase() : null;
	return (id !== null && bookables.ids.includes(id)) || (name !== null && bookables.names.includes(name));
}

/** msg.topic of a timed event: "<bookable name>/<event type>". */
function topicOf(event) {
	return `${event.bookable_name || (event.bookable_id !== undefined && event.bookable_id !== null ? event.bookable_id : '')}/${event.type}`;
}

function isCancelled(booking) {
	return !booking || booking.deleted === true || /CANCEL/i.test(String(booking.booking_status || ''));
}

function refOf(value) {
	return value && typeof value === 'object' ? value : null;
}

/**
 * The four timed events of a booking of GET /api/event/base_booking, in the shape of the ERP's
 * iw_timed_event (plus dueMs, the due time in ms).
 */
function timedEventsOfBooking(booking, { preStartMinutes, postEndMinutes }) {
	const start = Date.parse(booking && booking.start_time);
	const end = Date.parse(booking && booking.end_time);
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		return [];
	}
	const bookable = refOf(booking.baseBookable);
	const location = refOf(booking.baseLocation);
	const due = {
		booking_pre_start: start - preStartMinutes * MINUTE_MS,
		booking_start: start,
		booking_end: end,
		booking_post_end: end + postEndMinutes * MINUTE_MS,
	};
	return EVENT_TYPES.map((type) => ({
		type,
		due_at: new Date(due[type]).toISOString(),
		booking_id: booking.id,
		booking_title: booking.name !== undefined ? booking.name : null,
		start: booking.start_time,
		end: booking.end_time,
		bookable_id: bookable ? bookable.id : null,
		bookable_name: bookable ? bookable.name : null,
		location_id: location ? location.id : null,
		location_name: location ? location.name : null,
		participants: null,
		pre_start_minutes: preStartMinutes,
		post_end_minutes: postEndMinutes,
		dueMs: due[type],
	}));
}

/**
 * Query of the bookings whose events fall into [now - grace, now + horizon]: the booking starts at
 * the latest at now + horizon + lead and ends at the earliest at now - grace - lag.
 */
function pollQuery({ now, horizonMs, preStartMinutes, postEndMinutes, bookables }) {
	const latestStart = Math.ceil((now + horizonMs + preStartMinutes * MINUTE_MS) / 1000);
	const earliestEnd = Math.floor((now - GRACE_MS - postEndMinutes * MINUTE_MS) / 1000);
	const qs = {
		deleted: 'false',
		startTimeCMP: `lte,IW_DATE_TIME_${latestStart}`,
		endTimeCMP: `gte,IW_DATE_TIME_${earliestEnd}`,
	};
	if (bookables && bookables.names.length === 0 && bookables.ids.length > 0) {
		qs.baseBookableIN = bookables.ids.join(',');
	}
	return qs;
}

/**
 * Timers of the events found by polling. update() is called with every poll result: events due
 * within the horizon get a timer, events up to GRACE_MS late are sent at once, timers of bookings
 * that moved or disappeared are cancelled. Every event (booking, type, due time) is sent once.
 */
class LocalEventScheduler {
	/**
	 * @param {{emit: function(object): void, now?: function(): number, setTimer?: Function, clearTimer?: Function}} options
	 */
	constructor({ emit, now, setTimer, clearTimer }) {
		this.emit = emit;
		this.now = now || Date.now;
		this.setTimer = setTimer || setTimeout;
		this.clearTimer = clearTimer || clearTimeout;
		/** key -> {timer, event} */
		this.pending = new Map();
		/** key -> due time of sent events */
		this.sent = new Map();
	}

	static key(event) {
		return `${event.booking_id}|${event.type}|${event.dueMs}`;
	}

	/**
	 * @param {object[]} events timed events of the polled bookings (already filtered)
	 * @param {number} horizonMs
	 */
	update(events, horizonMs) {
		const now = this.now();
		const wanted = new Map();
		for (const event of events) {
			if (event.dueMs >= now - GRACE_MS && event.dueMs <= now + horizonMs) {
				wanted.set(LocalEventScheduler.key(event), event);
			}
		}
		// moved, cancelled or deleted bookings
		for (const [key, entry] of this.pending) {
			if (!wanted.has(key)) {
				this.clearTimer(entry.timer);
				this.pending.delete(key);
			}
		}
		for (const [key, event] of wanted) {
			if (this.sent.has(key) || this.pending.has(key)) {
				continue;
			}
			const delay = Math.max(0, event.dueMs - now);
			const timer = this.setTimer(() => this.fire(key), delay);
			this.pending.set(key, { timer, event });
		}
		// forget sent events long past
		for (const [key, dueMs] of this.sent) {
			if (dueMs < now - 24 * 60 * MINUTE_MS) {
				this.sent.delete(key);
			}
		}
	}

	fire(key) {
		const entry = this.pending.get(key);
		if (!entry) {
			return;
		}
		this.pending.delete(key);
		this.sent.set(key, entry.event.dueMs);
		const event = { ...entry.event };
		delete event.dueMs;
		this.emit(event);
	}

	/** The next pending event (for the node status). */
	next() {
		let next = null;
		for (const { event } of this.pending.values()) {
			if (!next || event.dueMs < next.dueMs) {
				next = event;
			}
		}
		return next;
	}

	stop() {
		for (const entry of this.pending.values()) {
			this.clearTimer(entry.timer);
		}
		this.pending.clear();
	}
}

module.exports = {
	EVENT_TYPES,
	ALL_TIMED,
	GRACE_MS,
	parseBookableFilter,
	matchesTimedEvent,
	topicOf,
	isCancelled,
	timedEventsOfBooking,
	pollQuery,
	LocalEventScheduler,
};
