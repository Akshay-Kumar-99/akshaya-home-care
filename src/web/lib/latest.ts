import { useCallback, useRef } from 'react';

/**
 * Guards a screen against out-of-order replies. When the user switches tabs or filters
 * quickly, an older, slower request can answer after the newer one and overwrite it
 * (e.g. the Open list landing under the Completed tab). Call `begin()` before each request
 * and apply the reply only if `isLatest()` is still true.
 */
export function useLatestRequest(): () => () => boolean {
  const counter = useRef(0);
  return useCallback(() => {
    const id = ++counter.current;
    return () => id === counter.current;
  }, []);
}
