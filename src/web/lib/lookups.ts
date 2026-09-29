import { useEffect, useState } from 'react';
import type { LookupsResponse } from '../../shared/api-types.ts';
import { api } from './api.ts';

// Form vocabularies. Cached on the device so the job form still works offline.
const CACHE_KEY = 'ahc.lookups.v1';
let inflight: Promise<LookupsResponse> | null = null;

function cached(): LookupsResponse | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as LookupsResponse) : null;
  } catch {
    return null;
  }
}

function load(): Promise<LookupsResponse> {
  inflight ??= api<LookupsResponse>('/api/lookups')
    .then((data) => {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch {
        // storage full or blocked: fine, just not cached
      }
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useLookups(): LookupsResponse | null {
  const [value, setValue] = useState<LookupsResponse | null>(cached);
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => alive && setValue(data))
      .catch(() => {
        // offline: keep the cached copy
      });
    return () => {
      alive = false;
    };
  }, []);
  return value;
}
