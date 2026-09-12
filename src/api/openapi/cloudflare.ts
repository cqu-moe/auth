const UNSUPPORTED = new Set([
  "unevaluatedProperties",
  "dependentSchemas",
  "dependentRequired",
  "$dynamicRef",
  "$dynamicAnchor",
]);

export function toCloudflareSchema(
  schema: Record<string, unknown>,
  pointer: string
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED.has(key)) throw new Error(`Unsupported OpenAPI 3.1 keyword at ${pointer}/${key}`);
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
