import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { collapsedWorktrees, skillHealth, useSkillFile, type Skill, type State } from '@kaizen/data';
import { Chip, Empty, Help, RowTrigger, Table, Td, Th, Tr, type Tone } from '@kaizen/ui';

/**
 * A browser over the skills as they are on disk. Nothing is imported or copied —
 * the markdown is read at the moment it is asked for, so a skill edited in an
 * editor is current here with no sync step and no second copy to drift.
 */

const HEALTH: Record<string, { label: string; tone: Tone }> = {
  scripted: { label: 'scripted, quiet', tone: 'accent' },
  noisy: { label: 'prose-heavy, noisy', tone: 'rust' },
  watch: { label: 'watch', tone: 'brass' },
  quiet: { label: 'quiet', tone: 'neutral' },
};

function Viewer({ skill }: { skill: Skill }) {
  const file = useSkillFile(skill.path);
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-2">
        <h3 className="font-mono text-sm font-bold">{skill.name}</h3>
        <Chip>{skill.kind}</Chip>
        {skill.scripts > 0 && <Chip tone="accent">{skill.scripts} scripts</Chip>}
        {(skill.worktrees ?? 0) > 0 && (
          <Chip title="Worktrees hold the same file; they are counted once">
            {skill.worktrees} worktrees collapsed
          </Chip>
        )}
        <span className="font-mono text-xs text-ink-3">{skill.lines} lines</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {file.isLoading && <p className="text-sm text-ink-3">loading…</p>}
        {file.error && <p className="font-mono text-xs text-rust">{(file.error as Error).message}</p>}
        {file.data && (
          <article className="prose-skill">
            <Markdown remarkPlugins={[remarkGfm]}>{file.data.content}</Markdown>
          </article>
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 font-mono text-[0.68rem] break-all text-ink-3">
        {skill.path}
      </p>
    </div>
  );
}

export default function Skills({ state }: { state: State }) {
  const [selected, setSelected] = useState<string | null>(state.skills[0]?.path ?? null);
  const skill = state.skills.find((s) => s.path === selected) ?? state.skills[0];
  const collapsed = collapsedWorktrees(state);

  if (state.skills.length === 0) {
    return <Empty>No skills found in any configured target. Check Settings.</Empty>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="max-h-[34rem] overflow-auto">
        <Table>
          <thead>
            <tr>
              <Th>skill</Th>
              <Th align="right">lines</Th>
              <Th align="right">scr</Th>
              <Th align="right">open</Th>
              <Th align="right">/100</Th>
            </tr>
          </thead>
          <tbody>
            {state.skills.map((s) => {
              const health = HEALTH[skillHealth(s)];
              return (
                <Tr key={s.path} selectable selected={s.path === skill?.path}>
                  <Td>
                    <RowTrigger onClick={() => setSelected(s.path)}>
                      <span className="font-mono text-xs">{s.name}</span>
                      {s.kind !== 'library' && health && (
                        <span className="ml-1.5">
                          <Chip tone={health.tone}>{health.label}</Chip>
                        </span>
                      )}
                    </RowTrigger>
                  </Td>
                  <Td numeric>{s.lines}</Td>
                  <Td numeric className={s.scripts ? 'font-bold text-accent' : ''}>
                    {s.scripts}
                  </Td>
                  <Td numeric className={s.suggestions >= 8 ? 'font-bold text-rust' : ''}>
                    {s.suggestions}
                  </Td>
                  <Td numeric>{s.per100}</Td>
                </Tr>
              );
            })}
          </tbody>
          {/*
            The ratio the whole system exists to move, sitting under the column it
            is the total of — the only place it is directly comparable with each
            skill's own number.
          */}
          <tfoot>
            <Tr>
              <Td className="font-mono text-xs text-ink-3">
                {state.metrics.proseLines.toLocaleString()} lines of instruction · {state.metrics.scriptCount}{' '}
                scripts
              </Td>
              <Td numeric>{state.metrics.proseLines}</Td>
              <Td numeric>{state.metrics.scriptCount}</Td>
              <Td numeric>{state.metrics.total}</Td>
              <Td numeric className="font-bold">
                <Help
                  content={
                    <>
                      Incidents per 100 lines of prose, across every skill. It should fall as fixes move down
                      the ladder. With project scanning on this counts skills that have never filed anything,
                      which dilutes it — reported rather than argued.
                    </>
                  }
                >
                  {state.metrics.incidentsPer100Lines}
                </Help>
              </Td>
            </Tr>
          </tfoot>
        </Table>
      </div>

      <div className="max-h-[34rem] border border-line bg-surface">{skill && <Viewer skill={skill} />}</div>

      <div className="flex flex-col gap-2 lg:col-span-2">
        {collapsed > 0 && (
          <p className="text-xs text-ink-3">
            {collapsed} git worktrees were collapsed into their main repository — they hold the same files, so
            listing them again would say nothing new.
          </p>
        )}
        {state.orphans.length > 0 && (
          <p className="text-xs text-ink-3">
            {state.orphans.length} feedback folders name skills that no longer exist —{' '}
            <span className="font-mono">{state.orphans.join(', ')}</span>. A triage pass remaps them to a
            successor or archives them; they are never deleted.
          </p>
        )}
      </div>
    </div>
  );
}
