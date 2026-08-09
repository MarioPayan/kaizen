import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { Config, State, Status, Suggestion } from './types';

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
    const { error, errors } = body as { error?: string; errors?: string[] };
    const err = new Error(error ?? `request failed (${res.status})`) as Error & { fields?: string[] };
    // Config validation refuses per field. Keeping the list intact is what lets
    // the form put each message under the control that caused it.
    if (errors) err.fields = errors;
    throw err;
  }
  return body as T;
}

export function useKaizenState() {
  return useQuery({
    queryKey: ['state'],
    queryFn: () => request<State>('/api/state'),
    // The server pushes when the files change (see useLiveUpdates). This stays
    // as the backstop for when it cannot — an old Node without recursive watch,
    // or a stream that dropped and has not reconnected yet.
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

/**
 * Subscribe to the server's file watcher. Returns whether it is actually live.
 *
 * "Live" means the server reported directories it is watching, not that the
 * socket opened. Where recursive watch is unavailable the stream connects fine
 * and watches nothing, and a green dot there would be a lie.
 */
export function useLiveUpdates(): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // jsdom has no EventSource, and neither does an old browser. Both should
    // fall back to refetch-on-focus rather than throw on mount.
    if (typeof EventSource === 'undefined') return;

    const es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      const { watching } = JSON.parse((e as MessageEvent<string>).data) as { watching: string[] };
      setConnected(watching.length > 0);
    });
    es.addEventListener('change', () => {
      void qc.invalidateQueries({ queryKey: ['state'] });
    });
    // No reconnect logic on purpose: EventSource reconnects itself on the
    // interval the server sends as `retry`, and the next `hello` flips this
    // back. A backoff loop here would fight it.
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [qc]);

  return connected;
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

/**
 * A mutation that refreshes state when it lands, and optionally shows its result
 * before it does.
 *
 * `optimistic` patches the cached state immediately and is rolled back verbatim
 * if the server refuses. The refusals here are specific and worth reading — a
 * dirty tree names the files — so `onError` restores and rethrows rather than
 * swallowing.
 */
function useInvalidating<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  optimistic?: (state: State, args: TArgs) => State,
): UseMutationResult<TResult, Error, TArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: optimistic
      ? async (args: TArgs) => {
          // An in-flight refetch landing after the patch would overwrite it.
          await qc.cancelQueries({ queryKey: ['state'] });
          const previous = qc.getQueryData<State>(['state']);
          if (previous) qc.setQueryData<State>(['state'], optimistic(previous, args));
          return { previous };
        }
      : undefined,
    onError: (_e, _args, context) => {
      const previous = (context as { previous?: State } | undefined)?.previous;
      if (previous) qc.setQueryData<State>(['state'], previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['state'] });
    },
  });
}

/**
 * Patch the status of whichever suggestions `match` picks out.
 *
 * Only `status` moves. The header counts and cluster scores stay briefly stale
 * until the refetch lands, which is honest — recomputing the scanner's metrics
 * in the browser to shave 200ms off a number nobody is watching is the wrong trade.
 */
const patchStatus =
  (match: (s: Suggestion) => boolean) =>
  (state: State, { status }: { status: Status }): State => ({
    ...state,
    suggestions: state.suggestions.map((s) => (match(s) ? { ...s, status } : s)),
  });

export function useSetStatus() {
  return useInvalidating(
    ({ id, status }: { id: string; status: Status }) =>
      request<{ id: string; status: Status }>('/api/suggestion', {
        method: 'POST',
        body: JSON.stringify({ id, status }),
      }),
    (state, args) => patchStatus((s) => s.id === args.id)(state, args),
  );
}

/** Approving a cluster is one decision, so it is one request. */
export function useSetClusterStatus() {
  return useInvalidating(
    ({ id, status }: { id: string; status: Status }) =>
      request<{ id: string; status: Status; updated: number }>('/api/cluster', {
        method: 'POST',
        body: JSON.stringify({ id, status }),
      }),
    (state, args) => {
      const members = new Set(state.clusters.find((c) => c.id === args.id)?.members ?? []);
      return patchStatus((s) => members.has(s.id))(state, args);
    },
  );
}

/**
 * Deliberately not optimistic. Applying produces a commit sha and can fail on any
 * of three guards — a fake `applied` would be a lie about the state of git.
 */
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
