'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface Bot {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar?: string | null;
  source_provider?: string | null;
  template_id?: string | null;
  template_url?: string | null;
  import_schema_version?: string | null;
  import_operation_id?: string | null;
  import_timestamp?: number | null;
}

interface SkillStateDto {
  path: string | null;
  present: boolean;
  content: string | null;
  status: 'present' | 'absent' | 'unsupported';
}

interface SnapshotRow {
  id: string;
  bot_id: string;
  created_at: number;
  hash: string;
  transport?: string | null;
  snapshot: Record<string, string | string[] | boolean | null>;
}

interface ConfigData {
  bot: Bot;
  skill: SkillStateDto;
  currentHash: string;
  snapshots: SnapshotRow[];
}

type Phase = 'clean' | 'saving' | 'confirmed' | 'error';

const SNAPSHOT_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'description', label: 'Description (rules)' },
  { key: 'import_operation_id', label: 'Import operation ID' },
  { key: 'import_schema_version', label: 'Import schema version' },
  { key: 'memories', label: 'Remembered facts' },
  { key: 'name', label: 'Name' },
  { key: 'skill_content', label: 'Skill content' },
  { key: 'skill_path', label: 'Skill path' },
  { key: 'skill_present', label: 'Skill present' },
  { key: 'source_provider', label: 'Source provider' },
  { key: 'template_id', label: 'Template ID' },
  { key: 'template_url', label: 'Template URL' },
  { key: 'title', label: 'Title' },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

