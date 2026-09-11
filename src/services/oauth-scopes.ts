export function scopeSatisfies(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes("cqu:ticket:*");
}
