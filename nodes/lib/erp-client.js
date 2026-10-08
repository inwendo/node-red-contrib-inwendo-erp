'use strict';

/**
 * HTTP client for the inwendo ERP API (API token login, same as the n8n node).
 *
 * Every request sends X-IW-Trigger-Source: nodered so the ERP does not report changes made by
 * Node-RED back to the Node-RED webhooks (no trigger -> flow -> update -> trigger loop).
 */

const TRIGGER_SOURCE = 'nodered';
const DEFAULT_TIMEOUT_MS = 30000;
/** Safety net for list endpoints that do not report their page count. */
const MAX_PAGES_WITHOUT_COUNT = 1000;

class InwendoErpError extends Error {
	constructor(message, { statusCode, erpCode, erpDetails, body } = {}) {
		super(message);
		this.name = 'InwendoErpError';
		this.statusCode = statusCode;
		this.erpCode = erpCode;
		this.erpDetails = erpDetails;
		this.body = body;
	}
}

function normalizeHost(host) {
	const value = String(host || '').trim().replace(/\/+$/, '');
	if (!value) {
		throw new InwendoErpError('inwendo ERP host is not configured');
	}
	return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function buildUrl(host, path, qs) {
	const url = new URL(`${normalizeHost(host)}${path.startsWith('/') ? path : `/${path}`}`);
	for (const [key, value] of Object.entries(qs || {})) {
		if (value !== undefined && value !== null && value !== '') {
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

/**
 * The ERP answers errors with a generic body and puts the real reason into the
 * X-IW-ERROR-CODE / X-IW-ERROR-JSON headers.
 */
function errorFromResponse(response, bodyText) {
	const erpCode = response.headers.get('x-iw-error-code') || undefined;
	const erpDetails = response.headers.get('x-iw-error-json') || undefined;
	let message = `inwendo ERP request failed with HTTP ${response.status}`;
	if (erpCode) {
		message = `inwendo ERP error ${erpCode}`;
	}
	if (erpDetails) {
		message += `: ${erpDetails}`;
	}
	return new InwendoErpError(message, {
		statusCode: response.status,
		erpCode: erpCode !== undefined ? Number(erpCode) : undefined,
		erpDetails,
		body: bodyText,
	});
}

class ErpClient {
	/**
	 * @param {{host: string, apiToken: string, timeout?: number, fetch?: Function}} options
	 */
	constructor({ host, apiToken, timeout, fetch: fetchImpl }) {
		this.host = host;
		this.apiToken = apiToken;
		this.timeout = timeout || DEFAULT_TIMEOUT_MS;
		this.fetch = fetchImpl || globalThis.fetch;
	}

	/**
	 * @returns {Promise<{status: number, headers: Headers, body: any}>}
	 */
	async requestFull(method, path, { body, qs, binary = false, timeout } = {}) {
		if (!this.apiToken) {
			throw new InwendoErpError('inwendo ERP API token is not configured');
		}
		const headers = {
			'x-iw-jwt-token': this.apiToken,
			'X-IW-Trigger-Source': TRIGGER_SOURCE,
			Accept: binary ? '*/*' : 'application/json',
		};
		const options = { method, headers };
		if (body !== undefined && body !== null && method !== 'GET') {
			headers['Content-Type'] = 'application/json';
			options.body = typeof body === 'string' ? body : JSON.stringify(body);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout || this.timeout);
		options.signal = controller.signal;
		let response;
		try {
			response = await this.fetch(buildUrl(this.host, path, qs), options);
		} catch (error) {
			const reason = error && error.name === 'AbortError' ? 'timeout' : (error && error.message) || String(error);
			throw new InwendoErpError(`inwendo ERP request failed: ${reason}`);
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw errorFromResponse(response, text);
		}
		if (binary) {
			return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
		}
		const text = await response.text();
		let parsed = text;
		if (text !== '') {
			try {
				parsed = JSON.parse(text);
			} catch (error) {
				parsed = text;
			}
		}
		return { status: response.status, headers: response.headers, body: parsed };
	}

	async request(method, path, options) {
		return (await this.requestFull(method, path, options)).body;
	}

	/**
	 * All items of a list endpoint. Pages are 0-based; with withMaxPageNumber the ERP reports the
	 * number of pages in X-IW-MAX-PAGES, otherwise the pages are read until one comes back empty.
	 */
	async requestAllItems(path, qs) {
		const items = [];
		const query = { ...(qs || {}), withMaxPageNumber: 'nodered' };
		let maxPages = MAX_PAGES_WITHOUT_COUNT;
		for (let page = 0; page < maxPages; page++) {
			const response = await this.requestFull('GET', path, { qs: { ...query, page: String(page) } });
			const body = response.body;
			const pageItems = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
			if (pageItems === null) {
				items.push(body);
				break; // not a list endpoint
			}
			items.push(...pageItems);
			if (page === 0) {
				const reported = parseInt(response.headers.get('x-iw-max-pages') || '', 10);
				if (reported >= 1) {
					maxPages = reported;
				}
			}
			if (pageItems.length === 0) {
				break;
			}
		}
		return items;
	}
}

module.exports = { ErpClient, InwendoErpError, normalizeHost, buildUrl, TRIGGER_SOURCE };
