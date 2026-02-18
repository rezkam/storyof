/**
 * Typed error classes for the engine layer.
 *
 * Callers can distinguish error conditions with instanceof checks rather than
 * fragile message-string matching.
 */

export class EngineError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "EngineError";
		this.code = code;
		Error.captureStackTrace(this, this.constructor);
	}
}

/**
 * Thrown when an operation requires an active session but none exists.
 * E.g. chat() or changeModel() called when the engine is stopped.
 */
export class EngineNotRunningError extends EngineError {
	constructor(operation: string) {
		super(`Cannot ${operation} — no active session`, "ENGINE_NOT_RUNNING");
		this.name = "EngineNotRunningError";
	}
}

/**
 * Thrown when the requested model ID / provider combination is not found
 * in the model registry.
 */
export class ModelNotFoundError extends EngineError {
	readonly provider: string;
	readonly modelId: string;

	constructor(provider: string, modelId: string) {
		super(`Model not found: ${provider}/${modelId}`, "MODEL_NOT_FOUND");
		this.name = "ModelNotFoundError";
		this.provider = provider;
		this.modelId = modelId;
	}
}

/**
 * Thrown when a required static asset (e.g. ui.html) cannot be located
 * in any of the expected search paths.
 */
export class EngineAssetNotFoundError extends EngineError {
	readonly asset: string;

	constructor(asset: string) {
		super(`${asset} not found`, "ASSET_NOT_FOUND");
		this.name = "EngineAssetNotFoundError";
		this.asset = asset;
	}
}
