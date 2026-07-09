import type { JsonSchemaDescriptor } from "./ports/llm-provider.js";

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
}

export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export function validateStructuredResponse(
  value: unknown,
  schema: JsonSchemaDescriptor,
  path = "$",
): ValidationResult {
  const errors: string[] = [];

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return { ok: false, errors };
    }

    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const child = validateStructuredResponse(record[key], childSchema, `${path}.${key}`);
        errors.push(...child.errors);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return { ok: false, errors };
    }
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        const child = validateStructuredResponse(item, schema.items, `${path}[${index}]`);
        errors.push(...child.errors);
      }
    }
  } else if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path}: expected string`);
  } else if (schema.type === "number" && typeof value !== "number") {
    errors.push(`${path}: expected number`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: expected boolean`);
  }

  return { ok: errors.length === 0, errors };
}
