// PostgREST defaults to the public schema when these optional headers are absent.
// Omit only that redundant value for compatibility with the initial relay CORS list.
// Keep bearer/apikey, body, method, signal and all other headers unchanged.
export function gatewayFetch(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  for (const name of ['accept-profile', 'content-profile']) {
    if (headers.get(name) === 'public') headers.delete(name);
  }
  return fetch(input, {...init, headers});
}
