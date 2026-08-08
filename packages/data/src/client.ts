import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { Config, State, Status } from './types';

/**
 * The server returns `{ error }` with a real status code for every refusal, and
 * those refusals are the interesting cases — a read-only target, a dirty tree, a
 * missing patch. Surfacing the server's own wording beats inventing a generic one.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${res.status}: response was not JSON`);
  }
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function useKaizenState() {
  return useQuery({
    queryKey: ['state'],
    queryFn: () => request<State>('/api/state'),
    // The underlying files change when a skill runs, not on a timer. Refetching
    // on focus covers the real case without polling a directory all day.
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => request<{ config: Config; errors: string[] }>('/api/config'),
  });
}

export function useSkillFile(path: string | null) {
  return useQuery({
    queryKey: ['skill', path],
    enabled: Boolean(path),
    queryFn: () => request<{ path: string; content: string }>(`/api/skill?path=${encodeURIComponent(path!)}`),
  });
}

export function useDiff(id: string | null) {
  return useQuery({
    queryKey: ['diff', id],
    enabled: Boolean(id),
    queryFn: () => request<{ id: string; patch: string | null }>(`/api/diff?id=${encodeURIComponent(id!)}`),
  });
}

function useInvalidating<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
): UseMutationResult<TResult, Error, TArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['state'] });
    },
  });
}

export function useSetStatus() {
  return useInvalidating(({ id, status }: { id: string; status: Status }) =>
    request<{ id: string; status: Status }>('/api/suggestion', {
      method: 'POST',
      body: JSON.stringify({ id, status }),
    }),
  );
}

/** Approving a cluster is one decision, so it is one request. */
export function useSetClusterStatus() {
  return useInvalidating(({ id, status }: { id: string; status: Status }) =>
    request<{ id: string; status: Status; updated: number }>('/api/cluster', {
      method: 'POST',
      body: JSON.stringify({ id, status }),
    }),
  );
}

export function useApply() {
  return useInvalidating(({ id }: { id: string }) =>
    request<{ id: string; sha: string }>('/api/apply', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  );
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Config) =>
      request<{ config: Config }>('/api/config', { method: 'POST', body: JSON.stringify(config) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config'] });
      void qc.invalidateQueries({ queryKey: ['state'] });
    },
  });
}