export default function BotConfigPage() {
  const params = useParams();
  const id = String((params as Record<string, string | string[]>).id ?? '');

  const [data, setData] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [rulesText, setRulesText] = useState<string | null>(null);
  const [rulesPhase, setRulesPhase] = useState<Phase>('clean');
  const [rulesError, setRulesError] = useState('');
  const [rulesConfirmedAt, setRulesConfirmedAt] = useState(0);

  const [skillEditing, setSkillEditing] = useState(false);
  const [skillText, setSkillText] = useState('');
  const [skillPhase, setSkillPhase] = useState<Phase>('clean');
  const [skillError, setSkillError] = useState('');
  const [skillConfirmedAt, setSkillConfirmedAt] = useState(0);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState('');

  function retryLoad(): void {
    setLoading(true);
    setLoadFailed(false);
    setReloadToken(token => token + 1);
  }

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/bots/${encodeURIComponent(id)}/config`)
      .then(async res => {
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          setData(null);
          return;
        }
        if (!res.ok) throw new Error('request failed');
        const config = (await res.json()) as ConfigData;
        if (cancelled) return;
        setData(config);
        setRulesText(config.bot.description ?? '');
        setNotFound(false);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadToken]);

  const storedRules = data?.bot.description ?? '';
  const rulesDirty = rulesText !== null && rulesText !== storedRules;
  const storedSkill = data?.skill.content ?? '';
  const skillDirty = skillEditing && skillText !== storedSkill;
  const anyDirty = rulesDirty || skillDirty;

  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyDirty]);

  function confirmLeave(e: React.MouseEvent): void {
    if (anyDirty && !window.confirm('You have unsaved changes. Leave without saving?')) {
      e.preventDefault();
    }
  }

  function flashCopied(key: string, text: string): void {
    copyText(text).then(ok => {
      if (!ok) return;
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(current => (current === key ? '' : current)), 2000);
    });
  }

  async function saveRules(): Promise<void> {
    if (!data || rulesText === null) return;
    setRulesPhase('saving');
    setRulesError('');
    try {
      const res = await fetch('/api/bots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.bot.id, description: rulesText }),
      });
      if (!res.ok) {
        let reason = 'request failed';
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) reason = body.error;
        } catch {
          // keep default reason
        }
        throw new Error(reason);
      }
      const refreshed = await fetch(`/api/bots/${encodeURIComponent(id)}/config`);
      if (!refreshed.ok) throw new Error('request failed');
      setData((await refreshed.json()) as ConfigData);
      setRulesPhase('confirmed');
      setRulesConfirmedAt(Date.now());
      setTimeout(() => {
        setRulesPhase(current => (current === 'confirmed' ? 'clean' : current));
      }, 5000);
    } catch (error) {
      setRulesPhase('error');
      setRulesError(error instanceof Error ? error.message : 'request failed');
    }
  }

  function discardRules(): void {
    setRulesText(storedRules);
    setRulesPhase('clean');
    setRulesError('');
  }

  function startSkillEdit(): void {
    setSkillText(data?.skill.content ?? '');
    setSkillEditing(true);
    setSkillPhase('clean');
    setSkillError('');
  }

  function discardSkill(): void {
    setSkillEditing(false);
    setSkillPhase('clean');
    setSkillError('');
  }

  async function saveSkill(): Promise<void> {
    if (!data) return;
    if (!skillText.trim() && !window.confirm('Delete this skill file?')) return;
    setSkillPhase('saving');
    setSkillError('');
    try {
      const res = await fetch(`/api/bots/${encodeURIComponent(id)}/skill`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: skillText }),
      });
      if (!res.ok) {
        let reason = 'request failed';
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) reason = body.error;
        } catch {
          // keep default reason
        }
        throw new Error(reason);
      }
      const updated = (await res.json()) as { skill: SkillStateDto; currentHash: string };
      setData(prev => (prev ? { ...prev, skill: updated.skill, currentHash: updated.currentHash } : prev));
      setSkillEditing(false);
      setSkillPhase('confirmed');
      setSkillConfirmedAt(Date.now());
      setTimeout(() => {
        setSkillPhase(current => (current === 'confirmed' ? 'clean' : current));
      }, 5000);
    } catch (error) {
      setSkillPhase('error');
      setSkillError(error instanceof Error ? error.message : 'request failed');
    }
  }

  if (notFound) {
    return (
      <div className="cfg-page flex items-center justify-center">
        <div className="text-center">
          <p className="mb-4">Bot not found.</p>
          <Link href="/" className="cfg-link">
            ← Back to chat
          </Link>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="cfg-page">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="h-6 w-32 rounded animate-pulse cfg-skel" />
          <div className="h-20 rounded-lg animate-pulse cfg-skel" />
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3 space-y-6">
              {[0, 1, 2].map(n => (
                <div key={n} className="h-48 rounded-lg animate-pulse cfg-skel" />
              ))}
            </div>
            <div className="lg:col-span-2">
              <div className="h-64 rounded-lg animate-pulse cfg-skel" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loadFailed && !data) {
    return (
      <div className="cfg-page">
        <div className="max-w-6xl mx-auto space-y-6">
          <Link href="/" className="cfg-link">
            ← Back to chat
          </Link>
          {['Skills', 'Rules', 'Template source', 'Launch snapshots'].map(section => (
            <div key={section} className="cfg-card">
              <h2 className="cfg-title mb-2">{section}</h2>
              <p className="text-sm cfg-muted">
                Couldn&apos;t load this section.{' '}
                <button onClick={retryLoad} className="cfg-link">
                  Retry
                </button>
              </p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { bot, skill, currentHash, snapshots } = data;
  const hasTemplateSource = Boolean(
    bot.source_provider ?? bot.template_id ?? bot.template_url ?? bot.import_schema_version ?? bot.import_operation_id
  );

  const rulesStateLine =
    rulesPhase === 'saving' ? (
      <span className="text-sm cfg-faint">Saving…</span>
    ) : rulesDirty || rulesPhase === 'error' ? (
      <span className="text-sm cfg-dirty">
        <span className="inline-block w-2 h-2 rounded-full cfg-dot-amber mr-1" />
        Unsaved changes
      </span>
    ) : rulesPhase === 'confirmed' ? (
      <span className="text-sm cfg-faint">Saved {formatClock(rulesConfirmedAt)}</span>
    ) : (
      <span className="text-sm cfg-faint">Saved</span>
    );

  const skillStateLine =
    skillPhase === 'saving' ? (
      <span className="text-sm cfg-faint">Saving…</span>
    ) : skillDirty || skillPhase === 'error' ? (
      <span className="text-sm cfg-dirty">
        <span className="inline-block w-2 h-2 rounded-full cfg-dot-amber mr-1" />
        Unsaved changes
      </span>
    ) : skillPhase === 'confirmed' ? (
      <span className="text-sm cfg-faint">Saved {formatClock(skillConfirmedAt)}</span>
    ) : (
      <span className="text-sm cfg-faint">Saved</span>
    );

  return (
    <div className="cfg-page">
      <div className="max-w-6xl mx-auto">
        <Link href="/" onClick={confirmLeave} className="cfg-link text-sm">
          ← Back to chat
        </Link>

        <header className="mt-3 mb-6 flex flex-wrap items-center gap-4">
          {bot.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bot.avatar} alt="" className="w-12 h-12 cfg-avatar" />
          ) : null}
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{bot.name}</h1>
            <p className="text-sm cfg-faint truncate">{bot.title || ' '}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-sm cfg-muted">
              Current config hash:{' '}
              <code className="cfg-code" title={currentHash}>
                {currentHash.slice(0, 8)}
              </code>{' '}
              <button
                onClick={() => flashCopied('header', currentHash)}
                className="cfg-link text-sm"
              >
                {copiedKey === 'header' ? 'Copied' : 'Copy'}
              </button>
            </p>
            <p className="text-sm mt-1">
              {anyDirty ? (
                <span className="cfg-dirty">
                  <span className="inline-block w-2 h-2 rounded-full cfg-dot-amber mr-1" />
                  Unsaved changes
                </span>
              ) : (
                <span className="cfg-faint">● Saved</span>
              )}
            </p>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-5 items-start">
          <div className="lg:col-span-3 space-y-6">
            <section className="cfg-card">
              <div className="flex items-center justify-between mb-3">
                <h2 className="cfg-title">Skills</h2>
                {skillStateLine}
              </div>
              {skill.status === 'unsupported' ? (
                <>
                  <p className="text-sm cfg-muted mb-3">Unsupported name</p>
                  <p className="text-sm cfg-muted">
                    Skill files need a bot name matching /^[A-Za-z0-9_-]+$/ — this name cannot map to a skill path.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm cfg-muted mb-3">
                    {skill.path} · {skill.status === 'present' ? 'Present' : 'Not present'}
                  </p>
                  {!skillEditing ? (
                    skill.status === 'present' ? (
                      <>
                        <pre className="text-sm cfg-pre max-h-64 overflow-y-auto">
                          {skill.content}
                        </pre>
                        <button
                          onClick={startSkillEdit}
                          className="mt-3 cfg-btn-ghost text-sm w-full sm:w-auto"
                        >
                          Edit
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-sm cfg-muted">
                          No skill file yet. Create SKILL.md to give this bot standing instructions.
                        </p>
                        <button
                          onClick={startSkillEdit}
                          className="mt-3 cfg-btn-ghost text-sm w-full sm:w-auto"
                        >
                          Create
                        </button>
                      </>
                    )
                  ) : (
                    <>
                      <textarea
                        value={skillText}
                        onChange={e => setSkillText(e.target.value)}
                        rows={8}
                        className="cfg-input text-sm"
                      />
                      {skillPhase === 'error' && (
                        <p className="mt-2 text-sm cfg-error">
                          Couldn&apos;t save: {skillError}.{' '}
                          <button onClick={saveSkill} className="underline hover:no-underline">
                            Retry
                          </button>
                        </p>
                      )}
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={saveSkill}
                          disabled={!skillDirty || skillPhase === 'saving'}
                          className="flex-1 sm:flex-none cfg-btn-primary text-sm"
                        >
                          {skillPhase === 'saving' ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={discardSkill}
                          disabled={skillPhase === 'saving'}
                          className="flex-1 sm:flex-none cfg-btn-ghost text-sm"
                        >
                          Discard
                        </button>
                      </div>
                    </>
                  )}
                  <p className="mt-3 text-xs cfg-faint">Appended verbatim as a system message at launch.</p>
                </>
              )}
            </section>

            <section className="cfg-card">
              <div className="flex items-center justify-between mb-3">
                <h2 className="cfg-title">Rules</h2>
                {rulesStateLine}
              </div>
              <textarea
                value={rulesText ?? ''}
                onChange={e => setRulesText(e.target.value)}
                rows={8}
                className="cfg-input cfg-input-sans text-sm"
              />
              <p className="mt-2 text-xs cfg-faint">
                Sent verbatim as the standing-rules system message on every turn. This beats the user&apos;s request
                for detail or length.
              </p>
              {rulesPhase === 'error' && (
                <p className="mt-2 text-sm cfg-error">
                  Couldn&apos;t save: {rulesError}.{' '}
                  <button onClick={saveRules} className="underline hover:no-underline">
                    Retry
                  </button>
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={saveRules}
                  disabled={!rulesDirty || rulesPhase === 'saving'}
                  className="flex-1 sm:flex-none cfg-btn-primary text-sm"
                >
                  {rulesPhase === 'saving' ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={discardRules}
                  disabled={!rulesDirty || rulesPhase === 'saving'}
                  className="flex-1 sm:flex-none cfg-btn-ghost text-sm"
                >
                  Discard
                </button>
              </div>
            </section>

            <section className="cfg-card">
              <h2 className="cfg-title mb-3">Template source</h2>
              {!hasTemplateSource && (
                <p className="text-sm cfg-muted mb-3">Created manually in Botmancers — no template source.</p>
              )}
              <dl className="text-sm">
                <div className="flex justify-between gap-4 py-1 border-t cfg-line">
                  <dt className="cfg-faint">Source provider</dt>
                  <dd className="text-right">{bot.source_provider ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4 py-1 border-t cfg-line">
                  <dt className="cfg-faint">Template ID</dt>
                  <dd className="text-right">{bot.template_id ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4 py-1 border-t cfg-line">
                  <dt className="cfg-faint">Template URL</dt>
                  <dd className="text-right break-all">
                    {bot.template_url ? (
                      looksLikeUrl(bot.template_url) ? (
                        <a href={bot.template_url} className="cfg-link">
                          {bot.template_url}
                        </a>
                      ) : (
                        bot.template_url
                      )
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 py-1 border-t cfg-line">
                  <dt className="cfg-faint">Schema version</dt>
                  <dd className="text-right">{bot.import_schema_version ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4 py-1 border-t cfg-line">
                  <dt className="cfg-faint">Operation ID</dt>
                  <dd className="text-right break-all">{bot.import_operation_id ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4 py-1 border-y cfg-line">
                  <dt className="cfg-faint">Imported at</dt>
                  <dd className="text-right">
                    {bot.import_timestamp ? formatDateTime(bot.import_timestamp) : '—'}
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          <div className="lg:col-span-2">
            <section className="cfg-card">
              <h2 className="cfg-title mb-3">Launch snapshots</h2>
              {snapshots.length === 0 ? (
                <p className="text-sm cfg-muted">No launches recorded yet.</p>
              ) : (
                <ul className="space-y-3">
                  {snapshots.map(row => {
                    const matches = row.hash === currentHash;
                    const open = Boolean(expanded[row.id]);
                    return (
                      <li key={row.id} className="cfg-row">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm">
                            {formatDateTime(row.created_at)} · {row.id.slice(0, 4)}
                            {row.transport ? ` · ${row.transport}` : null}
                          </p>
                          <button
                            onClick={() => setExpanded(prev => ({ ...prev, [row.id]: !prev[row.id] }))}
                            aria-label={open ? 'Collapse snapshot detail' : 'Expand snapshot detail'}
                            className="cfg-chevron px-1"
                          >
                            {open ? '▾' : '▸'}
                          </button>
                        </div>
                        <p className="mt-1 text-sm">
                          <code className="cfg-code">{row.hash.slice(0, 12)}</code>{' '}
                          <button
                            onClick={() => flashCopied(row.id, row.hash)}
                            className="cfg-link text-sm"
                          >
                            {copiedKey === row.id ? 'Copied' : 'Copy'}
                          </button>
                        </p>
                        <p className="mt-1 text-sm">
                          {matches ? (
                            <span className="cfg-ok">● Matches current config</span>
                          ) : (
                            <span className="cfg-faint">○ Config changed since</span>
                          )}
                        </p>
                        {open && (
                          <div className="mt-3 pt-3 border-t cfg-line text-sm">
                            <p className="cfg-muted break-all">
                              <span className="font-medium">Launch ID:</span> {row.id}
                            </p>
                            <p className="mt-1 cfg-muted break-all">
                              <span className="font-medium">Hash:</span>{' '}
                              <code className="cfg-code">{row.hash}</code>
                            </p>
                            <dl className="mt-2">
                              {SNAPSHOT_FIELDS.map(field => {
                                const value = row.snapshot[field.key];
                                return (
                                  <div key={field.key} className="py-1 border-t cfg-line">
                                    <dt className="cfg-faint">{field.label}</dt>
                                    <dd className="whitespace-pre-wrap break-words">
                                      {value === null || value === undefined ? (
                                        <span className="cfg-faint">null</span>
                                      ) : Array.isArray(value) ? (
                                        value.length === 0 ? (
                                          <span className="cfg-faint">(none)</span>
                                        ) : (
                                          <span className="block max-h-32 overflow-y-auto">
                                            {value.map(fact => `- ${fact}`).join('\n')}
                                          </span>
                                        )
                                      ) : typeof value === 'boolean' ? (
                                        String(value)
                                      ) : value === '' ? (
                                        <span className="cfg-faint">(empty)</span>
                                      ) : (
                                        <span className="block max-h-32 overflow-y-auto">{value}</span>
                                      )}
                                    </dd>
                                  </div>
                                );
                              })}
                            </dl>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
