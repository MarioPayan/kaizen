import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSkillFile } from '../api';
import type { Skill, State } from '../types';
import { Chip, Empty } from '../components/ui';

/**
 * A browser over the skills as they are on disk.
 *
 * Nothing is imported or copied — the markdown shown here is read from the file
 * the moment it is asked for, so a skill edited in an editor is current with no
 * sync step and no second copy to drift.
 */

function health(skill: Skill) {
  if (skill.kind === 'library') {
    return skill.suggestions >= 5 ? (['hot spot', 'rust'] as const) : (['', 'neutral'] as const);
  }
  if (skill.scripts > 0 && skill.suggestions === 0) return ['scripted, quiet', 'accent'] as const;
  if (skill.per100 >= 2) return ['prose-heavy, noisy', 'rust'] as const;
  if (skill.per100 > 0) return ['watch', 'brass'] as const;
  return ['quiet', 'neutral'] as const;
}

function Viewer({ skill }: { skill: Skill }) {
  const file = useSkillFile(skill.path);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-2">
        <h3 className="font-mono text-sm font-bold">{skill.name}</h3>
        <Chip>{skill.kind}</Chip>
        {skill.scripts > 0 && <Chip tone="accent">{skill.scripts} scripts</Chip>}
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

  if (state.skills.length === 0) {
    return <Empty>No skills found in any configured target. Check Settings.</Empty>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="max-h-[32rem] overflow-auto border border-line">
        <table className="w-full text-left text-[0.8rem]">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              {['skill', 'lines', 'scr', 'open', '/100'].map((h) => (
                <th
                  key={h}
                  className="border-b border-line px-2.5 py-2 font-mono text-[0.62rem] tracking-widest uppercase text-ink-3"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.skills.map((s) => {
              const [label, tone] = health(s);
              return (
                <tr
                  key={s.path}
                  onClick={() => setSelected(s.path)}
                  className={`cursor-pointer border-b border-line-soft last:border-b-0 hover:bg-surface-2 ${
                    s.path === skill?.path ? 'bg-surface-2' : ''
                  }`}
                >
                  <td className="px-2.5 py-1.5">
                    <span className="font-mono text-xs">{s.name}</span>
                    {label && (
                      <span className="ml-1.5">
                        <Chip tone={tone}>{label}</Chip>
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.lines}</td>
                  <td
                    className={`px-2.5 py-1.5 text-right font-mono tabular-nums ${s.scripts ? 'font-bold text-accent' : ''}`}
                  >
                    {s.scripts}
                  </td>
                  <td
                    className={`px-2.5 py-1.5 text-right font-mono tabular-nums ${s.suggestions >= 8 ? 'font-bold text-rust' : ''}`}
                  >
                    {s.suggestions}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.per100}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="max-h-[32rem] border border-line bg-surface">{skill && <Viewer skill={skill} />}</div>

      {state.orphans.length > 0 && (
        <p className="text-xs text-ink-3 lg:col-span-2">
          {state.orphans.length} feedback folders name skills that no longer exist —{' '}
          <span className="font-mono">{state.orphans.join(', ')}</span>. A triage pass remaps them to their
          successor or archives them; they are never deleted.
        </p>
      )}
    </div>
  );
}
