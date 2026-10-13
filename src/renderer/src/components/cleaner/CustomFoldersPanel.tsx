import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Plus, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { formatBytes } from '@/lib/utils'
import type { CustomFolder, CustomFolderScan } from '@shared/custom-folders'

const fieldStyle = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-medium)',
  color: 'var(--text-primary)'
}
const buttonStyle = {
  background: 'var(--bg-subtle-2)',
  border: '1px solid var(--border-medium)',
  color: 'var(--text-primary)'
}

export function CustomFoldersPanel() {
  const { t } = useTranslation('settings')
  const [folders, setFolders] = useState<CustomFolder[]>([])
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [result, setResult] = useState<CustomFolderScan | null>(null)
  const [selected, setSelected] = useState(new Set<string>())
  const [shown, setShown] = useState(50)
  const [busy, setBusy] = useState(true)
  const busyRef = useRef(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [recoveryPaths, setRecoveryPaths] = useState<string[]>([])
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    let active = true
    window.kudu
      .customFoldersList()
      .then((value) => {
        if (active) setFolders(value)
      })
      .catch((error) => {
        if (active) setError(String(error.message || error))
      })
      .finally(() => {
        if (active) {
          busyRef.current = false
          setBusy(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const resetPreview = () => {
    setResult(null)
    setSelected(new Set())
    setShown(50)
  }
  const selectedFiles = result?.files.filter((file) => selected.has(file.id)) ?? []
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0)

  return (
    <div className="space-y-4 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
      <p>{t('customFoldersDescription')}</p>
      <p
        className="rounded-xl p-3 text-xs leading-relaxed"
        style={{ background: 'var(--accent-muted-bg)' }}
      >
        {t('customFoldersWarning')}
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            setFolders(await window.kudu.customFoldersAdd(name, path))
            setName('')
            setPath('')
            resetPreview()
          })
        }}
      >
        <label className="block">
          <span className="mb-1 block">{t('customFolderName')}</span>
          <input
            required
            maxLength={100}
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('customFolderNamePlaceholder')}
            className="w-full rounded-lg px-3 py-2"
            style={fieldStyle}
          />
        </label>
        <label className="block">
          <span className="mb-1 block">{t('customFolderPath')}</span>
          <input
            required
            disabled={busy}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('customFolderPathPlaceholder')}
            className="w-full rounded-lg px-3 py-2"
            style={fieldStyle}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className="flex items-center gap-2 rounded-lg px-3 py-2 disabled:opacity-50"
            style={buttonStyle}
            onClick={() =>
              void run(async () => {
                const picked = await window.kudu.customFoldersPick()
                if (picked) setPath(picked)
              })
            }
          >
            <FolderOpen className="h-4 w-4" />
            {t('customFolderBrowse')}
          </button>
          <button
            disabled={busy || !name.trim() || !path.trim()}
            className="flex items-center gap-2 rounded-lg px-3 py-2 disabled:opacity-50"
            style={buttonStyle}
          >
            <Plus className="h-4 w-4" />
            {t('customFolderAdd')}
          </button>
        </div>
      </form>
      {folders.length === 0 && <p className="text-xs">{t('customFoldersEmpty')}</p>}
      <ul className="space-y-2">
        {folders.map((folder) => (
          <li
            key={folder.id}
            className="rounded-xl border p-3"
            style={{ borderColor: 'var(--border-default)' }}
          >
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              {folder.name}
            </p>
            <p className="mt-1 break-all text-xs select-text">{folder.path}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                disabled={busy}
                className="rounded-lg px-3 py-2 disabled:opacity-50"
                style={buttonStyle}
                onClick={() =>
                  void run(async () => {
                    resetPreview()
                    setResult(await window.kudu.customFoldersScan(folder.id))
                  })
                }
              >
                {t('customFolderScan')}
              </button>
              <button
                disabled={busy}
                className="rounded-lg px-3 py-2 disabled:opacity-50"
                style={buttonStyle}
                onClick={() =>
                  void run(async () => {
                    setFolders(await window.kudu.customFoldersRemove(folder.id))
                    resetPreview()
                  })
                }
                aria-label={t('customFolderRemoveNamed', { name: folder.name })}
              >
                {t('customFolderRemove')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {busy && <p role="status">{t('customFolderWorking')}</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {recoveryPaths.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border p-3"
          style={{ borderColor: 'var(--border-medium)' }}
        >
          <p>{t('customFolderRecovery')}</p>
          {recoveryPaths.map((path) => (
            <p key={path} className="mt-1 break-all text-xs select-text">
              {path}
            </p>
          ))}
        </div>
      )}
      {result && (
        <div className="space-y-3 border-t pt-4" style={{ borderColor: 'var(--border-default)' }}>
          <h4 className="font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('customFolderPreview', { name: result.folder.name })}
          </h4>
          <p className="text-xs">
            {t('customFolderScanSummary', {
              count: result.files.length,
              size: formatBytes(result.files.reduce((sum, file) => sum + file.size, 0)),
              skipped: result.skipped
            })}
          </p>
          {result.limited && <p className="text-xs text-amber-500">{t('customFolderLimited')}</p>}
          <p className="text-xs">
            {t('customFolderSelection', {
              count: selectedFiles.length,
              size: formatBytes(selectedBytes)
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy || !result.files.length}
              className="rounded-lg px-3 py-2 disabled:opacity-50"
              style={buttonStyle}
              onClick={() =>
                setSelected(new Set(result.files.slice(0, shown).map((file) => file.id)))
              }
            >
              {t('customFolderSelectShown')}
            </button>
            <button
              disabled={busy || !selected.size}
              className="rounded-lg px-3 py-2 disabled:opacity-50"
              style={buttonStyle}
              onClick={() => setSelected(new Set())}
            >
              {t('customFolderClear')}
            </button>
            <button
              disabled={busy || !selected.size}
              className="flex items-center gap-2 rounded-lg px-3 py-2 disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
              onClick={() => setConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t('customFolderTrash')}
            </button>
          </div>
          <div
            className="max-h-80 space-y-1 overflow-auto rounded-xl border p-2"
            style={{ borderColor: 'var(--border-default)' }}
          >
            {result.files.length === 0 && <p className="p-2 text-xs">{t('customFolderNoFiles')}</p>}
            {result.files.slice(0, shown).map((file) => (
              <label key={file.id} className="flex cursor-pointer items-start gap-3 rounded-lg p-2">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.has(file.id)}
                  onChange={() =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (next.has(file.id)) next.delete(file.id)
                      else next.add(file.id)
                      return next
                    })
                  }
                />
                <span className="min-w-0 flex-1 break-all select-text">
                  {file.path}
                  <span className="mt-1 block text-xs" style={{ color: 'var(--text-muted)' }}>
                    {formatBytes(file.size)} · {new Date(file.modified).toLocaleString()}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {result.files.length > shown && (
            <button
              disabled={busy}
              className="rounded-lg px-3 py-2"
              style={buttonStyle}
              onClick={() => setShown((value) => value + 50)}
            >
              {t('customFolderShowMore')}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('customFolderConfirmTitle')}
        description={t('customFolderConfirmDescription', {
          count: selectedFiles.length,
          size: formatBytes(selectedBytes)
        })}
        details={result?.folder.path}
        confirmLabel={t('customFolderTrash')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          if (!result) return
          void run(async () => {
            const moved = await window.kudu.customFoldersTrash(result.scanId, [...selected])
            const trashed = new Set(moved.trashedIds)
            setResult((previous) =>
              previous
                ? { ...previous, files: previous.files.filter((file) => !trashed.has(file.id)) }
                : null
            )
            setSelected(new Set())
            setRecoveryPaths((previous) => [
              ...new Set([...previous, ...(moved.recoveryPaths ?? [])])
            ])
            setNotice(
              t('customFolderTrashSummary', {
                count: moved.trashedIds.length,
                skipped: moved.skippedIds.length
              })
            )
          })
        }}
      />
    </div>
  )
}
