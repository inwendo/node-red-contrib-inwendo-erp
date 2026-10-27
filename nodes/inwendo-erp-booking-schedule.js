'use strict';

const { createWebhookEndpoint } = require('./lib/webhook-endpoint');
const {
	EVENT_TYPES,
	ALL_TIMED,
	parseBookableFilter,
	matchesTimedEvent,
	topicOf,
	isCancelled,
	timedEventsOfBooking,
	pollQuery,
	LocalEventScheduler,
} = require('./lib/booking-schedule');

const MINUTE_MS = 60 * 1000;

module.exports = function (RED) {
	/**
	 * Sends a message before a booking starts, at its start, at its end and after it ended
	 * (e.g. preheat a hall, floodlight on / off).
	 *
	 * Mode "erp": the ERP sends the timed events to a trigger webhook (https or its MQTT broker);
	 * needs the ERP setting integration_booking_timed_events_enabled, lead / lag time come from the ERP.
	 * Mode "poll": the node reads the bookings every few minutes and schedules the events itself with
	 * its own lead / lag time; works with every ERP.
	 */
	function InwendoErpBookingScheduleNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const server = RED.nodes.getNode(config.server);
		const eventType = EVENT_TYPES.includes(config.eventType) ? config.eventType : 'all';
		const bookables = parseBookableFilter(config.bookables);
		const filter = { eventType, bookables };

		function emit(event, booking, source) {
			if (!matchesTimedEvent(event, filter)) {
				return;
			}
			node.send({
				topic: topicOf(event),
				payload: event,
				eventType: event.type,
				booking,
				source,
			});
		}

		if (config.mode === 'poll') {
			startPolling(node, server, config, filter, emit);
			return;
		}

		const endpoint = createWebhookEndpoint(RED, node, {
			server,
			delivery: config.delivery,
			publicUrl: config.publicUrl,
			instanceId: config.instanceId,
			referenceClassName: 'BaseBooking',
			databaseAction: eventType === 'all' ? ALL_TIMED : eventType,
			onEvent: (body) => {
				const event = body && body.iw_timed_event;
				if (event && typeof event === 'object') {
					emit({ ...event, type: event.type || body.iw_action }, body.data, 'erp');
				}
			},
		});
		node.on('close', (removed, done) => endpoint.close(removed).then(() => done(), () => done()));
	}

	RED.nodes.registerType('inwendo-erp-booking-schedule', InwendoErpBookingScheduleNode);
};

/**
 * Mode "poll": GET /api/event/base_booking every pollInterval minutes, events of the next
 * pollInterval + 1 minutes get a timer.
 */
function startPolling(node, server, config, filter, emit) {
	if (!server) {
		node.status({ fill: 'red', shape: 'ring', text: 'no ERP connection' });
		return;
	}
	const preStartMinutes = minutes(config.preStartMinutes, 30);
	const postEndMinutes = minutes(config.postEndMinutes, 15);
	const intervalMs = Math.min(60, Math.max(1, parseFloat(config.pollInterval) || 5)) * MINUTE_MS;
	const horizonMs = intervalMs + MINUTE_MS;
	const bookingsById = new Map();
	const scheduler = new LocalEventScheduler({
		emit: (event) => {
			emit(event, bookingsById.get(event.booking_id), 'poll');
			showNext();
		},
	});
	let timer = null;
	let closed = false;
	let failing = false;

	function showNext() {
		const next = scheduler.next();
		node.status(next
			? { fill: 'green', shape: 'dot', text: `next: ${next.type.replace('booking_', '')} ${next.bookable_name || ''} ${new Date(next.dueMs).toLocaleTimeString()}`.replace(/ +/g, ' ') }
			: { fill: 'green', shape: 'ring', text: `polling, nothing due in ${Math.round(horizonMs / MINUTE_MS)} min` });
	}

	async function poll() {
		try {
			const qs = pollQuery({ now: Date.now(), horizonMs, preStartMinutes, postEndMinutes, bookables: filter.bookables });
			const bookings = await server.client.requestAllItems('/api/event/base_booking', qs);
			if (closed) {
				return;
			}
			bookingsById.clear();
			const events = [];
			for (const booking of Array.isArray(bookings) ? bookings : []) {
				if (isCancelled(booking)) {
					continue;
				}
				bookingsById.set(booking.id, booking);
				events.push(...timedEventsOfBooking(booking, { preStartMinutes, postEndMinutes }).filter((event) => matchesTimedEvent(event, filter)));
			}
			scheduler.update(events, horizonMs);
			failing = false;
			showNext();
		} catch (error) {
			if (closed) {
				return;
			}
			node.status({ fill: 'red', shape: 'ring', text: error.erpCode ? `poll failed (error ${error.erpCode})` : 'poll failed' });
			if (!failing) {
				node.error(`Reading the bookings failed: ${error.message}`);
			}
			failing = true;
		}
		if (!closed) {
			timer = setTimeout(poll, intervalMs);
		}
	}

	poll();
	node.on('close', (done) => {
		closed = true;
		clearTimeout(timer);
		scheduler.stop();
		done();
	});
}

function minutes(value, fallback) {
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 24 * 60 ? parsed : fallback;
}
