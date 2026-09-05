/** POSIX-shell quote for commands displayed to the user. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
