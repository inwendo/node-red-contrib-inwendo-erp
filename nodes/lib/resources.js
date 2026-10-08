'use strict';

/**
 * ERP resources of the inwendo-erp node, the same as in the n8n node.
 * prefix: Symfony form block the ERP expects POST / PATCH bodies to be wrapped in.
 */
const RESOURCES = {
	booking: { label: 'Booking', path: '/api/event/base_booking', prefix: 'data' },
	company: { label: 'Company', path: '/api/crm/crmcompanies', prefix: 'crmcompany' },
	event: { label: 'Event', path: '/api/event/base_event', prefix: 'data' },
	eventSignUp: { label: 'Event Sign-Up', path: '/api/event/base_event_signup', prefix: 'data' },
	invoice: { label: 'Invoice', path: '/api/invoice/invoices', prefix: 'invoice', pdf: true, noUpdate: true },
	newsArticle: { label: 'News Article', path: '/api/media/news_article', prefix: 'data' },
	offer: { label: 'Offer', path: '/api/invoice/offers', prefix: 'offer', pdf: true, noUpdate: true },
	person: { label: 'Person', path: '/api/crm/crmpeople', prefix: 'crmperson' },
	project: { label: 'Project', path: '/api/crm/crmprojects', prefix: 'crmproject' },
	smartLock: { label: 'Smart Lock', path: '/api/event/smart_lock', prefix: 'data', lockActions: true },
	smartLockLog: { label: 'Smart Lock Log', path: '/api/event/smart_lock_log', prefix: 'data', readOnly: true },
	ticket: { label: 'Ticket', path: '/api/crm/tickets', prefix: 'ticket' },
	timeEntry: { label: 'Time Entry', path: '/api/time/entries', prefix: 'time_entry' },
	webhook: { label: 'Webhook', path: '/api/dw/webhook', prefix: 'data' },
};

const OPERATIONS = ['get', 'getAll', 'create', 'update', 'getPdf', 'unlock', 'lock', 'status'];

/** Operations of smart locks only: the ERP opens / locks the lock through its provider (Nuki, LOQED, ...). */
const LOCK_OPERATIONS = ['unlock', 'lock', 'status'];

/** Entity types of the trigger node (value = ERP class short name, like the n8n trigger). */
const TRIGGER_ENTITY_TYPES = {
	all: 'All',
	BaseBooking: 'Booking',
	CRMCompany: 'Company',
	BaseEvent: 'Event',
	BaseEventSignUp: 'Event Sign-Up',
	Invoice: 'Invoice',
	MediaNewsArticle: 'News Article',
	Offer: 'Offer',
	CRMPerson: 'Person',
	CRMProject: 'Project',
	SmartLockLog: 'Smart Lock Log',
	CustomerTicket: 'Ticket',
	TimeEntry: 'Time Entry',
};

/**
 * Wraps a body in the form block of the resource, unless it is wrapped already.
 */
function wrapBody(resource, body) {
	const prefix = RESOURCES[resource].prefix;
	if (body && typeof body === 'object' && !Array.isArray(body)) {
		const keys = Object.keys(body);
		if (keys.length === 1 && keys[0] === prefix && body[prefix] && typeof body[prefix] === 'object') {
			return body;
		}
	}
	return { [prefix]: body };
}

module.exports = { RESOURCES, OPERATIONS, LOCK_OPERATIONS, TRIGGER_ENTITY_TYPES, wrapBody };
