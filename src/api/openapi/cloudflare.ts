const UNSUPPORTED = new Set([
  "unevaluatedProperties",
  "dependentSchemas",
  "dependentRequired",
  "$dynamicRef",
  "$dynamicAnchor",
]);

const BETTER_AUTH_STRING_ARRAY_PROPERTIES = new Set([
  "contacts",
  "grant_types",
  "post_logout_redirect_uris",
  "redirect_uris",
  "response_types",
  "scopes",
]);

export function toCloudflareSchema(
  schema: Record<string, unknown>,
  pointer: string
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key)) throw new Error(`Unsupported OpenAPI 3.1 keyword at ${pointer}/${key}`);
    if (key === "pattern" || key === "uniqueItems") continue;
    // Zod 4 records emit this 3.1 annotation; JSON object keys are already
    // strings. Preserve fail-closed behavior for genuinely constrained keys.
    if (key === "propertyNames") {
      if (value && typeof value === "object" &&
          Object.keys(value).every(key => ["type", "description", "title"].includes(key)) &&
          ((value as { type?: unknown }).type === undefined || (value as { type?: unknown }).type === "string")) continue;
      throw new Error(`Unsupported constrained propertyNames at ${pointer}`);
    }
    if (key === "$ref" && typeof value === "string" && !value.startsWith("#/")) {
      throw new Error(`External reference at ${pointer}/$ref`);
    }
    if (key === "const") {
      output.enum = [value];
      continue;
    }
    if (key === "exclusiveMinimum" && typeof value === "number") {
      output.minimum = value;
      output.exclusiveMinimum = true;
      continue;
    }
    if (key === "exclusiveMaximum" && typeof value === "number") {
      output.maximum = value;
      output.exclusiveMaximum = true;
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((entry) => entry !== "null");
      if (value.includes("null")) output.nullable = true;
      if (types.length === 1) output.type = types[0];
      else if (types.length > 1) output.anyOf = types.map((type) => ({ type }));
      continue;
    }
    if (key === "anyOf" && Array.isArray(value)) {
      const nullBranches = value.filter((entry) =>
        entry && typeof entry === "object" &&
        (entry as Record<string, unknown>).type === "null"
      );
      const nonNullBranches = value.filter((entry) => !nullBranches.includes(entry));
      if (nullBranches.length === 1 && nonNullBranches.length === 1 &&
          nonNullBranches[0] && typeof nonNullBranches[0] === "object") {
        Object.assign(output, toCloudflareSchema(
          nonNullBranches[0] as Record<string, unknown>,
          `${pointer}/anyOf/0`
        ));
        output.nullable = true;
        continue;
      }
    }
    if (Array.isArray(value)) {
      output[key] = value.map((entry, index) =>
        entry && typeof entry === "object"
          ? toCloudflareSchema(entry as Record<string, unknown>, `${pointer}/${key}/${index}`)
          : entry
      );
    } else if (value && typeof value === "object") {
      output[key] = toCloudflareSchema(value as Record<string, unknown>, `${pointer}/${key}`);
    } else output[key] = value;
  }
  if (output.type === "array" && !("items" in output)) {
    const property = pointer.split("/").at(-1) ?? "";
    if (!BETTER_AUTH_STRING_ARRAY_PROPERTIES.has(property)) {
      throw new Error(`Array schema missing items at ${pointer}`);
    }
    output.items = { type: "string" };
  }
  return output;
}

export function buildCloudflareSchema(document: Record<string, unknown>) {
  const converted = toCloudflareSchema(document, "#");
  converted.openapi = "3.0.3";
  const paths = converted.paths as Record<string, Record<string, any>> | undefined;
  for (const pathItem of Object.values(paths ?? {})) {
    for (const operation of Object.values(pathItem)) {
      if (!operation || typeof operation !== "object" || !operation.requestBody?.content) {
        continue;
      }
      const json = operation.requestBody.content["application/json"];
      if (json) operation.requestBody.content = { "application/json": json };
      else delete operation.requestBody;
    }
  }
  return converted;
}
