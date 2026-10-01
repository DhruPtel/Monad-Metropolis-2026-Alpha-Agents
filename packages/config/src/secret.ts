const REDACTED = "[redacted]";

/**
 * Holds a secret value so it cannot reach a log by accident: string conversion,
 * JSON.stringify and util.inspect all print "[redacted]". Call reveal() only at
 * the point of use, such as building a request.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${REDACTED})`;
  }
}
