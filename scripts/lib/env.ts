export function requiredEnv(name: string, { allowPlaceholder = false }: { allowPlaceholder?: boolean } = {}) {
  const value = process.env[name];
  if (!value || (!allowPlaceholder && value.startsWith("replace_"))) throw new Error(`missing ${name}`);
  return value;
}
