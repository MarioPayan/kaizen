import { useSetClusterStatus } from '../api';
import type { Cluster, State } from '../types';
import { Button, Chip, Empty, ErrorNote, Panel } from '../components/ui';

/**
 * The view the work actually happens in.
 *
 * Seven suggestions that share one fix are one decision, not seven. Requiring a
 * click per row is how a backlog stops being drained — which is the failure this
 * whole tool exists to correct, so it should not be reintroduced in the UI.
 */
function ClusterCard({ cluster, state }: { cluster: Cluster; state: State }) {
  const setStatus = useSetClusterStatus();
  const members = state.suggestions.filter((s) => cluster.members.includes(s.id));
  const approved = members.filter((m) => m.status === 'approved').length;

  return (
    <Panel>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-mono text-[0.95rem] font-bold tracking-tight">{cluster.id}</h3>
        <span className="flex gap-1.5">
          {cluster.pinned && <Chip tone="accent">pinned</Chip>}
          {cluster.promoted ? (
            <Chip tone="rust" title="Must be fixed at rung 0 or 1, not by patching one skill">
              promoted — fix at rung 0/1
            </Chip>
          ) : (
            <Chip>below threshold</Chip>
          )}
        </span>
      </div>

      <p className="mt-2 text-sm text-ink-2">
        <span className="font-mono">{cluster.size}</span> suggestions ·{' '}
        <span className="font-mono font-bold text-rust tabular-nums">{cluster.incidents}</span> incidents ·
        score <span className="font-mono tabular-nums">{cluster.score}</span>
        {cluster.spanDays > 0 && (
          <>
            {' '}
            · <span className="font-mono">{cluster.spanDays}d</span> unresolved
          </>
        )}
      </p>

      <p className="mt-1 font-mono text-xs text-ink-3">
        {cluster.first}
        {cluster.last !== cluster.first && ` → ${cluster.last}`} · {cluster.skills.join(', ')}
      </p>

      {cluster.scopes.length > 0 && (
        <p className="mt-2 text-sm">
          <Chip tone="accent">targets</Chip>{' '}
          <span className="font-mono text-xs">{cluster.scopes.join(', ')}</span>
        </p>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer font-mono text-xs text-ink-3 hover:text-ink">
          {cluster.size} members
        </summary>
        <ul className="mt-2 flex flex-col gap-1">
          {members.map((m) => (
            <li key={m.id} className="flex items-baseline gap-2 font-mono text-xs">
              <span className="text-ink-3">{m.skill}/</span>
              <span className="truncate">{m.slug}</span>
              {m.incidents > 1 && <Chip tone="rust">&times;{m.incidents}</Chip>}
            </li>
          ))}
        </ul>
      </details>

      <ErrorNote error={setStatus.error} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={setStatus.isPending || approved === members.length}
          onClick={() => setStatus.mutate({ id: cluster.id, status: 'approved' })}
        >
          Approve cluster ({cluster.size})
        </Button>
        <Button
          tone="ghost"
          disabled={setStatus.isPending}
          onClick={() => setStatus.mutate({ id: cluster.id, status: 'rejected' })}
        >
          Reject all
        </Button>
        {approved > 0 && (
          <span className="font-mono text-xs text-accent-ink">
            {approved}/{members.length} approved
          </span>
        )}
      </div>
    </Panel>
  );
}

export default function Clusters({ state }: { state: State }) {
  const grouped = state.clusters.filter((c) => c.size > 1);
  const singles = state.clusters.length - grouped.length;

  return (
    <div>
      <p className="mb-4 text-sm text-ink-2">
        Approving a cluster approves every member as one fix. A promoted cluster has already proved that prose
        failed repeatedly there, so its fix must land as a hook or a script — not as another paragraph.
      </p>

      {grouped.length === 0 ? (
        <Empty>No suggestion has been filed twice yet. That is a good state.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map((c) => (
            <ClusterCard key={c.id} cluster={c} state={state} />
          ))}
        </div>
      )}

      {singles > 0 && (
        <p className="mt-4 font-mono text-xs text-ink-3">
          + {singles} one-off suggestions, in the Queue tab.
        </p>
      )}
    </div>
  );
}
