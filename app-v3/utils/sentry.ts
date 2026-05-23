import {
	BrowserClient,
	defaultStackParser,
	getDefaultIntegrations,
	makeFetchTransport,
	Scope,
} from "@sentry/browser";
import { installIdStorage } from "./storage";

type ContextName = "background" | "options" | "content";

export type WebhookErrorKind = "failed_to_fetch" | "http_error" | "unknown";

export interface ClassifiedWebhookError {
	kind: WebhookErrorKind;
	message: string;
	httpStatus?: number;
}

const scopeByContext = new Map<ContextName, Scope>();

function getManifestVersion(): string {
	try {
		return browser.runtime.getManifest().version;
	} catch {
		return "0.0.0";
	}
}

function getDsn(): string {
	return import.meta.env.WXT_SENTRY_DSN?.trim() ?? "";
}

function getEnvironment(): string {
	return import.meta.env.WXT_SENTRY_ENVIRONMENT?.trim() || "development";
}

function getRelease(): string {
	const explicitRelease = import.meta.env.WXT_SENTRY_RELEASE?.trim();
	if (explicitRelease) return explicitRelease;
	return `upwork-job-scraper@${getManifestVersion()}`;
}

function getTracesSampleRate(): number {
	const raw = import.meta.env.WXT_SENTRY_TRACES_SAMPLE_RATE;
	if (!raw) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0;
	return parsed;
}

function getEnableLogs(): boolean {
	return import.meta.env.WXT_SENTRY_ENABLE_LOGS === "true";
}

function createScope(context: ContextName): Scope | null {
	const dsn = getDsn();
	if (!dsn) return null;

	const integrations = getDefaultIntegrations({}).filter((integration) => {
		return !["BrowserApiErrors", "Breadcrumbs", "GlobalHandlers"].includes(
			integration.name,
		);
	});

	const client = new BrowserClient({
		dsn,
		transport: makeFetchTransport,
		stackParser: defaultStackParser,
		integrations,
		environment: getEnvironment(),
		release: getRelease(),
		tracesSampleRate: getTracesSampleRate(),
		enableLogs: getEnableLogs(),
		beforeSend(event) {
			event.tags = {
				...event.tags,
				extension_context: context,
			};
			return event;
		},
	});

	const scope = new Scope();
	scope.setClient(client);
	scope.setTag("extension_context", context);
	scope.setTag("extension_version", getManifestVersion());
	client.init();
	return scope;
}

export function initSentryContext(context: ContextName): boolean {
	if (scopeByContext.has(context)) return true;
	const scope = createScope(context);
	if (!scope) return false;
	scopeByContext.set(context, scope);
	void attachInstallId(scope, context);
	return true;
}

async function attachInstallId(
	scope: Scope,
	context: ContextName,
): Promise<void> {
	try {
		let id = await installIdStorage.getValue();
		if (!id) {
			if (context !== "background") return;
			id = generateInstallId();
			await installIdStorage.setValue(id);
		}
		scope.setUser({ id });
	} catch {
		// Storage errors must not break Sentry init; user attribution is optional.
	}
}

function generateInstallId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getScope(context: ContextName): Scope | null {
	if (!scopeByContext.has(context)) {
		initSentryContext(context);
	}
	return scopeByContext.get(context) ?? null;
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error(String(error));
}

function toMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function createEventScope(scope: Scope, meta?: Record<string, unknown>): Scope {
	const eventScope = scope.clone();
	if (!meta) return eventScope;

	for (const [key, value] of Object.entries(meta)) {
		if (key === "fingerprint") continue;
		eventScope.setExtra(key, value);
	}

	const stage = meta.stage;
	if (typeof stage === "string" && stage.trim()) {
		eventScope.setTag("stage", stage.trim());
	}

	const fingerprint = meta.fingerprint;
	if (
		Array.isArray(fingerprint) &&
		fingerprint.every((part) => typeof part === "string")
	) {
		eventScope.setFingerprint(fingerprint as string[]);
	}

	return eventScope;
}

export function classifyWebhookError(args: {
	response?: { ok: boolean; status: number };
	error?: unknown;
}): ClassifiedWebhookError {
	if (args.response && !args.response.ok) {
		return {
			kind: "http_error",
			message: `HTTP ${args.response.status}`,
			httpStatus: args.response.status,
		};
	}

	if (args.error !== undefined) {
		const message = toMessage(args.error);
		if (/Failed to fetch|NetworkError when attempting to fetch/i.test(message)) {
			return {
				kind: "failed_to_fetch",
				message,
			};
		}

		const httpMatch = /HTTP\s+(\d{3})/i.exec(message);
		if (httpMatch) {
			return {
				kind: "http_error",
				message,
				httpStatus: Number(httpMatch[1]),
			};
		}

		return {
			kind: "unknown",
			message,
		};
	}

	return {
		kind: "unknown",
		message: "Unknown webhook error",
	};
}

export function captureContextException(
	context: ContextName,
	error: unknown,
	meta?: Record<string, unknown>,
): void {
	const scope = getScope(context);
	if (!scope) return;

	const eventScope = createEventScope(scope, meta);
	eventScope.captureException(toError(error));
}

export function captureContextMessage(
	context: ContextName,
	message: string,
	meta?: Record<string, unknown>,
): void {
	const scope = getScope(context);
	if (!scope) return;

	const eventScope = createEventScope(scope, meta);
	eventScope.captureMessage(message);
}
