import { describe, it, expect } from 'vitest'

// ─── registeredTaskMatches (replica of src/main/index.ts) ────────
// index.ts boots the Electron app on import, so the pure helper is replicated
// here — same convention as malware-scanner.test.ts.
//
// Why this check exists: the task XML is written to %LOCALAPPDATA%\Temp, which
// any process running as this user can write, including a non-elevated one.
// schtasks reads it back elevated and the task carries RunLevel
// HighestAvailable, so a swap between our write and its read would register an
// attacker's definition as a logon-triggered admin task. After registering we
// ask Task Scheduler what it actually stored and compare it to what we sent.

const TASK_EXEC_CHILD_TAGS = new Set(['Command', 'Arguments', 'WorkingDirectory'])

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function registeredTaskMatches(taskXml: string, exePath: string, expectedArgs: string): boolean {
  const actionsBlock = taskXml.match(/<Actions\b[^>]*>([\s\S]*?)<\/Actions>/i)
  if (!actionsBlock) return false
  const actions = actionsBlock[1]

  const actionTags = [...actions.matchAll(/<([A-Za-z][\w.-]*)\b/g)]
    .map((m) => m[1])
    .filter((tag) => !TASK_EXEC_CHILD_TAGS.has(tag))
  if (actionTags.length !== 1 || actionTags[0].toLowerCase() !== 'exec') return false

  const commands = [...actions.matchAll(/<Command>([\s\S]*?)<\/Command>/gi)]
  if (commands.length !== 1) return false
  const command = decodeXmlEntities(commands[0][1].trim().replace(/^"|"$/g, '')).toLowerCase()
  if (command !== exePath.trim().toLowerCase()) return false

  const argMatches = [...actions.matchAll(/<Arguments>([\s\S]*?)<\/Arguments>/gi)]
  if (argMatches.length > 1) return false
  const args = argMatches.length === 1 ? decodeXmlEntities(argMatches[0][1].trim()) : ''
  return args === expectedArgs.trim()
}

const EXE = 'C:\\Program Files\\Kudu\\Kudu.exe'
const ARGS = '--startup'

/** Wrap raw action XML in the surrounding task document. */
function withActions(actionsInner: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2">',
    '  <Actions Context="Author">',
    actionsInner,
    '  </Actions>',
    '</Task>',
  ].join('\r\n')
}

function execAction(command: string, args: string | null = ARGS): string {
  const argLine = args === null ? '' : `<Arguments>${args}</Arguments>`
  return `    <Exec><Command>${command}</Command>${argLine}</Exec>`
}

describe('registeredTaskMatches', () => {
  it('accepts the task we meant to register', () => {
    expect(registeredTaskMatches(withActions(execAction(EXE)), EXE, ARGS)).toBe(true)
  })

  it('accepts a command Task Scheduler echoed back quoted', () => {
    expect(registeredTaskMatches(withActions(execAction(`"${EXE}"`)), EXE, ARGS)).toBe(true)
  })

  it('accepts a path whose ampersand came back XML-escaped', () => {
    const exe = 'C:\\Tools\\R&D\\Kudu.exe'
    expect(registeredTaskMatches(withActions(execAction('C:\\Tools\\R&amp;D\\Kudu.exe')), exe, ARGS)).toBe(true)
  })

  it('ignores case, which Windows paths do', () => {
    expect(registeredTaskMatches(withActions(execAction(EXE.toUpperCase())), EXE, ARGS)).toBe(true)
  })

  it('rejects a substituted command', () => {
    expect(registeredTaskMatches(withActions(execAction('C:\\attacker\\backdoor.exe')), EXE, ARGS)).toBe(false)
  })

  it('rejects a command that merely starts with our path', () => {
    expect(registeredTaskMatches(withActions(execAction(EXE + '.evil.exe')), EXE, ARGS)).toBe(false)
  })

  // Matching the command alone is not enough — Task Scheduler runs the whole
  // action, and the arguments decide what our own binary does.
  it('rejects altered arguments that would turn our binary into a debug server', () => {
    const xml = withActions(execAction(EXE, '--startup --inspect-brk=0.0.0.0:9229'))
    expect(registeredTaskMatches(xml, EXE, ARGS)).toBe(false)
  })

  it('rejects arguments that were stripped entirely', () => {
    expect(registeredTaskMatches(withActions(execAction(EXE, null)), EXE, ARGS)).toBe(false)
  })

  it('rejects a second Arguments element smuggled into the action', () => {
    const xml = withActions(
      `    <Exec><Command>${EXE}</Command><Arguments>${ARGS}</Arguments><Arguments>--inspect</Arguments></Exec>`
    )
    expect(registeredTaskMatches(xml, EXE, ARGS)).toBe(false)
  })

  // A definition can run things without naming a command at all.
  it('rejects a ComHandler action added alongside ours', () => {
    const xml = withActions(
      execAction(EXE) + '\r\n    <ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>'
    )
    expect(registeredTaskMatches(xml, EXE, ARGS)).toBe(false)
  })

  it('rejects a lone ComHandler action', () => {
    const xml = withActions('    <ComHandler><ClassId>{11111111-2222-3333-4444-555555555555}</ClassId></ComHandler>')
    expect(registeredTaskMatches(xml, EXE, ARGS)).toBe(false)
  })

  it('rejects a payload appended after a legitimate entry', () => {
    const xml = withActions(execAction(EXE) + '\r\n' + execAction('C:\\attacker\\backdoor.exe'))
    expect(registeredTaskMatches(xml, EXE, ARGS)).toBe(false)
  })

  it('rejects a payload placed before the legitimate entry', () => {
    const xml = withActions(execAction('C:\\attacker\\backdoor.exe') + '\r\n' + execAction(EXE))
    expect(registeredTaskMatches(xml, EXE, ARGS)).toBe(false)
  })

  it('rejects a definition with no actions block', () => {
    expect(registeredTaskMatches('<Task version="1.2" />', EXE, ARGS)).toBe(false)
  })

  it('rejects an empty actions block', () => {
    expect(registeredTaskMatches(withActions(''), EXE, ARGS)).toBe(false)
  })

  // A query that returns nothing must not read as a pass — the caller treats a
  // failed or empty verification the same as a mismatch and deletes the task.
  it('rejects empty output', () => {
    expect(registeredTaskMatches('', EXE, ARGS)).toBe(false)
  })

  it('rejects unparseable output', () => {
    expect(registeredTaskMatches('ERROR: The system cannot find the file specified.', EXE, ARGS)).toBe(false)
  })
})
