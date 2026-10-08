'use strict';

const crypto = require('crypto');

/** Header of the push commands, HMAC-SHA256 (hex) of the raw body with the bridge secret. */
const SIGNATURE_HEADER = 'x-iw-signature';
const COMMAND_TYPE = 'iw_lock_command';
/** Age of a command without "valid_seconds" (push), and the clock difference allowed on top. */
const MAX_AGE_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 30;
const LOCK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,190}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const LOCK_STATES = ['locked', 'unlocked', 'open', 'locking', 'unlocking', 'opening', 'jammed', 'unavailable', 'unknown'];

function sign(body, secret) {
	return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function verifySignature(body, signature, secret) {
	if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature) || !secret) {
		return false;
	}
	const expected = Buffer.from(sign(body, secret), 'hex');
	return crypto.timingSafeEqual(expected, Buffer.from(signature.toLowerCase(), 'hex'));
}

function randomInstanceId() {
	return `nr-${crypto.randomBytes(12).toString('hex')}`;
}

function randomSecret() {
	return crypto.randomBytes(32).toString('hex');
}

/**
 * Remembers the nonces of the last MAX_AGE_SECONDS, so a recorded push command cannot be replayed.
 */
class NonceCache {
	constructor(maxAgeSeconds = MAX_AGE_SECONDS) {
		this.maxAgeMs = maxAgeSeconds * 1000;
		this.seen = new Map();
	}

	/** @returns {boolean} false when the nonce was used before */
	use(nonce, now = Date.now()) {
		for (const [key, expires] of this.seen) {
			if (expires <= now) {
				this.seen.delete(key);
			}
		}
		if (this.seen.has(nonce)) {
			return false;
		}
		this.seen.set(nonce, now + this.maxAgeMs * 2);
		return true;
	}
}

/**
 * Checks a push command of the ERP.
 *
 * @returns {{ok: true, command: object}|{ok: false, status: number, error: string}}
 */
function verifyPushCommand({ rawBody, signature, secret, instanceId, nonces, now = Date.now() }) {
	if (!verifySignature(rawBody, signature, secret)) {
		return { ok: false, status: 401, error: 'invalid signature' };
	}
	let command;
	try {
		command = JSON.parse(rawBody);
	} catch (error) {
		return { ok: false, status: 400, error: 'invalid JSON body' };
	}
	if (!command || command.type !== COMMAND_TYPE || command.instance_id !== instanceId) {
		return { ok: false, status: 400, error: 'not a lock command of this instance' };
	}
	// a door must not open long after the user tapped "open"
	const age = now / 1000 - command.ts;
	const validSeconds = typeof command.valid_seconds === 'number' ? command.valid_seconds : MAX_AGE_SECONDS;
	if (typeof command.ts !== 'number' || age > validSeconds + CLOCK_SKEW_SECONDS || age < -CLOCK_SKEW_SECONDS) {
		return { ok: false, status: 400, error: 'command expired', command };
	}
	if (typeof command.nonce !== 'string' || command.nonce === '' || !nonces.use(command.nonce, now)) {
		return { ok: false, status: 400, error: 'command replayed' };
	}
	return { ok: true, command };
}

/**
 * Commands waiting for an "inwendo erp lock result" node, shared by all nodes of the runtime.
 */
const pendingResults = new Map();

function waitForResult(key, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pendingResults.delete(key);
			resolve({ success: false, message: 'no result within ' + Math.round(timeoutMs / 1000) + ' s' });
		}, timeoutMs);
		pendingResults.set(key, (result) => {
			clearTimeout(timer);
			pendingResults.delete(key);
			resolve(result);
		});
	});
}

/** @returns {boolean} whether a command was waiting for this result */
function resolveResult(key, result) {
	const resolver = pendingResults.get(key);
	if (!resolver) {
		return false;
	}
	resolver(result);
	return true;
}

module.exports = {
	SIGNATURE_HEADER,
	COMMAND_TYPE,
	MAX_AGE_SECONDS,
	CLOCK_SKEW_SECONDS,
	LOCK_ID_PATTERN,
	INSTANCE_ID_PATTERN,
	LOCK_STATES,
	sign,
	verifySignature,
	randomInstanceId,
	randomSecret,
	NonceCache,
	verifyPushCommand,
	waitForResult,
	resolveResult,
};
