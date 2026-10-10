'use strict';

/**
 * ERP resources of the inwendo-erp node: the ones of the n8n node plus inventory loans, attendance
 * lists, shift plan, occupancy, usage counters and notifications.
 *
 * prefix: Symfony form block the ERP expects POST / PATCH bodies to be wrapped in.
 * operations: the operations of the resource (default: get, getAll, create, update).
 * paths: path templates of the standard operations when they differ from `path` / `path/{id}`
 *   ({id} = msg.id / node ID, {parent} = msg.parentId / node setting, e.g. the attendance list).
 * parent: label of the parent id and the operations that need it.
 * actions: further operations: method, path template (relative to `path` unless it starts with
 *   /api/), needsId (default true), body ("payload": msg.payload in the form block, "none", or a
 *   function msg.payload -> body).
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

	// inventory loans (ERP setting event_inventory_enabled); a loan is created from a booking
	inventoryLoan: {
		label: 'Inventory Loan',
		path: '/api/event/inventory_loan',
		prefix: 'data',
		operations: ['get', 'getAll', 'create', 'returnLoan', 'extend', 'stock', 'availability'],
		actions: {
			returnLoan: { method: 'PATCH', path: '/{id}/return', body: 'payload' },
			extend: { method: 'PATCH', path: '/{id}/extend', body: 'payload', requiresBody: true },
			stock: { method: 'GET', path: '/api/event/inventory_loan_stock', needsId: false, body: 'none' },
			// {id} = the bookable (inventory item); msg.query = {start, end}
			availability: { method: 'GET', path: '/api/event/inventory_loan_availability/{id}', body: 'none' },
		},
	},
	attendanceList: { label: 'Attendance List', path: '/api/event/attendancelist', prefix: 'data' },
	attendanceListEntry: {
		label: 'Attendance List Entry',
		path: '/api/event/attendancelist',
		prefix: 'data',
		paths: {
			get: '/api/event/attendancelist/{id}/entry',
			update: '/api/event/attendancelist/{id}/entry',
			getAll: '/api/event/attendancelist/{parent}/entries',
			create: '/api/event/attendancelist/{parent}/entry',
		},
		parent: { label: 'Attendance list ID', operations: ['getAll', 'create'] },
	},
	shiftPlanEntry: {
		label: 'Shift Plan Entry',
		path: '/api/time/shift_plan_entry',
		prefix: 'data',
		operations: ['get', 'getAll', 'create', 'update', 'clockIn', 'clockOut'],
		actions: {
			// own shifts of the token's user (ERP settings shift_planning_enabled, shift_clocking_enabled)
			clockIn: { method: 'POST', path: '/{id}/clock_in', body: 'none' },
			clockOut: { method: 'POST', path: '/{id}/clock_out', body: 'none' },
		},
	},
	occupancy: {
		label: 'Occupancy',
		path: '/api/event/bookable_occupancy',
		operations: ['getOccupancy'],
		actions: {
			// ERP setting integration_occupancy_api_enabled; the optional ID filters bookables (comma list)
			getOccupancy: { method: 'GET', path: '', needsId: false, idQuery: 'bookable', body: 'none' },
		},
	},
	usageCounter: {
		label: 'Usage Counter',
		path: '/api/event/base_bookable_usage_counter',
		prefix: 'data',
		operations: ['get', 'getAll', 'create', 'update', 'setValue'],
		actions: {
			setValue: { method: 'PATCH', path: '/{id}', body: counterValueBody },
		},
	},
	userNotification: {
		label: 'Notification',
		path: '/api/notification/user_notification',
		prefix: 'data',
		operations: ['get', 'getAll', 'markRead'],
		// the ERP has no single GET for notifications: the list filtered by id
		getByListFilter: true,
		actions: {
			markRead: { method: 'PUT', path: '/{id}', body: () => ({ data: { read: true } }) },
		},
	},
};

const OPERATIONS = [
	'get', 'getAll', 'create', 'update', 'getPdf', 'unlock', 'lock', 'status',
	'returnLoan', 'extend', 'stock', 'availability', 'clockIn', 'clockOut', 'getOccupancy', 'setValue', 'markRead',
];

/** Operations of smart locks only: the ERP opens / locks the lock through its provider (Nuki, LOQED, ...). */
const LOCK_OPERATIONS = ['unlock', 'lock', 'status'];

/** The operations a resource offers (the editor shows the same lists). */
function operationsOf(resource) {
	const definition = RESOURCES[resource];
	if (!definition) {
		return [];
	}
	if (definition.operations) {
		return definition.operations;
	}
	if (definition.lockActions) {
		return ['get', 'getAll', ...LOCK_OPERATIONS];
	}
	if (definition.readOnly) {
		return ['get', 'getAll'];
	}
	if (definition.pdf) {
		return definition.noUpdate ? ['get', 'getAll', 'create', 'getPdf'] : ['get', 'getAll', 'create', 'update', 'getPdf'];
	}
	return ['get', 'getAll', 'create', 'update'];
}

/** Whether an operation of a resource needs msg.id / the ID of the node. */
function needsId(resource, operation) {
	const action = RESOURCES[resource] && RESOURCES[resource].actions && RESOURCES[resource].actions[operation];
	if (action) {
		return action.needsId !== false && !action.idQuery;
	}
	return operation !== 'getAll' && operation !== 'create';
}

/** Whether an operation of a resource needs the parent id (msg.parentId / node setting). */
function needsParent(resource, operation) {
	const parent = RESOURCES[resource] && RESOURCES[resource].parent;
	return !!parent && parent.operations.includes(operation);
}

/**
 * Path of an operation: a template of `paths` / `actions`, else `path` or `path/{id}`.
 */
function pathOf(resource, operation, { id, parentId } = {}) {
	const definition = RESOURCES[resource];
	const action = definition.actions && definition.actions[operation];
	let template;
	if (action) {
		template = action.path.startsWith('/api/') ? action.path : `${definition.path}${action.path}`;
	} else if (definition.paths && definition.paths[operation]) {
		template = definition.paths[operation];
	} else {
		template = needsId(resource, operation) ? `${definition.path}/{id}` : definition.path;
	}
	return template
		.replace('{id}', () => encodeURIComponent(String(id).trim()))
		.replace('{parent}', () => encodeURIComponent(String(parentId).trim()));
}

/** Body of "Usage Counter → Set Value": msg.payload is the new reading (number, numeric string or {value}). */
function counterValueBody(payload) {
	const raw = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload.value : payload;
	const value = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
	if (typeof value !== 'number' || !Number.isFinite(value) || (typeof raw === 'string' && raw.trim() === '')) {
		throw new Error('Usage Counter: Set Value needs the reading as number in msg.payload (or msg.payload.value)');
	}
	return { data: { counterValue: value } };
}

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

module.exports = { RESOURCES, OPERATIONS, LOCK_OPERATIONS, TRIGGER_ENTITY_TYPES, wrapBody, operationsOf, needsId, needsParent, pathOf, counterValueBody };
