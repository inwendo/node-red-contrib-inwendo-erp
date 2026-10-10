'use strict';

const { credentialOf } = require('./inwendo-erp-access-check');
const { featureDisabledSetting, featureDisabledText } = require('./lib/erp-client');

const MODES = ['attendanceList', 'staffClock'];

/** ERP error codes of the scanner endpoints -> reason of output 2. */
const REASONS = {
	403: 'no_permission',
	404: 'list_not_found',
	1800: 'scanned_too_often',
	1801: 'unknown_person',
	1802: 'list_not_found',
	6011: 'invalid_entry',
	6012: 'invalid_entry',
	6020: 'scanned_too_often',
	6021: 'unknown_person',
	6022: 'no_employment_contract',
};

module.exports = function (RED) {
	/**
	 * Check-in at the entrance with what a card / QR reader read: toggles the person in an attendance
	 * list (check-in, a second scan checks out) or clocks staff in / out (work time). Output 1: done,
	 * output 2: the ERP refused (unknown card, scanned twice within a minute, ...).
	 */
	function InwendoErpCheckInNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;
		const server = RED.nodes.getNode(config.server);
		const mode = MODES.includes(config.mode) ? config.mode : 'attendanceList';

		node.on('input', async (msg, send, done) => {
			const credential = personIdentifierOf(msg.payload);
			if (!credential) {
				done(new Error('msg.payload must be the card number or QR code the reader read (string, number or Buffer)'));
				return;
			}
			if (!server) {
				done(new Error('inwendo ERP connection is not configured'));
				return;
			}
			const listId = msg.listId !== undefined && msg.listId !== null && msg.listId !== '' ? msg.listId : config.listId;
			if (mode === 'attendanceList' && (listId === undefined || listId === null || String(listId).trim() === '')) {
				done(new Error('Attendance list id missing (node setting or msg.listId)'));
				return;
			}
			const path = mode === 'attendanceList'
				? `/api/event/scanner/attendancelist/${encodeURIComponent(String(listId).trim())}/${encodeURIComponent(credential)}`
				: `/api/time/work_entry_scanner/${encodeURIComponent(credential)}`;
			const time = new Date().toLocaleTimeString();
			msg.credential = credential;
			try {
				node.status({ fill: 'blue', shape: 'dot', text: 'checking' });
				const entry = await server.client.request('GET', path);
				// a second scan closes the open entry: an end time means checked out
				const checkedIn = !(entry && entry.end);
				msg.payload = entry;
				msg.success = true;
				msg.checkedIn = checkedIn;
				msg.action = mode === 'attendanceList' ? (checkedIn ? 'check_in' : 'check_out') : (checkedIn ? 'clock_in' : 'clock_out');
				msg.person = personOf(entry, credential);
				node.status({ fill: 'green', shape: 'dot', text: `${msg.action.replace('_', ' ')} ${time}` });
				send([msg, null]);
				done();
			} catch (error) {
				const disabled = featureDisabledSetting(error);
				if (disabled) {
					node.status({ fill: 'red', shape: 'ring', text: featureDisabledText(disabled) });
					done(new Error(featureDisabledText(disabled)));
					return;
				}
				const reason = error.erpCode !== undefined ? REASONS[error.erpCode] : undefined;
				if (!reason && !(error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 401)) {
					// no answer of the ERP (network, server error, token): an error, not a refused check-in
					node.status({ fill: 'red', shape: 'ring', text: error.erpCode ? `error ${error.erpCode}` : 'error' });
					done(error);
					return;
				}
				msg.payload = { success: false, reason: reason || 'refused', erpCode: error.erpCode, statusCode: error.statusCode, message: error.message };
				msg.success = false;
				msg.person = { identifier: credential };
				node.status({ fill: 'red', shape: 'dot', text: `${msg.payload.reason} ${time}` });
				send([null, msg]);
				done();
			}
		});
	}

	RED.nodes.registerType('inwendo-erp-check-in', InwendoErpCheckInNode);
};

/**
 * The person identifier for the scanner endpoints: card number, member number or the QR code of the
 * digital member card (also as ".../verify/<code>" link).
 */
function personIdentifierOf(payload) {
	const value = credentialOf(payload);
	if (!value) {
		return null;
	}
	const link = /\/verify\/([^/?#]+)/.exec(value);
	return link ? decodeURIComponent(link[1]) : value;
}

/**
 * What the ERP answer tells about the person: the work time entry has the user, the attendance
 * list entry has no person data (privacy), only the identifier that was scanned.
 */
function personOf(entry, credential) {
	const person = { identifier: credential };
	const source = entry && (entry.person || entry.linked_person || entry.linkedPerson || entry.user);
	if (source && typeof source === 'object') {
		person.id = source.id;
		const name = source.full_name || source.name || [source.first_name || source.firstName, source.last_name || source.lastName].filter(Boolean).join(' ');
		if (name) {
			person.name = name;
		}
	}
	return person;
}

module.exports.personIdentifierOf = personIdentifierOf;
module.exports.personOf = personOf;
