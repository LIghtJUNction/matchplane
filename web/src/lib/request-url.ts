/** Parse only the query component of a Fetch API Request without reparsing its guaranteed URL. */
export function requestSearchParams(request: Request): URLSearchParams {
  const queryStart = request.url.indexOf("?");
  if (queryStart < 0) return new URLSearchParams();
  const fragmentStart = request.url.indexOf("#", queryStart + 1);
  const query = request.url.slice(
    queryStart + 1,
    fragmentStart < 0 ? undefined : fragmentStart,
  );
  return new URLSearchParams(query);
}

/** Read a Request origin at the one boundary that still needs an absolute URL. */
export function requestOrigin(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}
